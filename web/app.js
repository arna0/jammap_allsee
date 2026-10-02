// JamMap dashboard. Polls the relayer, draws the map, and talks to the paid API
// (x402) for route checks and point lookups.

const API = location.origin;
const POLL_MS = 2000;
const KIND_LABEL = { 1: 'GPS jamming', 2: 'GPS spoofing', 3: 'Jamming and spoofing' };

const $ = (id) => document.getElementById(id);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid != null) el.append(kid instanceof Node ? kid : String(kid));
  return el;
};

const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
};
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const short = (s) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const fmtCoord = (p) => `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
const kindClass = (i) => (!i.confirmed ? 'pend' : i.kinds & 1 ? 'jam' : 'spoof');

// CSS tokens use light-dark(), so resolve them through a probe element.
const probe = document.body.appendChild(h('span', { hidden: true }));
function color(name) {
  probe.style.color = `var(--${name})`;
  return getComputedStyle(probe).color;
}

// ------------------------------------------------------------------ map

const map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([42.33, 69.59], 11);
map.createPane('labels').style.zIndex = 450;
map.getPane('labels').style.pointerEvents = 'none';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
const ATTR = 'Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors';
let tiles = [];
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function setTiles() {
  tiles.forEach((t) => t.remove());
  const shade = darkQuery.matches ? 'Dark' : 'Light';
  tiles = [
    L.tileLayer(`${ESRI}/World_${shade}_Gray_Base/MapServer/tile/{z}/{y}/{x}`, { maxNativeZoom: 16, maxZoom: 18, attribution: ATTR }),
    L.tileLayer(`${ESRI}/World_${shade}_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { maxNativeZoom: 16, maxZoom: 18, pane: 'labels' }),
  ];
  tiles.forEach((t) => t.addTo(map));
}
setTiles();
darkQuery.addEventListener('change', () => {
  setTiles();
  render();
});

const layers = {
  zones: L.layerGroup().addTo(map),
  sensors: L.layerGroup().addTo(map),
  sources: L.layerGroup().addTo(map),
  route: L.layerGroup().addTo(map),
};

// ------------------------------------------------------------------ state

let state = null;
let selected = null; // incident id
let fitted = false;
let seenReports = new Set();
let cluster = 'devnet';
const explorerTx = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;
const explorerAddr = (a) => `https://explorer.solana.com/address/${a}?cluster=${cluster}`;

async function poll() {
  try {
    state = await fetch(`${API}/v1/map?preview=1`).then((r) => r.json());
    render();
  } catch (e) {
    console.warn('poll failed', e);
  }
}

function render() {
  if (!state) return;
  const s = state;
  cluster = s.chain?.cluster || cluster;
  $('sensorsOnline').textContent = s.stats.activeDevices;
  const net = $('network');
  if (s.chain) {
    net.textContent = `Solana ${s.chain.cluster}`;
    net.href = explorerAddr(s.chain.programId);
    net.title = `Program ${s.chain.programId}`;
  } else {
    net.textContent = 'Local mode, no chain';
    net.removeAttribute('href');
  }
  $('demoNote').hidden = !s.demo;
  document.querySelectorAll('.price').forEach((el) => {
    if (el.textContent.startsWith('$')) el.textContent = `$${s.price}`;
  });

  const kpi = {
    reports: s.stats.reports,
    confirmed: s.stats.confirmed,
    unconfirmed: s.stats.incidents - s.stats.confirmed,
    onchainTxs: s.stats.onchainTxs,
  };
  for (const dd of document.querySelectorAll('.kpis dd')) dd.textContent = kpi[dd.dataset.k];

  drawMap();
  drawIncidents();
  drawFeed();
  if (selected) drawDetail();
}

