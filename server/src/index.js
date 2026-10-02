// JamMap relayer + data API + dashboard host.
//
//   POST /v1/devices/register   phone binds its device key to a reward wallet
//   POST /v1/reports            phone submits a signed interference report
//   GET  /v1/map                free, zone-level map (what the public dashboard shows)
//   GET  /v1/risk               paid (x402): precise incidents, source estimates, risk score
//   GET  /v1/status             health + chain/payment configuration

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { Store } from './store.js';
import { Chain } from './chain.js';
import { Paywall } from './x402.js';
import { classify, DEFAULTS } from './detector.js';
import { cellId, windowOf, reportMessage, registerMessage, heartbeatMessage, haversineKm, cellCenter, KIND } from './shared.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(here, '../../web');
const env = process.env;
const PORT = Number(env.PORT || 8787);
const DEMO = env.DEMO === '1' || process.argv.includes('--demo');
const ALLOW_TEST = env.ALLOW_TEST_REPORTS === '1' || DEMO;
const MAX_SKEW = 600;

const store = new Store(env.STATE_FILE || path.resolve(here, '../data/state.json'));
const chain = Chain.fromEnv(env);
const paywall = new Paywall({
  mode: env.PAYMENT_MODE || (DEMO ? 'demo' : 'devnet'),
  connection: chain?.connection ?? null,
  payTo: env.PAY_TO || chain?.relayer.publicKey.toBase58() || null,
  price: BigInt(env.PRICE_ATOMIC || 10_000),
});

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
};

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function decodeKey(s) {
  const b = bs58.decode(String(s));
  if (b.length !== 32) throw new Error('bad key length');
  return b;
}

// ------------------------------------------------------------- handlers

async function register(req, res) {
  const b = await readBody(req);
  let deviceKey, owner, sig;
  try {
    deviceKey = decodeKey(b.deviceKey);
    owner = decodeKey(b.owner);
    sig = Buffer.from(b.signature, 'base64');
  } catch {
    return json(res, 400, { error: 'deviceKey, owner (base58) and signature (base64) are required' });
  }
  const message = registerMessage(owner);
  if (!nacl.sign.detached.verify(message, sig, deviceKey)) return json(res, 401, { error: 'bad signature' });

  const dev = store.upsertDevice({ deviceKey: b.deviceKey, owner: b.owner, label: String(b.label || '').slice(0, 40) });
  if (chain) {
    try {
      const r = await chain.registerDevice({ deviceKey: new PublicKey(deviceKey), owner: new PublicKey(owner), message, signature: sig });
      if (r.tx) store.upsertDevice({ deviceKey: b.deviceKey, registerTx: r.tx });
      return json(res, 200, { ok: true, device: dev, tx: r.tx, explorer: r.tx ? chain.explorer(r.tx) : null });
    } catch (e) {
      console.error('[chain] register failed:', e.message);
      return json(res, 502, { error: `on-chain registration failed: ${e.message}` });
    }
  }
  return json(res, 200, { ok: true, device: dev, tx: null });
}

