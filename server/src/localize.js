// Rough emitter localization: phones closest to a jammer lose the most C/N0
// (or, for a spoofer, gain the most), so a weighted centroid of reporting
// positions points at the source. Weighted spread gives an uncertainty radius.
// Good enough to say "somewhere around here"; a real version would fit a
// path-loss model (see arXiv:2305.02038).

const R_KM = 6371;

export function estimateSource(reports) {
  const pts = reports.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
  if (pts.length < 2) return null;

  const weight = (r) => {
    const d = Math.abs(r.features?.dCn0 ?? 8);
    return Math.max(1, d) ** 2;
  };
  let sw = 0;
  let lat = 0;
  let lon = 0;
  for (const r of pts) {
    const w = weight(r);
    sw += w;
    lat += w * r.lat;
    lon += w * r.lon;
  }
  lat /= sw;
  lon /= sw;

  const kmPerDegLat = (Math.PI * R_KM) / 180;
  const kmPerDegLon = kmPerDegLat * Math.cos((lat * Math.PI) / 180);
  let v = 0;
  for (const r of pts) {
    const dx = (r.lon - lon) * kmPerDegLon;
    const dy = (r.lat - lat) * kmPerDegLat;
    v += weight(r) * (dx * dx + dy * dy);
  }
  const radiusKm = Math.max(0.3, Math.sqrt(v / sw));
  return { lat, lon, radiusKm: Math.round(radiusKm * 100) / 100, basedOn: pts.length };
}
