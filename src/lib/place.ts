import { slug } from "../../pipeline/slug.js";
import type { Venue } from "../../pipeline/schema.js";

/**
 * URL slugs for places and counties.
 *
 * Two things about the source data shape this module:
 *
 * 1. `kommune` is not a kommune. It is the place name a volunteer typed into a spreadsheet
 *    column, so "Greåker" appears alongside "Sarpsborg" even though the first is inside the
 *    second. We surface it as "sted", never as "kommune", and we do not try to reconcile it
 *    with any official register - that is phase 2b's problem, and guessing here would put
 *    quizzes under the wrong heading.
 *
 * 2. `fylke` uses the pre-2020 county names (Sør-Trøndelag, Hedmark, Vest-Agder, Sogn og
 *    Fjordane) plus Svalbard. We navigate on `fylkeNow` instead - see `fylkeOf`.
 *
 * Slugs must be stable, because they are the site's URLs. `slug()` is imported from the
 * pipeline rather than reimplemented so that a place slug and a venue id transliterate
 * æ/ø/å identically.
 */

export type PlaceKey = string;

/**
 * The county a venue is filed under.
 *
 * The source's `fylke` is pre-2020: it still says Hordaland, Sør-Trøndelag, Hedmark,
 * Vest-Agder, Aust-Agder, Oppland, Nord-Trøndelag and Sogn og Fjordane. All eight were
 * dissolved in the 2020 reform, and they cover 78 of 322 venues. Navigating on them means
 * someone looking for a quiz in Bergen has to know to press "Hordaland", while "Vestland"
 * does not exist on the site at all.
 *
 * `fylkeNow` is a per-venue lookup against Kartverket, not a rename table, which is why we
 * can trust it: Jevnaker went Oppland -> Viken -> Akershus, and no hand-written alias list
 * would send it anywhere but Innlandet with the rest of Oppland.
 *
 * The source's own spelling is kept in `fylke` and still used where we are talking *to* the
 * source - the correction mailto quotes their wording so a volunteer can find the row.
 *
 * One venue (Sandnesseter) has no `fylkeNow` because Kartverket does not know the place, so
 * it falls back to the source rather than dropping out of the navigation. Svalbard needs no
 * special case: it kept its name, so old and new are the same string.
 */
export function fylkeOf(venue: Pick<Venue, "fylke" | "fylkeNow">): string {
  return venue.fylkeNow ?? venue.fylke;
}

export interface PlaceSlugs {
  /** Place name (the `kommune` field) to URL slug. */
  bySted: Map<string, string>;
  /** County name to URL slug. */
  byFylke: Map<string, string>;
}

/**
 * Distinct place names can slug to the same string - and the same place name can appear in
 * two counties. Either would silently merge two unrelated places onto one page, so every
 * value gets its own slug, resolved deterministically:
 *
 *   1. plain slug of the place name
 *   2. place name + county, which reads well for the "same name, different county" case
 *   3. a numeric suffix
 *
 * Step 3 exists so a single volunteer typo upstream cannot take the daily deploy down. The
 * site is rebuilt from data nobody here controls; a slightly ugly URL is a much better
 * failure mode than a build that stops publishing, and neither of them loses a quiz.
 *
 * Input is sorted first so the result does not depend on the order of rows in the source
 * table, which reshuffles between scrapes.
 */
function buildSlugMap(values: Array<{ value: string; qualifier: string }>): Map<string, string> {
  const unique = new Map<string, string>();
  for (const { value, qualifier } of values) {
    if (!unique.has(value)) unique.set(value, qualifier);
  }

  const sorted = [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const taken = new Set<string>();
  const result = new Map<string, string>();

  for (const [value, qualifier] of sorted) {
    const base = slug(value) || slug(qualifier) || "sted";

    let chosen = base;
    if (taken.has(chosen)) {
      chosen = slug(`${value}-${qualifier}`) || `${base}-2`;
    }
    for (let counter = 2; taken.has(chosen); counter += 1) {
      chosen = `${base}-${counter}`;
    }

    taken.add(chosen);
    result.set(value, chosen);
  }

  return result;
}

export function buildPlaceSlugs(venues: Venue[]): PlaceSlugs {
  return {
    bySted: buildSlugMap(venues.map((v) => ({ value: v.kommune, qualifier: fylkeOf(v) }))),
    // A county name has nothing broader to qualify it with, so it qualifies itself; in
    // practice the county names never collide.
    byFylke: buildSlugMap(venues.map((v) => ({ value: fylkeOf(v), qualifier: fylkeOf(v) }))),
  };
}

/** A name the source still uses for part of a current county. */
export interface FormerFylke {
  /** The county name as the source writes it. */
  fylke: string;
  /**
   * The municipalities that came from it, set only when this county also appears under its
   * own name in the source. Empty means the whole county was renamed, so the page can say
   * "tidligere X" outright.
   */
  kommuner: string[];
}

/**
 * For each current county, the names the source still uses for parts of it.
 *
 * Navigation is our derivation, so the page says so out loud: "Vestland - tidligere
 * Hordaland og Sogn og Fjordane". That helps someone who knows the old name, and it explains
 * why the source's own text further down the page says something else. A redirect would have
 * hidden that difference; a sentence explains it.
 *
 * Two different things look alike here and must not be phrased alike. Vestland *was*
 * Hordaland: the source never writes "Vestland", so every venue here carries an old name.
 * Akershus was never Oppland - it still exists under its own name, and merely received
 * Jevnaker when Oppland was dissolved. Saying "tidligere Oppland" on Akershus would be a
 * plain falsehood about 26 of its 28 venues.
 *
 * The two are told apart by whether the source uses this county's own name at all. When it
 * does, the old name is reported as the municipalities that moved in, which is both true and
 * more useful: it names Jevnaker, which is what someone looking for Glassheim needs.
 *
 * Dropping the entry instead would strand exactly that reader - the same silent wrong answer
 * that ruled out redirects, since Oppland's other six venues are in Innlandet.
 *
 * Derived, like everything else here: a county that is not renamed produces no entry, so
 * these disappear on their own if the source ever modernises its spelling.
 */
export function formerFylker(venues: Venue[]): Map<string, FormerFylke[]> {
  const usesOwnName = new Set<string>();
  const former = new Map<string, Map<string, Set<string>>>();

  for (const venue of venues) {
    const now = fylkeOf(venue);
    if (venue.fylke === now) {
      usesOwnName.add(now);
      continue;
    }
    const names = former.get(now) ?? new Map<string, Set<string>>();
    const kommuner = names.get(venue.fylke) ?? new Set<string>();
    kommuner.add(venue.kommune);
    names.set(venue.fylke, kommuner);
    former.set(now, names);
  }

  const byNb = (a: string, b: string) => a.localeCompare(b, "nb");
  return new Map(
    [...former].map(([now, names]) => [
      now,
      [...names]
        .map(([fylke, kommuner]) => ({
          fylke,
          kommuner: usesOwnName.has(now) ? [...kommuner].sort(byNb) : [],
        }))
        .sort((a, b) => byNb(a.fylke, b.fylke)),
    ]),
  );
}

/** Inverts a slug map so a page can go from URL segment back to the source spelling. */
export function invert(map: Map<string, string>): Map<string, string> {
  return new Map([...map].map(([value, slugged]) => [slugged, value]));
}