async function report(req, res) {
  const b = await readBody(req);
  const dev = store.devices.get(b.deviceKey);
  if (!dev) return json(res, 403, { error: 'device not registered' });

  const lat = Number(b.lat);
  const lon = Number(b.lon);
  const ts = Number(b.ts);
  const kind = Number(b.kind);
  const severity = Number(b.severity);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json(res, 400, { error: 'bad position' });
  if (![KIND.JAMMING, KIND.SPOOFING].includes(kind) || ![1, 2, 3].includes(severity)) return json(res, 400, { error: 'bad kind/severity' });
  if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW) return json(res, 400, { error: 'timestamp out of range' });
  if (b.test && !ALLOW_TEST) return json(res, 403, { error: 'test reports disabled' });

  const cell = cellId(lat, lon);
  if (b.cellId != null && String(b.cellId) !== cell.toString()) return json(res, 400, { error: 'cellId does not match position' });
  const window = windowOf(ts);

  const message = reportMessage(cell, ts, kind, severity);
  let sig, deviceKey;
  try {
    deviceKey = decodeKey(b.deviceKey);
    sig = Buffer.from(b.signature, 'base64');
  } catch {
    return json(res, 400, { error: 'bad key or signature encoding' });
  }
  if (!nacl.sign.detached.verify(message, sig, deviceKey)) return json(res, 401, { error: 'bad signature' });

  // The phone's measurements must actually support what it claims.
  const f = b.features || {};
  const claimed = kind === KIND.JAMMING ? 'jamming' : 'spoofing';
  const recheck = classify(
    { nSats: Number(f.nSats), dCn0: Number(f.dCn0), dAgc: f.dAgc == null ? null : Number(f.dAgc), spread: f.spread == null ? null : Number(f.spread) },
    DEFAULTS,
    !!f.teleport
  );
  if (recheck.state !== claimed) return json(res, 422, { error: `features classify as "${recheck.state}", not "${claimed}"` });

  if (store.hasVote(b.deviceKey, cell.toString(), window.toString())) return json(res, 409, { error: 'already reported this zone in this window' });

  store.touchDevice(b.deviceKey, { lat, lon });
  const { report: rep, incident, newlyConfirmed } = store.addReport({
    deviceKey: b.deviceKey,
    lat,
    lon,
    cellId: cell.toString(),
    window: window.toString(),
    ts,
    kind,
    severity,
    features: { nSats: f.nSats, dCn0: f.dCn0, dAgc: f.dAgc, spread: f.spread, teleport: !!f.teleport },
    test: !!b.test,
  });
  if (newlyConfirmed) console.log(`[incident] CONFIRMED zone ${cell} window ${window} (${incident.reporters.size} devices)`);

  if (chain) {
    store.setChain(rep.id, { status: 'pending' });
    chain
      .submitReport({ deviceKey: new PublicKey(deviceKey), cell, window, ts, kind, severity, message, signature: sig })
      .then((r) => store.setChain(rep.id, { status: 'confirmed', tx: r.tx, incidentPda: r.incident }))
      .catch((e) => {
        console.error('[chain] submit failed:', e.message);
        store.setChain(rep.id, { status: 'failed', error: e.message.slice(0, 200) });
      });
  }
  return json(res, 202, { ok: true, reportId: rep.id, incident: store.incidentView(incident, { precise: false }) });
}

// Off-chain liveness ping so the map can show coverage. Signed to stop others moving your dot.
async function heartbeat(req, res) {
  const b = await readBody(req);
  if (!store.devices.has(b.deviceKey)) return json(res, 403, { error: 'device not registered' });
  const ts = Number(b.ts);
  if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW) return json(res, 400, { error: 'timestamp out of range' });
  try {
    if (!nacl.sign.detached.verify(heartbeatMessage(ts), Buffer.from(b.signature, 'base64'), decodeKey(b.deviceKey)))
      return json(res, 401, { error: 'bad signature' });
  } catch {
    return json(res, 400, { error: 'bad key or signature encoding' });
  }
  const lat = Number(b.lat);
  const lon = Number(b.lon);
  store.touchDevice(b.deviceKey, Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null);
  json(res, 200, { ok: true });
}

function recentIncidents(hours = 24) {
  return store.events(Date.now() / 1000 - hours * 3600);
}

function map(req, res, url) {
  const precise = DEMO && url.searchParams.get('preview') === '1';
  const now = Date.now();
  const devices = [...store.devices.values()];
  const active = devices.filter((d) => d.lastSeen && now - d.lastSeen < 120_000);
  const incidents = recentIncidents().map((i) => store.incidentView(i, { precise }));
  const feed = store.reports.slice(-40).reverse().map((r) => ({
    id: r.id,
    ts: r.ts * 1000,
    kind: r.kind,
    severity: r.severity,
    zone: r.cellId,
    zoneCenter: cellCenter(r.cellId),
    device: r.deviceKey.slice(0, 4) + '…' + r.deviceKey.slice(-4),
    chain: r.chain,
    test: r.test,
  }));
  json(res, 200, {
    generatedAt: now,
    stats: {
      devices: devices.length,
      activeDevices: active.length,
      reports: store.reports.length,
      incidents: incidents.length,
      confirmed: incidents.filter((i) => i.confirmed).length,
      onchainTxs: store.reports.filter((r) => r.chain?.tx).length,
    },
    // Rounded to ~500 m so the public map never pins an individual phone.
    devices: active
      .filter((d) => d.lastPos)
      .map((d) => ({ lat: Math.round(d.lastPos.lat * 200) / 200, lon: Math.round(d.lastPos.lon * 200) / 200 })),
    incidents,
    feed,
    chain: chain ? { cluster: chain.cluster, programId: chain.programId.toBase58(), relayer: chain.relayer.publicKey.toBase58() } : null,
    preview: precise,
    demo: DEMO,
    price: paywall.requirements('/v1/risk', '').extra.priceUsd,
  });
}

