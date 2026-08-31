import fs from "node:fs/promises";
import path from "node:path";
import { kommuneAtPoint, searchAdresse, searchStedsnavn } from "./geonorge.js";
import { checkInNorway, withinKommuneBbox } from "./geovalidate.js";
import { indexRegister, placeTypeRank, type RegisterIndex } from "./kommune.js";
import { fetchVenuesInKommune, type OsmPlace } from "./overpass.js";
import { PATHS } from "./paths.js";
import { bestMatch } from "./venuematch.js";
import {
  GeoCacheSchema,
  type GeoCacheData,
  type GeoCacheEntry,
  type GeoConfidence,
  type GeoSource,
  type Kommune,
  type KommuneAliases,
  type KommuneRegister,
  type Venue,
} from "./schema.js";

/**
 * Geocoding.
 *
 * The source gives us no coordinates and, for 319 of 322 venues, no address either. So
 * the real job is "find a named place inside a known kommune", and the ladder is built
 * around that:
 *
 *   1. address     Kartverket Adresse, for the few venues with a street address.
 *   2. osm         Overpass name match inside the kommune. The workhorse.
 *   3. kartverket  Kartverket Stedsnavn, for venues that are themselves named places.
 *   4. centroid    The kommune's own interior point. Honest, but coarse.
 *
 * Every hit is validated before it is cached: it must be inside Norway, and it must be
 * inside the kommune we expect. A pub placed on a same-named pub in another town looks
 * completely fine in the UI and will never be reported as a bug, so the ladder refuses
 * anything it cannot confirm.
 */

/**
 * Above this many venues in one kommune, the centroid fallback is refused. Three venues
 * on one pin is a coarse answer; thirty is a lie.
 */
export const MAX_VENUES_FOR_CENTROID = 3;

export interface GeoResult {  lat: number;
  lon: number;
  geoSource: GeoSource;
  geoConfidence: GeoConfidence;
  /** Why we believe this, for the run report. */
  detail?: string;
}

/** Everything a provider needs that is expensive to build or shared between venues. */
export interface GeoContext {
  index: RegisterIndex;
  aliases: KommuneAliases;
  /** Overpass results per kommune number, fetched at most once each. */
  osmByKommune: Map<string, OsmPlace[]>;
  /** How many venues in this run belong to each kommune. Gates the centroid fallback. */
  venuesPerKommune: Map<string, number>;
  log: (message: string) => void;
  /** Records a candidate we threw away because it failed validation. */
  reject: (message: string) => void;
}

export interface GeoProvider {
  readonly name: GeoSource;
  lookup(venue: Venue, ctx: GeoContext): Promise<GeoResult | null>;
}

/** The kommune a venue belongs to, plus the fallback point for places without one. */
export function kommuneFor(
  venue: Venue,
  ctx: GeoContext,
): { kommune: Kommune | null; fallbackPoint: { lat: number; lon: number } | null } {
  const kommune = venue.kommuneNr ? (ctx.index.byNr.get(venue.kommuneNr) ?? null) : null;
  const alias = ctx.aliases.aliases[venue.kommune];
  return { kommune, fallbackPoint: alias?.point ?? null };
}

/**
 * Append-only cache keyed by venue id. Entries are never deleted by the pipeline: a venue
 * that disappears upstream and comes back later should keep its coordinates.
 */
export class GeoCache {
  private data: GeoCacheData = {};

  private constructor(private readonly file: string) {}

  static async load(file: string = PATHS.geocache): Promise<GeoCache> {
    const cache = new GeoCache(file);
    try {
      const text = await fs.readFile(file, "utf8");
      cache.data = GeoCacheSchema.parse(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof SyntaxError) {
          throw new Error(`Kunne ikke lese ${file}: ugyldig JSON.`);
        }
        throw error;
      }
      cache.data = {};
    }
    return cache;
  }

  get(venueId: string): GeoCacheEntry | undefined {
    return this.data[venueId];
  }

  has(venueId: string): boolean {
    return venueId in this.data;
  }

  set(venueId: string, result: GeoResult, resolvedAt: Date = new Date()): void {
    this.data[venueId] = {
      lat: result.lat,
      lon: result.lon,
      geoSource: result.geoSource,
      geoConfidence: result.geoConfidence,
      resolvedAt: resolvedAt.toISOString(),
    };
  }

  get size(): number {
    return Object.keys(this.data).length;
  }

  /** Returns the cache contents with keys sorted, so the committed file diffs cleanly. */
  toJSON(): GeoCacheData {
    const sorted: GeoCacheData = {};
    for (const key of Object.keys(this.data).sort()) {
      const entry = this.data[key];
      if (entry) sorted[key] = entry;
    }
    return sorted;
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, `${JSON.stringify(this.toJSON(), null, 2)}\n`, "utf8");
  }
}

/**
 * Confirms a coordinate really is where we think it is.
 *
 * The bounding-box test is a cheap reject; the authoritative answer comes from
 * Kartverket's point-in-kommune lookup, which knows the actual borders.
 */