function drawMap() {
  const s = state;
  const c = { jam: color('jam'), spoof: color('spoof'), pend: color('warn'), sensor: color('text') };
  layers.zones.clearLayers();
  layers.sensors.clearLayers();
  layers.sources.clearLayers();

  for (const i of s.incidents) {
    const k = kindClass(i);
    const z = i.zone;
    const isSel = i.id === selected;
    L.rectangle(
      [[z.south, z.west], [z.north, z.east]],
      { color: c[k], weight: isSel ? 2.5 : 1.5, dashArray: i.confirmed ? null : '5 5', fillColor: c[k], fillOpacity: i.confirmed ? 0.12 : 0.04 }
    )
      .on('click', () => openIncident(i.id))
      .addTo(layers.zones);

    if (i.source && (i.confirmed || isSel)) {
      const col = i.kinds & 1 ? c.jam : c.spoof;
      L.circle([i.source.lat, i.source.lon], { radius: i.source.radiusKm * 1000, color: col, weight: 1, dashArray: '2 4', fill: false, interactive: false }).addTo(layers.sources);
      L.marker([i.source.lat, i.source.lon], {
        icon: L.divIcon({ className: '', html: `<div class="src-pin ${i.kinds & 1 ? '' : 'spoof'}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }),
        title: 'Estimated source',
      })
        .on('click', () => openIncident(i.id))
        .addTo(layers.sources);
    }
    if (isSel) {
      for (const r of i.reports || []) {
        L.circleMarker([r.lat, r.lon], { radius: 4.5, color: color('surface'), weight: 1.5, fillColor: r.kind === 1 ? c.jam : c.spoof, fillOpacity: 1 }).addTo(layers.sources);
      }
    }
  }
  for (const d of s.devices) {
    L.circleMarker([d.lat, d.lon], { radius: 3, stroke: false, fillColor: c.sensor, fillOpacity: 0.45, interactive: false }).addTo(layers.sensors);
  }
  if (!fitted && (s.devices.length || s.incidents.length)) {
    fitAll();
    fitted = true;
  }
}

function fitAll() {
  map.invalidateSize();
  const pts = [];
  for (const d of state?.devices || []) pts.push([d.lat, d.lon]);
  for (const i of state?.incidents || []) pts.push([i.zone.south, i.zone.west], [i.zone.north, i.zone.east]);
  if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 13 });
}

// ------------------------------------------------------------------ live panel

function drawIncidents() {
  const list = [...state.incidents].sort((a, b) => b.confirmed - a.confirmed || b.lastSeen - a.lastSeen);
  $('incidents').replaceChildren(
    ...(list.length
      ? list.map((i) => {
          const need = Math.max(0, i.quorum - i.reporters);
          return h('li', {},
            h('button', { class: `inc ${kindClass(i)}`, type: 'button', onclick: () => openIncident(i.id) },
              h('span', { class: 'rail', 'aria-hidden': 'true' }),
              h('span', {},
                h('strong', {}, KIND_LABEL[i.kinds]),
                h('small', {}, `${i.reporters} sensor${i.reporters === 1 ? '' : 's'} · first seen ${ago(i.firstSeen)}`)
              ),
              h('span', { class: `status ${i.confirmed ? 'ok' : ''}` }, i.confirmed ? 'Confirmed' : `Needs ${need} more`)
            )
          );
        })
      : [h('li', { class: 'empty' }, 'No interference reported in the last 24 hours.')])
  );
}

function drawFeed() {
  const fresh = new Set();
  $('feed').replaceChildren(
    ...state.feed.slice(0, 25).map((r) => {
      fresh.add(r.id);
      const rec = r.chain?.tx
        ? h('a', { href: explorerTx(r.chain.tx), target: '_blank', rel: 'noopener', title: r.chain.tx }, short(r.chain.tx))
        : r.chain?.status === 'pending' ? 'sending'
        : r.chain?.status === 'failed' ? h('span', { title: r.chain.error }, 'failed')
        : 'local';
      return h('tr', { class: seenReports.size && !seenReports.has(r.id) ? 'fresh' : '' },
        h('td', {}, clock(r.ts)),
        h('td', { class: `k${r.kind}` }, r.kind === 1 ? 'Jamming' : 'Spoofing'),
        h('td', {}, r.device),
        h('td', {}, rec)
      );
    })
  );
  seenReports = fresh;
}

// ------------------------------------------------------------------ incident detail

function openIncident(id) {
  selectTab('live');
  selected = id;
  $('listView').hidden = true;
  $('detailView').hidden = false;
  const i = state.incidents.find((x) => x.id === id);
  if (i) map.fitBounds([[i.zone.south, i.zone.west], [i.zone.north, i.zone.east]], { padding: [60, 60], maxZoom: 13 });
  drawDetail();
  drawMap();
}

function closeIncident() {
  selected = null;
  $('detailView').hidden = true;
  $('listView').hidden = false;
  drawMap();
}

function drawDetail() {
  const i = state.incidents.find((x) => x.id === selected);
  if (!i) return closeIncident();
  const facts = [
    ['First seen', `${clock(i.firstSeen)} · ${ago(i.firstSeen)}`],
    ['Last seen', `${clock(i.lastSeen)} · ${ago(i.lastSeen)}`],
    ['Active', i.windows > 1 ? `${i.windows} windows of 5 min` : 'One 5-min window'],
    ['Zone', i.cellId],
    ['Sensors', `${i.reporters} (quorum ${i.quorum})`],
    ['Max severity', `${i.maxSeverity} of 3`],
    ['Estimated source', i.source ? fmtCoord(i.source) : 'Needs 2+ sensors'],
    ['Accuracy', i.source ? `±${i.source.radiusKm} km` : '—'],
  ];

  const parts = [
    h('div', { class: 'detail-head' },
      h('h2', {}, KIND_LABEL[i.kinds]),
      h('span', { class: `chip ${i.confirmed ? 'ok' : 'pend'}` }, i.confirmed ? 'Confirmed' : 'Unconfirmed')
    ),
    h('dl', { class: 'facts' }, ...facts.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))),
  ];

  if (i.reports) {
    parts.push(
      h('h3', { class: 'section' }, 'Evidence'),
      evidenceChart(i.reports),
      h('p', { class: 'caption' },
        'Each point is one sensor. Jamming lowers both signal-to-noise (C/N0) and receiver gain (AGC). ',
        'A phone that is merely blocked loses signal but raises its gain, so it is never counted.'),
      h('h3', { class: 'section' }, 'Sensors'),
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Sensor'), h('th', {}, 'Δ C/N0'), h('th', {}, 'Δ AGC'), h('th', {}, 'From source'), h('th', {}, 'Record'))),
        h('tbody', {},
          ...i.reports.map((r) =>
            h('tr', {},
              h('td', { class: 'mono' }, r.sensor),
              h('td', { class: 'num' }, r.dCn0 == null ? '—' : `${r.dCn0 > 0 ? '+' : ''}${r.dCn0.toFixed(1)} dB`),
              h('td', { class: 'num' }, r.dAgc == null ? '—' : `${r.dAgc > 0 ? '+' : ''}${r.dAgc.toFixed(1)} dB`),
              h('td', { class: 'num' }, r.distanceKm == null ? '—' : `${r.distanceKm} km`),
              h('td', { class: 'mono' }, r.tx ? h('a', { href: explorerTx(r.tx), target: '_blank', rel: 'noopener' }, short(r.tx)) : 'local')
            )
          )
        )
      )
    );
  } else {
    parts.push(h('p', { class: 'note' }, 'Per-sensor measurements and the source estimate are available through the paid API.'));
  }

  parts.push(h('h3', { class: 'section' }, 'On-chain record'));
  if (state.chain) {
    parts.push(
      h('div', { class: 'proof' },
        h('p', {}, `Zone ${i.cellId}, window ${i.window}. `, i.txs.length ? `${i.txs.length} report transactions:` : 'No transactions confirmed yet.'),
        h('ul', {}, ...i.txs.slice(-6).map((t) => h('li', {}, h('a', { href: explorerTx(t), target: '_blank', rel: 'noopener' }, h('code', {}, t)))))
      )
    );
  } else {
    parts.push(h('p', { class: 'note' }, 'This relayer runs without a Solana program, so reports are kept locally. Set JAMMAP_PROGRAM_ID to write them on-chain.'));
  }
  $('detail').replaceChildren(...parts);
}

function evidenceChart(reports) {
  const W = 384, H = 236, L0 = 40, R0 = 10, T0 = 10, B0 = 30;
  const X = [-32, 16], Y = [-10, 8];
  const sx = (v) => L0 + ((v - X[0]) / (X[1] - X[0])) * (W - L0 - R0);
  const sy = (v) => T0 + ((Y[1] - v) / (Y[1] - Y[0])) * (H - T0 - B0);
  const rect = (x0, x1, y0, y1, cls) => svg('rect', { x: sx(x0), y: sy(y1), width: sx(x1) - sx(x0), height: sy(y0) - sy(y1), class: cls });

  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Change in C/N0 versus change in AGC for each sensor' });
  g.append(
    rect(-32, -8, -10, -2, 'zone-jam'),
    rect(5, 16, -10, -2, 'zone-spoof'),
    rect(-32, -8, 1, 8, 'zone-obs'),
    svg('text', { x: sx(-31), y: sy(-9.2), class: 'lbl-jam' }, 'Jamming'),
    svg('text', { x: sx(5.6), y: sy(-9.2), class: 'lbl-spoof' }, 'Spoofing'),
    svg('text', { x: sx(-31), y: sy(7), class: 'lbl-obs' }, 'Blocked (ignored)')
  );
  for (const v of [-30, -20, -10, 0, 10]) {
    g.append(svg('line', { x1: sx(v), x2: sx(v), y1: T0, y2: H - B0, class: v === 0 ? 'axis' : 'grid' }));
    g.append(svg('text', { x: sx(v), y: H - B0 + 14, 'text-anchor': 'middle' }, v > 0 ? `+${v}` : v));
  }
  for (const v of [-8, -4, 0, 4, 8]) {
    g.append(svg('line', { x1: L0, x2: W - R0, y1: sy(v), y2: sy(v), class: v === 0 ? 'axis' : 'grid' }));
    g.append(svg('text', { x: L0 - 6, y: sy(v) + 3.5, 'text-anchor': 'end' }, v > 0 ? `+${v}` : v));
  }
  g.append(
    svg('text', { x: (L0 + W - R0) / 2, y: H - 4, 'text-anchor': 'middle' }, 'Δ C/N0, dB'),
    svg('text', { x: 11, y: (T0 + H - B0) / 2, transform: `rotate(-90 11 ${(T0 + H - B0) / 2})`, 'text-anchor': 'middle' }, 'Δ AGC, dB')
  );
  for (const r of reports) {
    if (r.dCn0 == null || r.dAgc == null) continue;
    const cx = sx(Math.max(X[0], Math.min(X[1], r.dCn0)));
    const cy = sy(Math.max(Y[0], Math.min(Y[1], r.dAgc)));
    g.append(svg('circle', { cx, cy, r: 4.5, fill: color(r.kind === 1 ? 'jam' : 'spoof') }, svg('title', {}, `${r.sensor}: ΔC/N0 ${r.dCn0} dB, ΔAGC ${r.dAgc} dB`)));
  }
  return g;
}

// ------------------------------------------------------------------ x402 client

/** GET a paid endpoint. In demo mode the server accepts a simulated payment. */
async function paidGet(path) {
  const first = await fetch(API + path);
  if (first.status !== 402) return { status: first.status, body: await first.json() };
  const offer = (await first.json()).accepts[0];
  if (!offer.extra?.demoAccepted) return { status: 402, offer };
  const header = btoa(JSON.stringify({ x402Version: 1, scheme: 'exact', network: offer.network, payload: { demo: true } }));
  const paid = await fetch(API + path, { headers: { 'X-PAYMENT': header } });
  return { status: paid.status, body: await paid.json(), offer };
}

function walletNeeded(offer) {
  return h('p', { class: 'note' },
    `This request costs ${offer.extra.priceUsd} USDC on ${offer.network}. Browser wallets are not wired up yet; `,
    'use ', h('code', {}, 'npm run buy'), ' from the server folder to pay from a devnet keypair.');
}

function riskBlock(risk, extra) {
  return h('div', { class: `level ${risk.level}` }, h('b', {}, `${risk.level[0].toUpperCase()}${risk.level.slice(1)} risk`), h('span', {}, `score ${risk.score} / 100${extra ? ` · ${extra}` : ''}`));
}
function meter(risk) {
  return h('div', { class: 'meter', style: `color: var(--${risk.level === 'high' ? 'jam' : risk.level === 'elevated' ? 'warn' : 'ok'})` }, h('i', { style: `width:${risk.score}%` }));
}
function receiptLine(body) {
  return h('p', { class: 'receipt' }, body.paid.demo ? 'Paid with a simulated payment (demo mode).' : `Paid: ${body.paid.transaction}`);
}

// ------------------------------------------------------------------ route check

const route = { from: null, to: null };
function setRoutePoint(latlng) {
  const p = { lat: latlng.lat, lon: latlng.lng };
  if (!route.from || route.to) {
    route.from = p;
    route.to = null;
  } else route.to = p;
  drawRoute();
}
function drawRoute() {
  layers.route.clearLayers();
  $('fromOut').textContent = route.from ? fmtCoord(route.from) : '—';
  $('toOut').textContent = route.to ? fmtCoord(route.to) : '—';
  $('routeBtn').disabled = !(route.from && route.to);
  $('routeHint').textContent = !route.from ? 'Click the map to set the start point.' : !route.to ? 'Click the map to set the end point.' : 'Click again to start a new route.';
  const pin = (p, label) =>
    L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', html: `<div class="ab-pin">${label}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false }).addTo(layers.route);
  if (route.from) pin(route.from, 'A');
  if (route.to) {
    pin(route.to, 'B');
    L.polyline([[route.from.lat, route.from.lon], [route.to.lat, route.to.lon]], { color: color('text'), weight: 2.5, dashArray: '1 6', lineCap: 'round', interactive: false }).addTo(layers.route);
  }
}

$('routeBtn').addEventListener('click', async () => {
  const out = $('routeOut');
  const btn = $('routeBtn');
  btn.disabled = true;
  out.replaceChildren(h('p', { class: 'lead' }, 'Requesting…'));
  const corridor = $('corridor').value;
  const q = `/v1/route?from=${route.from.lat.toFixed(5)},${route.from.lon.toFixed(5)}&to=${route.to.lat.toFixed(5)},${route.to.lon.toFixed(5)}&corridor_km=${corridor}`;
  try {
    const r = await paidGet(q);
    if (r.status === 402) return out.replaceChildren(walletNeeded(r.offer));
    if (r.status !== 200) return out.replaceChildren(h('p', { class: 'note' }, r.body.error || `Error ${r.status}`));
    const b = r.body;
    for (const e of b.exposures) {
      L.circle([e.center.lat, e.center.lon], { radius: e.impactKm * 1000, color: color(e.kinds & 1 ? 'jam' : 'spoof'), weight: 1, fillOpacity: 0.08, interactive: false }).addTo(layers.route);
    }
    out.replaceChildren(
      h('div', { class: 'result' },
        riskBlock(b.risk, `${b.routeKm} km route`),
        meter(b.risk),
        b.exposures.length
          ? h('ul', { class: 'exposures' },
              ...b.exposures.map((e) =>
                h('li', {},
                  h('span', { class: 'km' }, `km ${e.atRouteKm}`),
                  h('span', {},
                    h('b', { class: e.kinds & 1 ? 'k1' : 'k2' }, KIND_LABEL[e.kinds]),
                    ` · ${e.confirmed ? `confirmed by ${e.sensors} sensors` : 'unconfirmed'} · about ${e.exposedKm} km of the route affected · seen ${e.lastSeenAgoMin} min ago`
                  )
                )
              )
            )
          : h('p', { class: 'lead' }, 'No interference reported along this route in the last 24 hours.'),
        receiptLine(b)
      )
    );
  } catch (e) {
    out.replaceChildren(h('p', { class: 'note' }, `Request failed: ${e.message}`));
  } finally {
    btn.disabled = false;
  }
});
$('routeClear').addEventListener('click', () => {
  route.from = route.to = null;
  $('routeOut').replaceChildren();
  drawRoute();
});

// ------------------------------------------------------------------ API tab

$('apiTry').addEventListener('click', async () => {
  const out = $('apiOut');
  const c = map.getCenter();
  const q = `/v1/risk?lat=${c.lat.toFixed(4)}&lon=${c.lng.toFixed(4)}&radius_km=25`;
  out.replaceChildren(h('p', { class: 'lead' }, `GET ${q}`));
  const r = await paidGet(q);
  if (r.status === 402) return out.append(walletNeeded(r.offer));
  if (r.status !== 200) return out.append(h('p', { class: 'note' }, r.body.error || `Error ${r.status}`));
  const b = r.body;
  out.append(
    h('div', { class: 'result' },
      riskBlock(b.risk, `${b.incidents.length} incident${b.incidents.length === 1 ? '' : 's'} within 25 km`),
      meter(b.risk),
      h('pre', { class: 'code' }, h('code', {}, JSON.stringify({ risk: b.risk, incidents: b.incidents.slice(0, 2).map(({ reports, zone, ...rest }) => rest) }, null, 2))),
      receiptLine(b)
    )
  );
});

// ------------------------------------------------------------------ tabs

const TABS = ['live', 'route', 'api'];
function selectTab(name, focus = false) {
  for (const t of TABS) {
    const tab = $(`tab-${t}`);
    const on = t === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`view-${t}`).hidden = !on;
    if (on && focus) tab.focus();
  }
  $('routeHint').hidden = name !== 'route';
  map.getContainer().style.cursor = name === 'route' ? 'crosshair' : '';
  if (name !== 'route') layers.route.clearLayers();
  else drawRoute();
}
for (const t of TABS) {
  const tab = $(`tab-${t}`);
  tab.addEventListener('click', () => selectTab(t));
  tab.addEventListener('keydown', (e) => {
    const i = TABS.indexOf(t);
    if (e.key === 'ArrowRight') selectTab(TABS[(i + 1) % TABS.length], true);
    if (e.key === 'ArrowLeft') selectTab(TABS[(i + TABS.length - 1) % TABS.length], true);
  });
}
map.on('click', (e) => {
  if (!$('view-route').hidden) setRoutePoint(e.latlng);
});
$('backBtn').addEventListener('click', closeIncident);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selected) closeIncident();
});

poll();
setInterval(poll, POLL_MS);
