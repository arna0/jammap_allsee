import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Detector, classify } from '../src/detector.js';
import { cellId, cellBounds, reportMessage, registerMessage } from '../src/shared.js';

const clean = (t) => ({ t: t * 1000, cn0: [44, 42, 41, 40, 38, 36, 35, 33, 31], agc: 30 });

function run(det, from, to, make) {
  const out = [];
  for (let t = from; t < to; t++) out.push(det.update(make(t)));
  return out;
}

test('jamming: C/N0 down + AGC down → one report after persistence', () => {
  const d = new Detector();
  run(d, 0, 30, clean);
  const outs = run(d, 30, 40, (t) => ({ t: t * 1000, cn0: [30, 28, 27, 25, 20, 0, 0, 0, 0], agc: 24 }));
  assert.equal(outs.at(-1).state, 'jamming');
  const reports = outs.filter((o) => o.report);
  assert.equal(reports.length, 1, 'cooldown → exactly one report');
  assert.equal(reports[0].report.kind, 1);
});

test('obstruction (metal box / pocket): C/N0 down + AGC UP → never reported', () => {
  const d = new Detector();
  run(d, 0, 30, clean);
  const outs = run(d, 30, 60, (t) => ({ t: t * 1000, cn0: [22, 20, 19, 18, 0, 0, 0, 0, 0], agc: 36 }));
  assert.ok(outs.every((o) => !o.report));
  assert.equal(outs.at(-1).state, 'obstruction');
});

test('spoofing: loud, uniform satellites + AGC down', () => {
  const d = new Detector();
  run(d, 0, 30, clean);
  const outs = run(d, 30, 40, (t) => ({ t: t * 1000, cn0: [47.2, 47, 46.8, 47.1, 46.9, 47, 47.3, 46.7], agc: 25 }));
  assert.equal(outs.at(-1).state, 'spoofing');
  assert.equal(outs.find((o) => o.report).report.kind, 2);
});

test('teleporting fix is spoofing', () => {
  assert.equal(classify({ nSats: 9, dCn0: 0, dAgc: 0, spread: 4 }, undefined, true).state, 'spoofing');
});

test('no AGC → refuse to accuse (degraded, not jamming)', () => {
  assert.equal(classify({ nSats: 5, dCn0: -15, dAgc: null, spread: 3 }).state, 'degraded');
});

test('wire format: 34-byte report, 50-byte register, stable zones', () => {
  assert.equal(reportMessage(123n, 1700000000, 1, 2).length, 34);
  assert.equal(registerMessage(new Uint8Array(32)).length, 50);
  const id = cellId(42.325, 69.625);
  const b = cellBounds(id);
  assert.ok(b.south <= 42.325 && 42.325 < b.north && b.west <= 69.625 && 69.625 < b.east);
  assert.equal(cellId(42.31, 69.61), id, 'nearby points share a zone');
});
