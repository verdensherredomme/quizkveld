import type { GeoSource, Venue } from "../../pipeline/schema.js";

/**
 * Credits for the data sets the site is built on.
 *
 * Two of the geocoding sources carry licence terms that require attribution in the
 * published product: OpenStreetMap is ODbL, Kartverket/Geonorge is NLOD. This is the same
 * stance the site already takes toward Norges Quizforbund - we build on other people's
 * work and we say whose - except here it is also a licence obligation rather than only
 * good manners.
 *
 * Credits are *derived* from what the data actually contains, never hardcoded into the
 * layout. If no venue carries a coordinate from OpenStreetMap, we do not credit
 * OpenStreetMap. Claiming to use a source we do not use is the same kind of overstatement
 * as claiming a quiz happens on a night the source never promised.
 */

export interface DataCredit {
  /** Stable key, so several geo sources can collapse into one credit line. */
  id: string;
  /** The wording the licence asks for. */
  label: string;
  url: string;
  /** Which licence obliges the credit, shown after the link. */
  licence: string;
  /**
   * The licence text itself. Both ODbL and NLOD ask us to link to the licence, not only
   * to name it, whenever that is practical - and on a web page it always is.
   */
  licenceUrl: string;
}

const OPENSTREETMAP: DataCredit = {
  id: "osm",
  label: "© OpenStreetMap-bidragsytere",
  url: "https://www.openstreetmap.org/copyright",
  licence: "ODbL 1.0",
  licenceUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
};

const KARTVERKET: DataCredit = {
  id: "kartverket",
  // NLOD 2.0 §5 asks for "Inneholder data under Norsk lisens for offentlige data (NLOD)
  // tilgjengeliggjort av [lisensgiver]". The footer renders that sentence around the
  // link, so the label only carries the licensor's name. See DATA.md.
  label: "Kartverket",
  url: "https://www.geonorge.no/",
  licence: "NLOD 2.0",
  licenceUrl: "https://data.norge.no/nlod/no/2.0",
};

/**
 * Which credits each `geoSource` triggers.
 *
 * Confirmed against the phase 2b plan rather than guessed: the `address` step uses
 * Kartverket's Adresse API, `centroid` is computed from municipality geometry fetched from
 * Geonorge, and `kartverket` is the Stedsnavn API. All three are NLOD. `manual` is a
 * coordinate we typed ourselves and owes nobody anything; it is listed explicitly rather
 * than omitted so that a missing entry below reads as a mistake instead of as "no credit
 * needed".
 *
 * `osm` obliges *both* credits, which is the one entry that is not obvious. Phase 2b bounds
 * its Overpass queries with our own municipality geometry from Geonorge rather than with
 * OSM's admin hierarchy, so a coordinate labelled `osm` was still derived using NLOD data.
 * Crediting only OpenStreetMap for it would understate what we used - and under-crediting
 * is the failure that actually breaches a licence, whereas naming a source we leaned on
 * indirectly is at worst imprecise.
 *
 * The exact wording each licence requires is owned by the geocoding work (phase 2b) and
 * documented in DATA.md. Update the constants above from there, not from memory.
 */
const GEO_CREDITS: Record<GeoSource, DataCredit[]> = {
  osm: [OPENSTREETMAP, KARTVERKET],
  kartverket: [KARTVERKET],
  address: [KARTVERKET],
  centroid: [KARTVERKET],
  manual: [],
};

/** Fixed order, so the footer does not reshuffle itself between builds. */
const ORDER = [OPENSTREETMAP.id, KARTVERKET.id];

/**
 * The credits the current data set actually obliges.
 *
 * Returns an empty list while no venue has coordinates - which is no longer the state:
 * after the phase 2 geocoding run 321 of 322 venues carry a coordinate, so the footer
 * credits both OpenStreetMap and Kartverket.
 */
export function dataCredits(venues: Venue[]): DataCredit[] {
  const found = new Map<string, DataCredit>();
  const unknown = new Set<string>();

  for (const venue of venues) {
    // A `geoSource` without a coordinate is not a source we are using.
    if (venue.lat == null || venue.lon == null) continue;
    const source = venue.geoSource;
    if (!source) continue;

    if (!(source in GEO_CREDITS)) {
      // A geo source the pipeline added after this table was written. Warn rather than
      // throw: a daily rebuild must not stop. But say it loudly, because the silent
      // failure here is publishing licensed data without the credit it requires.
      unknown.add(source);
      continue;
    }

    for (const credit of GEO_CREDITS[source]) found.set(credit.id, credit);
  }

  if (unknown.size > 0) {
    console.warn(
      `[attribution] ukjent geoSource uten kreditering: ${[...unknown].join(", ")}. ` +
        "Legg den til i GEO_CREDITS - dette kan være et lisensbrudd.",
    );
  }

  return ORDER.flatMap((id) => {
    const credit = found.get(id);
    return credit ? [credit] : [];
  });
}