export async function verifyInKommune(
  lat: number,
  lon: number,
  kommune: Kommune | null,
): Promise<{ ok: boolean; reason?: string }> {
  const region = checkInNorway(lat, lon);
  if (!region.ok) return { ok: false, reason: region.reason };

  if (!kommune) return { ok: true };
  // Svalbard sits outside the kommune register entirely, so the region check is all we
  // have there - and it is enough, because there is exactly one settlement.
  if (region.region === "svalbard") return { ok: true };

  if (!withinKommuneBbox(lat, lon, kommune)) {
    return { ok: false, reason: `utenfor omradet til ${kommune.navn}` };
  }

  const actual = await kommuneAtPoint(lat, lon);
  if (!actual) return { ok: false, reason: "punktet ligger ikke i noen norsk kommune" };
  if (actual.kommunenummer !== kommune.nr) {
    return { ok: false, reason: `ligger i ${actual.kommunenavn}, ikke ${kommune.navn}` };
  }
  return { ok: true };
}

/** Rung 1: Kartverket Adresse. Only fires for venues with an address in their name. */
const addressProvider: GeoProvider = {
  name: "address",
  async lookup(venue, ctx) {
    if (!venue.addressHint) return null;
    const { kommune } = kommuneFor(venue, ctx);

    const hits = await searchAdresse(venue.addressHint, kommune?.nr);
    for (const hit of hits) {
      if (kommune && hit.kommunenummer !== kommune.nr) continue;
      const check = await verifyInKommune(hit.lat, hit.lon, kommune);
      if (!check.ok) continue;
      return {
        lat: hit.lat,
        lon: hit.lon,
        geoSource: "address",
        geoConfidence: "high",
        detail: hit.adressetekst,
      };
    }
    return null;
  },
};

/** Rung 2: Overpass. One request per kommune, reused across every venue in it. */
const osmProvider: GeoProvider = {
  name: "osm",
  async lookup(venue, ctx) {
    const { kommune } = kommuneFor(venue, ctx);
    if (!kommune) return null;

    let places = ctx.osmByKommune.get(kommune.nr);
    if (!places) {
      places = await fetchVenuesInKommune(kommune, (message) => ctx.log(message));
      ctx.osmByKommune.set(kommune.nr, places);
      ctx.log(`  OSM: ${places.length} navngitte steder i ${kommune.navn}`);
    }

    const best = bestMatch(venue.name, places, {
      // Both the official kommune name and the volunteer's own place name count as
      // legitimate suffixes on an OSM name: "Skatten Oslo", "Grand hotell Egersund".
      placeWords: [kommune.navn, venue.kommune],
    });
    if (!best) return null;

    const check = await verifyInKommune(best.candidate.lat, best.candidate.lon, kommune);
    if (!check.ok) {
      ctx.reject(`${venue.name} (${venue.kommune}): "${best.candidate.name}" ${check.reason}`);
      return null;
    }

    // An exact name match we could verify is as good as this gets without an address.
    // Anything fuzzier, or anything where two different places matched equally well, is
    // honestly medium.
    const confidence: GeoConfidence =
      best.match.kind === "exact" && !best.ambiguous ? "high" : "medium";

    const note = best.ambiguous ? ", flere like gode treff" : "";
    return {
      lat: best.candidate.lat,
      lon: best.candidate.lon,
      geoSource: "osm",
      geoConfidence: confidence,
      detail: `${best.candidate.name} (${best.match.kind}${note})`,
    };
  },
};

/** Rung 3: Kartverket Stedsnavn. Catches venues that are themselves named places. */
const stedsnavnProvider: GeoProvider = {
  name: "kartverket",
  async lookup(venue, ctx) {
    const { kommune } = kommuneFor(venue, ctx);
    if (!kommune) return null;

    const hits = await searchStedsnavn(venue.name);
    const inKommune = hits
      .filter((hit) => hit.kommunenummer === kommune.nr)
      .sort((a, b) => placeTypeRank(b.type) - placeTypeRank(a.type));

    const top = inKommune[0];
    if (!top) return null;

    const check = await verifyInKommune(top.lat, top.lon, kommune);
    if (!check.ok) return null;

    return {
      lat: top.lat,
      lon: top.lon,
      geoSource: "kartverket",
      geoConfidence: "medium",
      detail: `${top.navn} [${top.type}]`,
    };
  },
};

/**
 * Rung 4: the kommune's interior point.
 *
 * This is not where the pub is - it is where the kommune is. Confidence is "low" and the
 * site must never present it as a precise location.
 *
 * It is also only honest in a small kommune. Writing the centroid for every unmatched
 * venue in Oslo stacks dozens of pubs on one pin several kilometres from all of them,
 * which is worse than an empty field: a "nearest quiz" list would sort by that pin and
 * confidently rank the wrong places first. Above the threshold the venue is left without
 * a coordinate instead.
 */
