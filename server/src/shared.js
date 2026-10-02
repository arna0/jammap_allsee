// Wire format shared by the Android app, the relayer and the on-chain program.
// Any change here must be mirrored in programs/jammap/src/lib.rs and android/.../Protocol.kt.

export const KIND = { JAMMING: 1, SPOOFING: 2 };
export const KIND_NAME = { 1: 'jamming', 2: 'spoofing', 3: 'jamming+spoofing' };

export const REPORT_DOMAIN = Buffer.from('jammap:report:v1');
export const REGISTER_DOMAIN = Buffer.from('jammap:register:v1');

// On-chain zones are coarse on purpose: ~5.5 km × 4 km at mid latitudes.
// Big enough that several phones near one jammer land in the same zone,
// coarse enough that a phone's exact position never goes on-chain.
export const CELL_DEG = 0.05;
const LON_CELLS = Math.round(360 / CELL_DEG);

export const WINDOW_SECS = 300;
export const QUORUM = 3;

export function cellId(lat, lon) {
  const latIdx = Math.floor((lat + 90) / CELL_DEG);
  const lonIdx = Math.floor((lon + 180) / CELL_DEG);
  return BigInt(latIdx) * BigInt(LON_CELLS) + BigInt(lonIdx);
}

export function cellBounds(id) {
  const n = BigInt(id);
  const latIdx = Number(n / BigInt(LON_CELLS));
  const lonIdx = Number(n % BigInt(LON_CELLS));
  const south = latIdx * CELL_DEG - 90;
  const west = lonIdx * CELL_DEG - 180;
  return { south, west, north: south + CELL_DEG, east: west + CELL_DEG };
}

export function cellCenter(id) {
  const b = cellBounds(id);
  return { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
}

export const windowOf = (ts) => BigInt(Math.floor(ts / WINDOW_SECS));

function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
function i64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
}

/** REPORT_DOMAIN || cell_id u64 LE || ts i64 LE || kind u8 || severity u8 (34 bytes). */
export function reportMessage(cell, ts, kind, severity) {
  return Buffer.concat([REPORT_DOMAIN, u64le(cell), i64le(ts), Buffer.from([kind, severity])]);
}

/** REGISTER_DOMAIN || owner pubkey (50 bytes). */
export function registerMessage(ownerBytes) {
  return Buffer.concat([REGISTER_DOMAIN, Buffer.from(ownerBytes)]);
}

/** Off-chain liveness ping: "jammap:heartbeat:v1" || ts i64 LE. */
export function heartbeatMessage(ts) {
  return Buffer.concat([Buffer.from('jammap:heartbeat:v1'), i64le(ts)]);
}

export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