async function risk(req, res, url) {
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  const radiusKm = Math.min(200, Number(url.searchParams.get('radius_km') || 25));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(res, 400, { error: 'lat and lon are required' });

  const resource = `http://${req.headers.host}${url.pathname}${url.search}`;
  const receipt = await paywall.gate(req, res, resource, 'GNSS interference risk + source estimates around a point (last 24h)');
  if (!receipt) return;

  const incidents = recentIncidents()
    .map((i) => store.incidentView(i, { precise: true }))
    .filter((i) => haversineKm({ lat, lon }, i.source || i.zoneCenter) <= radiusKm)
    .sort((a, b) => b.lastSeen - a.lastSeen);

  json(
    res,
    200,
    { query: { lat, lon, radiusKm }, risk: riskScore(incidents), incidents, paid: receipt, generatedAt: Date.now() },
    paidHeaders(receipt)
  );
}

const paidHeaders = (receipt) => ({ 'X-PAYMENT-RESPONSE': Paywall.responseHeader(receipt), 'Access-Control-Expose-Headers': 'X-PAYMENT-RESPONSE' });

// Confirmed, severe, recent incidents dominate; spoofing weighs a little more because receivers trust it.
function riskScore(incidents, weightOf = () => 1) {
  const now = Date.now() / 1000;
  let score = 0;
  for (const i of incidents) {
    const ageH = (now - i.lastSeen / 1000) / 3600;
    score += (i.confirmed ? 1 : 0.3) * i.maxSeverity * Math.exp(-ageH / 6) * (i.kinds & 2 ? 1.2 : 1) * 20 * weightOf(i);
  }
  score = Math.min(100, Math.round(score));
  return { score, level: score >= 60 ? 'high' : score >= 25 ? 'elevated' : 'low' };
}

// Geometry of point p against segment a–b on a local flat projection (fine for routes < 500 km).
function pointToSegment(p, a, b) {
  const kx = 111.32 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const ky = 110.57;
  const bx = (b.lon - a.lon) * kx, by = (b.lat - a.lat) * ky;
  const px = (p.lon - a.lon) * kx, py = (p.lat - a.lat) * ky;
  const routeKm = Math.hypot(bx, by);
  const along = routeKm ? (px * bx + py * by) / routeKm : 0; // signed position of the foot point
  const lineDistKm = routeKm ? Math.abs(px * by - py * bx) / routeKm : Math.hypot(px, py);
  const t = routeKm ? Math.max(0, Math.min(1, along / routeKm)) : 0;
  return { distKm: Math.hypot(px - t * bx, py - t * by), lineDistKm, along, routeKm };
}

/** Length of the route (km) that lies within `radiusKm` of p. */
function exposedLength(g, radiusKm) {
  if (g.lineDistKm >= radiusKm) return 0;
  const half = Math.sqrt(radiusKm * radiusKm - g.lineDistKm * g.lineDistKm);
  return Math.max(0, Math.min(g.routeKm, g.along + half) - Math.max(0, g.along - half));
}

const parsePoint = (s) => {
  const [lat, lon] = String(s || '').split(',').map(Number);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
};

