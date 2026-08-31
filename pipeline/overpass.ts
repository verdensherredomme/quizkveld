import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { politeFetch } from "./http.js";
import { ROOT } from "./paths.js";
import type { Kommune } from "./schema.js";

/**
 * Overpass / OpenStreetMap.
 *
 * This is the workhorse rung of the ladder: with only 3 of 322 venues carrying a street
 * address, matching a venue name inside a kommune is essentially all we have.
 *
 * Overpass is donated infrastructure. We therefore issue *one* request per kommune and
 * match every venue in that kommune against the result, rather than one request per
 * venue. That is 103 requests instead of 322, and the results are reused across the run.
 */

const ENDPOINT = "https://overpass-api.de/api/interpreter";

/** Local working cache of Overpass responses. Not committed - see fetchVenuesInKommune. */
const OSM_CACHE_DIR = path.join(ROOT, "raw", "osm");

/** Amenity values a pub quiz plausibly happens in. */
const AMENITIES = [
  "pub",
  "bar",
  "cafe",
  "restaurant",
  "nightclub",
  "biergarten",
  "casino",
  "community_centre",
  "arts_centre",
  "social_facility",
  "events_venue",
  "theatre",
];

/** Non-amenity tags that also cover real quiz venues: hotels, student clubs, sports bars. */
const TOURISM = ["hotel", "hostel", "guest_house"];
const LEISURE = ["sports_centre", "bowling_alley", "hackerspace", "dance"];

export interface OsmPlace {
  name: string;
  lat: number;
  lon: number;
  amenity?: string;
}

interface OverpassElement {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

export function buildQuery(kommune: Kommune): string {
  const [minLon, minLat, maxLon, maxLat] = kommune.bbox;
  const bbox = `${minLat},${minLon},${maxLat},${maxLon}`;
  const re = (values: string[]): string => `^(${values.join("|")})$`;
  // The statements MUST be wrapped in a union. In Overpass QL a bare `out` only emits the
  // *last* statement's result set, so an unwrapped list silently returns a fraction of the
  // data - which is exactly what happened on the first run (49 hits in Oslo instead of
  // 1500+, because only the community_centre statement survived).
  return [
    "[out:json][timeout:120];",
    "(",
    `nwr["amenity"~"${re(AMENITIES)}"](${bbox});`,
    `nwr["tourism"~"${re(TOURISM)}"](${bbox});`,
    `nwr["leisure"~"${re(LEISURE)}"](${bbox});`,
    // Student societies and members' clubs (Samfundet and friends) carry no amenity tag.
    `nwr["club"](${bbox});`,
    ");",
    "out tags center;",
  ].join("");
}

/**
 * Fetches every plausible venue inside the kommune's bounding box.
 *
 * The bounding box is wider than the kommune itself, so results can include neighbouring
 * municipalities. That is fine and in fact wanted - a pub right on a kommune border may
 * be tagged either side - because the caller verifies the winning coordinate against the
 * authoritative point-in-kommune API afterwards.
 *
 * Responses are cached on disk under `raw/osm/`. Overpass is donated infrastructure and
 * the name matching needs tuning against real data, so the alternative is re-downloading
 * the whole country every time a threshold moves. The cache is local working state, not a
 * committed artefact - `data/geocache.json` is the durable result.
 */
export async function fetchVenuesInKommune(
  kommune: Kommune,
  onRetry?: (message: string) => void,
): Promise<OsmPlace[]> {
  const cached = await readCache(kommune);
  if (cached) return cached;

  const body = `data=${encodeURIComponent(buildQuery(kommune))}`;
  const text = await politeFetch(ENDPOINT, {
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    timeoutMs: 180_000,
    onRetry: (attempt, reason, waitMs) =>
      onRetry?.(
        `Overpass svarte ikke for ${kommune.navn} (${reason}); forsok ${attempt}, venter ${Math.round(waitMs / 1000)} s.`,
      ),
  });

  let parsed: OverpassResponse;
  try {
    parsed = JSON.parse(text) as OverpassResponse;
  } catch {
    throw new Error(`Ugyldig JSON fra Overpass for ${kommune.navn}.`);
  }

  const places: OsmPlace[] = [];
  for (const element of parsed.elements ?? []) {
    const name = element.tags?.name;
    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    if (!name || lat === undefined || lon === undefined) continue;
    places.push({ name, lat, lon, amenity: element.tags?.amenity });
  }

  await writeCache(kommune, places);
  return places;
}

function cachePath(kommune: Kommune): string {
  return path.join(OSM_CACHE_DIR, `${kommune.nr}.json`);
}

async function readCache(kommune: Kommune): Promise<OsmPlace[] | null> {
  try {
    const text = await readFile(cachePath(kommune), "utf8");
    return JSON.parse(text) as OsmPlace[];
  } catch {
    return null;
  }
}

async function writeCache(kommune: Kommune, places: OsmPlace[]): Promise<void> {
  await mkdir(OSM_CACHE_DIR, { recursive: true });
  await writeFile(cachePath(kommune), JSON.stringify(places), "utf8");
}
