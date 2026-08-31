import type { Kommune } from "./schema.js";

/**
 * Coordinate sanity checks.
 *
 * A wrong coordinate is worse than a missing one. A missing one shows up as "vi vet ikke
 * hvor dette er"; a wrong one puts a pub confidently in the wrong town, and neither the
 * UI nor the user has any way to tell. So every rung of the ladder runs its result
 * through here before it is allowed into the cache.
 */

/** Mainland Norway, generously padded. Deliberately excludes Svalbard and Jan Mayen. */
export const MAINLAND_BBOX = { minLat: 57.5, maxLat: 71.5, minLon: 4.0, maxLon: 31.5 };

/**
 * Svalbard, which the source lists as its own "fylke" (Longyearbyen). It sits at ~78°N,
 * far outside the mainland box, so a single Norway-wide box would either reject
 * Longyearbyen or be so wide it stops catching real errors.
 */
export const SVALBARD_BBOX = { minLat: 74.0, maxLat: 81.0, minLon: 10.0, maxLon: 35.0 };

export type Region = "mainland" | "svalbard";

function inBox(
  lat: number,
  lon: number,
  box: { minLat: number; maxLat: number; minLon: number; maxLon: number },
): boolean {
  return lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon;
}

export interface RegionCheck {
  ok: boolean;
  region?: Region;
  reason?: string;
}

/** Is this coordinate plausibly in Norway at all? */
export function checkInNorway(lat: number, lon: number): RegionCheck {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { ok: false, reason: "Koordinaten er ikke et tall." };
  }
  // 0,0 is the classic "the geocoder gave up" value and is in the Atlantic.
  if (lat === 0 && lon === 0) {
    return { ok: false, reason: "Koordinaten er 0,0 (nullpunkt, ikke et reelt treff)." };
  }
  if (inBox(lat, lon, MAINLAND_BBOX)) return { ok: true, region: "mainland" };
  if (inBox(lat, lon, SVALBARD_BBOX)) return { ok: true, region: "svalbard" };
  return {
    ok: false,
    reason: `Koordinaten (${lat.toFixed(4)}, ${lon.toFixed(4)}) ligger utenfor Norge.`,
  };
}

/**
 * Cheap pre-check against the kommune's bounding box, with a small margin.
 *
 * A bounding box is not the kommune - a long fjord kommune has a box full of its
 * neighbours - so this can only ever *reject*, never confirm. Use it to avoid spending an
 * API call on obvious misses; use `kommuneAtPoint` for the authoritative answer.
 */
export function withinKommuneBbox(
  lat: number,
  lon: number,
  kommune: Kommune,
  marginDeg = 0.05,
): boolean {
  const [minLon, minLat, maxLon, maxLat] = kommune.bbox;
  return (
    lat >= minLat - marginDeg &&
    lat <= maxLat + marginDeg &&
    lon >= minLon - marginDeg &&
    lon <= maxLon + marginDeg
  );
}

/** Great-circle distance in kilometres, for reporting how far off a rejected hit was. */
export function distanceKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
