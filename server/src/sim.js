// Virtual phone fleet. Each virtual phone runs the SAME detector as the app on
// synthetic GNSS measurements and talks to the relayer exactly like a real
// phone: register -> heartbeats -> signed reports.
//
// Scenario (repeats every CYCLE seconds, jammer/spoofer drift a little each cycle):
//   t=0..20   warmup, everyone learns a clean baseline
//   t=25..95  jammer on: phones within ~3 km lose C/N0 and AGC drops
//   t=40..80  phone "box" is put in a metal box: C/N0 drops but AGC RISES -> obstruction, not reported
//   t=50      a rogue phone fabricates one report far from anything -> never reaches quorum
//   t=60..120 spoofer on: nearby phones see loud, uniform satellites
//
// Usage: node src/sim.js [--server http://localhost:8787] [--region shymkent|tallinn|larnaca]
// No real radio is involved. Jamming GNSS is illegal; JamMap only listens.

import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Detector } from './detector.js';
import { cellId, reportMessage, registerMessage, heartbeatMessage, haversineKm } from './shared.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
const SERVER = args.server || process.env.JAMMAP_SERVER || 'http://127.0.0.1:8787';
const CYCLE = Number(args.cycle || 360);

// Jammer/spoofer sit in the middle of a 0.05° zone so their victims share one on-chain zone.
const REGIONS = {
  shymkent: { center: { lat: 42.3155, lon: 69.5869 }, jammer: { lat: 42.325, lon: 69.625 }, spoofer: { lat: 42.375, lon: 69.525 } },
  tallinn: { center: { lat: 59.437, lon: 24.7536 }, jammer: { lat: 59.425, lon: 24.775 }, spoofer: { lat: 59.475, lon: 24.725 } },
  larnaca: { center: { lat: 34.9167, lon: 33.6233 }, jammer: { lat: 34.925, lon: 33.625 }, spoofer: { lat: 34.875, lon: 33.575 } },
};
const R = REGIONS[args.region || 'shymkent'];

const rnd = (a, b) => a + Math.random() * (b - a);
const gauss = () => Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
const offset = (p, km, bearing) => ({
  lat: p.lat + (km / 111.32) * Math.cos(bearing),
  lon: p.lon + (km / (111.32 * Math.cos((p.lat * Math.PI) / 180))) * Math.sin(bearing),
});

function makePhone(name, pos, extra = {}) {
  const kp = nacl.sign.keyPair();
  const owner = nacl.sign.keyPair().publicKey;
  return {
    name,
    kp,
    key: bs58.encode(kp.publicKey),
    owner: bs58.encode(owner),
    pos,
    sats: Array.from({ length: 9 + Math.floor(Math.random() * 4) }, () => rnd(28, 44)),
    agcBase: rnd(28, 34),
    detector: new Detector(),
    state: 'warmup',
    ...extra,
  };
}

const phones = [];
for (let i = 0; i < 5; i++) phones.push(makePhone(`jam-${i}`, offset(R.jammer, rnd(0.3, 1.7), rnd(0, 2 * Math.PI))));
for (let i = 0; i < 4; i++) phones.push(makePhone(`spf-${i}`, offset(R.spoofer, rnd(0.2, 1.2), rnd(0, 2 * Math.PI))));
for (let i = 0; i < 6; i++) phones.push(makePhone(`city-${i}`, offset(R.center, rnd(4, 9), rnd(0, 2 * Math.PI))));
// Placed away from the jammer so its only problem is the metal box.
phones.push(makePhone('box', offset(R.center, 1.5, 4.0), { boxed: true }));
const rogue = makePhone('rogue', offset(R.center, 25, 2.5), { rogue: true });
phones.push(rogue);

