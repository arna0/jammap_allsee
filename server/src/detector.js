// GNSS interference detector. Mirrors android/app/src/main/java/app/jammap/Detector.kt.
//
// Physics (see https://developer.android.com/develop/sensors-and-location/sensors/gnss-spoof-jam):
//   jamming      -> noise floor rises: C/N0 drops, AGC drops (receiver turns gain down)
//   spoofing     -> one loud fake transmitter: C/N0 rises and becomes uniform across satellites, AGC drops
//   obstruction  -> less signal (pocket, tunnel, metal box): C/N0 drops but AGC RISES
// AGC is what separates a jammer from a phone in a pocket. Without AGC we refuse to report.

import { haversineKm } from './shared.js';

export const DEFAULTS = {
  warmupEpochs: 20,
  persistEpochs: 5,
  cooldownMs: 60_000,
  alpha: 0.05,
  jamCn0Drop: -8,
  jamAgcDrop: -2,
  spoofCn0Rise: 5,
  spoofMaxSpread: 2.5,
  spoofAgcDrop: -2,
  obstructionAgcRise: 1,
  teleportKm: 2,
  teleportMaxSec: 5,
};

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const std = (a) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};

export function features(epoch, base) {
  const cn0 = (epoch.cn0 || []).filter((x) => x > 0).sort((a, b) => b - a);
  const top4 = cn0.length ? mean(cn0.slice(0, 4)) : 0;
  const spread = cn0.length >= 4 ? std(cn0.slice(0, 8)) : null;
  const agc = epoch.agc ?? null;
  return {
    nSats: cn0.length,
    top4,
    spread,
    agc,
    dCn0: base.cn0 == null ? 0 : top4 - base.cn0,
    dAgc: agc == null || base.agc == null ? null : agc - base.agc,
  };
}

/** Pure classification of one epoch's features. Used by the phone and re-checked by the relayer. */
export function classify(f, opts = DEFAULTS, teleport = false) {
  if (teleport) return { state: 'spoofing', severity: 3 };
  if (f.dAgc == null) {
    return f.dCn0 <= opts.jamCn0Drop ? { state: 'degraded' } : { state: 'clean' };
  }
  if (f.dCn0 <= opts.jamCn0Drop || f.nSats < 4) {
    if (f.dAgc <= opts.jamAgcDrop) {
      const sev = f.dCn0 <= -20 || f.nSats < 4 ? 3 : f.dCn0 <= -14 ? 2 : 1;
      return { state: 'jamming', severity: sev };
    }
    if (f.dAgc >= opts.obstructionAgcRise) return { state: 'obstruction' };
    return { state: 'degraded' };
  }
  if (f.dCn0 >= opts.spoofCn0Rise && f.spread != null && f.spread <= opts.spoofMaxSpread && f.dAgc <= opts.spoofAgcDrop) {
    return { state: 'spoofing', severity: f.dCn0 >= 10 ? 2 : 1 };
  }
  return { state: 'clean' };
}

export class Detector {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.base = { cn0: null, agc: null };
    this.n = 0;
    this.streak = { state: null, count: 0, maxSev: 0 };
    this.lastReportAt = -Infinity;
    this.prevFix = null;
  }

  /**
   * @param {{t:number, cn0:number[], agc:number|null, fix?:{lat:number, lon:number}}} epoch  t in ms
   * @returns {{state:string, features:object, report?:{kind:number, severity:number}}}
   */
  update(epoch) {
    const f = features(epoch, this.base);
    this.n += 1;

    let teleport = false;
    if (epoch.fix && this.prevFix) {
      const dt = (epoch.t - this.prevFix.t) / 1000;
      if (dt > 0 && dt <= this.o.teleportMaxSec && haversineKm(epoch.fix, this.prevFix) >= this.o.teleportKm) teleport = true;
    }
    if (epoch.fix) this.prevFix = { ...epoch.fix, t: epoch.t };

    if (this.n <= this.o.warmupEpochs) {
      this.learn(f);
      return { state: 'warmup', features: f };
    }

    const c = classify(f, this.o, teleport);
    if (c.state === 'clean') this.learn(f);

    const reportable = c.state === 'jamming' || c.state === 'spoofing';
    if (reportable && this.streak.state === c.state) {
      this.streak.count += 1;
      this.streak.maxSev = Math.max(this.streak.maxSev, c.severity);
    } else {
      this.streak = { state: reportable ? c.state : null, count: reportable ? 1 : 0, maxSev: c.severity || 0 };
    }

    const out = { state: c.state, features: f };
    if (reportable && this.streak.count >= this.o.persistEpochs && epoch.t - this.lastReportAt >= this.o.cooldownMs) {
      this.lastReportAt = epoch.t;
      out.report = { kind: c.state === 'jamming' ? 1 : 2, severity: this.streak.maxSev };
    }
    return out;
  }

  learn(f) {
    const a = this.o.alpha;
    if (f.nSats >= 4) this.base.cn0 = this.base.cn0 == null ? f.top4 : this.base.cn0 + a * (f.top4 - this.base.cn0);
    if (f.agc != null) this.base.agc = this.base.agc == null ? f.agc : this.base.agc + a * (f.agc - this.base.agc);
  }
}