/** Paid: which interference areas does a straight flight/drive from A to B cross? */
async function route(req, res, url) {
  const from = parsePoint(url.searchParams.get('from'));
  const to = parsePoint(url.searchParams.get('to'));
  const corridorKm = Math.min(20, Math.max(0, Number(url.searchParams.get('corridor_km') || 1)));
  if (!from || !to) return json(res, 400, { error: 'from and to are required as "lat,lon"' });
  if (haversineKm(from, to) > 500) return json(res, 400, { error: 'route longer than 500 km' });

  const resource = `http://${req.headers.host}${url.pathname}${url.search}`;
  const receipt = await paywall.gate(req, res, resource, 'GNSS interference exposure along a route (last 24h)');
  if (!receipt) return;

  const exposures = [];
  for (const inc of recentIncidents().map((i) => store.incidentView(i, { precise: true }))) {
    const center = inc.source || inc.zoneCenter;
    // Area a receiver is likely affected: the source uncertainty plus a typical low-power jammer reach.
    const impactKm = (inc.source?.radiusKm ?? 2) + 2;
    const g = pointToSegment(center, from, to);
    const reach = impactKm + corridorKm;
    if (g.distKm > reach) continue;
    exposures.push({
      incident: inc.id,
      kinds: inc.kinds,
      confirmed: inc.confirmed,
      sensors: inc.reporters,
      maxSeverity: inc.maxSeverity,
      lastSeen: inc.lastSeen,
      center,
      impactKm,
      distanceFromRouteKm: Math.round(g.distKm * 100) / 100,
      atRouteKm: Math.round(Math.max(0, Math.min(g.routeKm, g.along)) * 10) / 10,
      exposedKm: Math.round(exposedLength(g, reach) * 10) / 10,
      lastSeenAgoMin: Math.round((Date.now() - inc.lastSeen) / 60000),
    });
  }
  exposures.sort((a, b) => a.atRouteKm - b.atRouteKm);
  const byId = new Map(exposures.map((e) => [e.incident, e]));
  const incidents = recentIncidents().map((i) => store.incidentView(i, { precise: false })).filter((i) => byId.has(i.id));
  const risk = riskScore(incidents, (i) => Math.min(1, byId.get(i.id).exposedKm / 2));

  json(res, 200, { query: { from, to, corridorKm }, routeKm: Math.round(haversineKm(from, to) * 10) / 10, risk, exposures, paid: receipt, generatedAt: Date.now() }, paidHeaders(receipt));
}

function status(req, res) {
  json(res, 200, {
    ok: true,
    demo: DEMO,
    testReports: ALLOW_TEST,
    chain: chain ? { cluster: chain.cluster, programId: chain.programId.toBase58(), relayer: chain.relayer.publicKey.toBase58() } : 'off',
    payments: { mode: paywall.mode, ...paywall.requirements('/v1/risk', 'GNSS interference risk') },
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-PAYMENT', 'Access-Control-Allow-Methods': 'GET, POST' });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/v1/devices/register') return await register(req, res);
    if (req.method === 'POST' && url.pathname === '/v1/reports') return await report(req, res);
    if (req.method === 'POST' && url.pathname === '/v1/heartbeat') return await heartbeat(req, res);
    if (req.method === 'GET' && url.pathname === '/v1/map') return map(req, res, url);
    if (req.method === 'GET' && url.pathname === '/v1/risk') return await risk(req, res, url);
    if (req.method === 'GET' && url.pathname === '/v1/route') return await route(req, res, url);
    if (req.method === 'GET' && url.pathname === '/v1/status') return status(req, res);
    if (req.method === 'POST' && url.pathname === '/v1/admin/reset' && DEMO) {
      store.reset();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET') return serveStatic(res, url.pathname);
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`JamMap relayer on http://localhost:${PORT}`);
  console.log(`  chain:    ${chain ? `${chain.cluster} program ${chain.programId.toBase58()}` : 'off (set JAMMAP_PROGRAM_ID to enable)'}`);
  console.log(`  payments: ${paywall.mode}${paywall.payTo ? ` → ${paywall.payTo.toBase58()}` : ''}`);
  console.log(`  demo:     ${DEMO ? 'on (test reports + preview layer + demo payments)' : 'off'}`);
});