async function post(path, body) {
  const r = await fetch(SERVER + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

const sign = (phone, msg) => Buffer.from(nacl.sign.detached(msg, phone.kp.secretKey)).toString('base64');

async function register(p) {
  const msg = registerMessage(bs58.decode(p.owner));
  const r = await post('/v1/devices/register', { deviceKey: p.key, owner: p.owner, signature: sign(p, msg), label: p.name });
  if (r.status !== 200) throw new Error(`register ${p.name}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.tx;
}

/** Synthetic GNSS epoch for phone p at scenario time t (seconds into the cycle). */
function measure(p, t, cycleNo) {
  const drift = cycleNo * 0.004;
  const jammer = { lat: R.jammer.lat + drift, lon: R.jammer.lon - drift };
  const spoofer = { lat: R.spoofer.lat - drift, lon: R.spoofer.lon + drift };
  let cn0 = p.sats.map((c) => c + gauss() * 1.2);
  let agc = p.agcBase + gauss() * 0.25;

  if (t >= 25 && t < 95) {
    const d = haversineKm(p.pos, jammer);
    const drop = 32 * Math.exp(-d / 2.0);
    cn0 = cn0.map((c) => c - drop + gauss());
    agc -= drop * 0.3;
  }
  if (t >= 60 && t < 120 && haversineKm(p.pos, spoofer) < 1.6) {
    cn0 = cn0.map(() => 51 + gauss() * 0.6);
    agc -= 5 + gauss() * 0.3;
  }
  if (p.boxed && t >= 40 && t < 80) {
    cn0 = cn0.map((c) => c - 22 + gauss());
    agc += 6;
  }
  cn0 = cn0.map((c) => (c < 12 ? 0 : c));
  return { cn0, agc, fix: p.pos };
}

const counters = { sent: 0, accepted: 0, rejected: 0 };

async function tick(t, cycleNo) {
  const now = Date.now();
  const ts = Math.floor(now / 1000);
  await Promise.all(
    phones.map(async (p) => {
      if (p.rogue) {
        if (t === 50) {
          // Fabricated report: passes signature checks, but nobody else confirms it.
          const cell = cellId(p.pos.lat, p.pos.lon);
          const r = await post('/v1/reports', {
            deviceKey: p.key, lat: p.pos.lat, lon: p.pos.lon, cellId: cell.toString(), ts, kind: 1, severity: 3,
            features: { nSats: 3, dCn0: -25, dAgc: -8, spread: null }, signature: sign(p, reportMessage(cell, ts, 1, 3)),
          });
          console.log(`  ${'rogue'.padEnd(7)} fabricated report -> ${r.status} (will stay unconfirmed: 1/3 devices)`);
        }
        return;
      }
      const out = p.detector.update({ t: now, ...measure(p, t, cycleNo) });
      if (out.state !== p.state) {
        if (['jamming', 'spoofing', 'obstruction'].includes(out.state) || ['jamming', 'spoofing', 'obstruction'].includes(p.state))
          console.log(`  ${p.name.padEnd(7)} ${p.state} -> ${out.state}  (dC/N0 ${out.features.dCn0.toFixed(1)} dB, dAGC ${out.features.dAgc?.toFixed(1)} dB)`);
        p.state = out.state;
      }
      if (out.report) {
        const cell = cellId(p.pos.lat, p.pos.lon);
        const { kind, severity } = out.report;
        const f = out.features;
        counters.sent++;
        const r = await post('/v1/reports', {
          deviceKey: p.key, lat: p.pos.lat, lon: p.pos.lon, cellId: cell.toString(), ts, kind, severity,
          features: { nSats: f.nSats, dCn0: +f.dCn0.toFixed(2), dAgc: f.dAgc == null ? null : +f.dAgc.toFixed(2), spread: f.spread == null ? null : +f.spread.toFixed(2) },
          signature: sign(p, reportMessage(cell, ts, kind, severity)),
        });
        if (r.status === 202) {
          counters.accepted++;
          const inc = r.body.incident;
          console.log(`  ${p.name.padEnd(7)} REPORT ${kind === 1 ? 'jamming' : 'spoofing'} sev ${severity} -> zone ${inc.cellId}: ${inc.reporters}/${inc.quorum}${inc.confirmed ? '  CONFIRMED' : ''}`);
        } else if (r.status !== 409) {
          counters.rejected++;
          console.log(`  ${p.name.padEnd(7)} report rejected ${r.status}: ${r.body.error}`);
        }
      }
      if (t % 10 === 0) {
        await post('/v1/heartbeat', { deviceKey: p.key, ts, lat: p.pos.lat, lon: p.pos.lon, signature: sign(p, heartbeatMessage(ts)) });
      }
    })
  );
}

async function main() {
  console.log(`JamMap simulator → ${SERVER} (${args.region || 'shymkent'}, ${phones.length} virtual phones)`);
  const st = await fetch(SERVER + '/v1/status').then((r) => r.json()).catch(() => null);
  if (!st) throw new Error(`relayer not reachable at ${SERVER} — start it with "npm start"`);
  console.log(`relayer chain: ${typeof st.chain === 'object' ? `${st.chain.cluster} ${st.chain.programId}` : 'off'}`);

  for (const p of phones) {
    const tx = await register(p);
    process.stdout.write(tx ? `  registered ${p.name} (tx ${tx.slice(0, 10)}…)\n` : `  registered ${p.name}\n`);
  }

  let t = 0;
  let cycleNo = 0;
  console.log('\n— cycle 1: warmup (20 s) —');
  const timer = setInterval(async () => {
    t += 1;
    if (t === 25) console.log('— jammer ON —');
    if (t === 40) console.log('— "box" phone placed in metal box (obstruction) —');
    if (t === 60) console.log('— spoofer ON —');
    if (t === 95) console.log('— jammer OFF —');
    if (t === 120) console.log(`— spoofer OFF — reports sent ${counters.sent}, accepted ${counters.accepted}, rejected ${counters.rejected}`);
    if (t >= CYCLE) {
      t = 20; // keep baselines, skip warmup
      cycleNo += 1;
      console.log(`\n— cycle ${cycleNo + 1} —`);
    }
    try {
      await tick(t, cycleNo);
    } catch (e) {
      console.error('tick error:', e.message);
    }
  }, 1000);
  process.on('SIGINT', () => {
    clearInterval(timer);
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