export const centroidProvider: GeoProvider = {
  name: "centroid",
  async lookup(venue, ctx) {
    const { kommune, fallbackPoint } = kommuneFor(venue, ctx);
    const point = kommune?.point ?? fallbackPoint;
    if (!point) return null;

    const venuesHere = ctx.venuesPerKommune.get(venue.kommuneNr ?? "") ?? 1;
    if (venuesHere > MAX_VENUES_FOR_CENTROID) {
      ctx.log(
        `  ${venue.name} (${venue.kommune}): sentroide droppet, ${venuesHere} steder i kommunen ville havnet pa samme punkt`,
      );
      return null;
    }

    if (!checkInNorway(point.lat, point.lon).ok) return null;

    return {
      lat: point.lat,
      lon: point.lon,
      geoSource: "centroid",
      geoConfidence: "low",
      detail: kommune ? `sentrum av ${kommune.navn}` : `fast punkt for ${venue.kommune}`,
    };
  },
};

/**
 * The ladder.
 *
 * Address runs first even though it resolves the fewest venues. It returns instantly for
 * the venues with no address hint, so it costs nothing, and for the few that have one it
 * is strictly more precise than a fuzzy name match.
 */
export function defaultProviders(): GeoProvider[] {
  return [addressProvider, osmProvider, stedsnavnProvider, centroidProvider];
}

/**
 * Counts against the whole venue list, not just the uncached ones, so a resumed run
 * gates the centroid the same way the first run did.
 */
export function countVenuesPerKommune(venues: Venue[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const venue of venues) {
    if (!venue.kommuneNr) continue;
    counts.set(venue.kommuneNr, (counts.get(venue.kommuneNr) ?? 0) + 1);
  }
  return counts;
}

export interface GeocodeStats {
  total: number;
  cached: number;
  resolved: number;
  unresolved: number;
  bySource: Record<string, number>;
  byConfidence: Record<string, number>;
  /** Venues that got nothing at all. */
  missing: string[];
  /** Candidates thrown away because they failed the kommune check. */
  rejected: string[];
  lowConfidence: string[];
}

export interface GeocodeOptions {
  providers?: GeoProvider[];
  cache?: GeoCache;
  register?: KommuneRegister;
  aliases?: KommuneAliases;
  /** Stop after this many newly resolved venues. */
  limit?: number | null;
  log?: (message: string) => void;
}

/**
 * Walks the ladder for every venue that is not already cached, persisting after each hit
 * so an interrupted run never loses work.
 *
 * Venues are processed grouped by kommune so the Overpass cache fills once per kommune
 * rather than thrashing between them.
 */
export async function runGeocode(
  venues: Venue[],
  options: GeocodeOptions = {},
): Promise<GeocodeStats> {
  const { loadAliases, loadRegister } = await import("./kommuneregister.js");
  const cache = options.cache ?? (await GeoCache.load());
  const register = options.register ?? (await loadRegister());
  const aliases = options.aliases ?? (await loadAliases());
  const providers = options.providers ?? defaultProviders();
  const log = options.log ?? ((): void => {});

  const stats: GeocodeStats = {
    total: venues.length,
    cached: 0,
    resolved: 0,
    unresolved: 0,
    bySource: {},
    byConfidence: {},
    missing: [],
    rejected: [],
    lowConfidence: [],
  };

  const ctx: GeoContext = {
    index: indexRegister(register.kommuner),
    aliases,
    osmByKommune: new Map(),
    venuesPerKommune: countVenuesPerKommune(venues),
    log,
    reject: (message) => {
      stats.rejected.push(message);
      log(`  forkastet: ${message}`);
    },
  };

  const ordered = [...venues].sort(
    (a, b) =>
      (a.kommuneNr ?? "9999").localeCompare(b.kommuneNr ?? "9999") ||
      a.id.localeCompare(b.id),
  );

  for (const venue of ordered) {
    if (cache.has(venue.id)) {
      stats.cached += 1;
      continue;
    }
    if (
      options.limit !== null &&
      options.limit !== undefined &&
      stats.resolved >= options.limit
    ) {
      break;
    }

    let hit: GeoResult | null = null;
    for (const provider of providers) {
      try {
        hit = await provider.lookup(venue, ctx);
      } catch (error) {
        // A failing provider must not abort the run: the cache is the valuable artefact
        // and we want to keep every hit already earned.
        const reason = error instanceof Error ? error.message : String(error);
        log(`  ${provider.name} feilet for ${venue.name}: ${reason}`);
        hit = null;
      }
      if (hit) break;
    }

    if (hit) {
      cache.set(venue.id, hit);
      await cache.save();
      stats.resolved += 1;
      stats.bySource[hit.geoSource] = (stats.bySource[hit.geoSource] ?? 0) + 1;
      stats.byConfidence[hit.geoConfidence] =
        (stats.byConfidence[hit.geoConfidence] ?? 0) + 1;
      if (hit.geoConfidence === "low") {
        stats.lowConfidence.push(`${venue.name} (${venue.kommune}) - ${hit.detail ?? ""}`);
      }
      log(`  ${venue.name} -> ${hit.geoSource}/${hit.geoConfidence} ${hit.detail ?? ""}`);
    } else {
      stats.unresolved += 1;
      stats.missing.push(`${venue.name} (${venue.kommune}, ${venue.fylke})`);
    }
  }

  await cache.save();
  return stats;
}
