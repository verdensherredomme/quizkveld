/**
 * Matching the source's venue names against OpenStreetMap names.
 *
 * This is the part most likely to produce confidently wrong answers, so it is pure and
 * heavily tested. The rule throughout: when in doubt, return no match. An unplaced pub is
 * a small gap in the UI; a pub placed on top of a different pub with a similar name is a
 * bug nobody will ever notice or report.
 */

const NOISE_WORDS = new Set([
  "the",
  "den",
  "det",
  "og",
  "and",
  "as",
  "a/s",
  "ans",
  "avd",
  "avdeling",
]);

/**
 * Words that describe what kind of place it is rather than which place it is. Dropped
 * only when comparing, never from the stored name.
 */
const GENERIC_WORDS = new Set([
  "pub",
  "bar",
  "kro",
  "kafe",
  "cafe",
  "kaffe",
  "kaffebar",
  "restaurant",
  "pizzeria",
  "gjestgiveri",
  "hotell",
  "hotel",
  "scene",
  "klubb",
  "club",
  "lounge",
  "bistro",
  "brasserie",
  "bryggeri",
  "brewery",
  "taproom",
  "sportsbar",
  "nattklubb",
  "spiseri",
  "vinbar",
]);

const TRANSLITERATION: Record<string, string> = {
  æ: "ae",
  ø: "oe",
  å: "aa",
  ä: "ae",
  ö: "oe",
  ü: "ue",
  ß: "ss",
};

/** Lowercase, strip decoration and punctuation, collapse whitespace. */
export function normalizeVenueName(input: string): string {
  let text = input.toLowerCase();

  // Quotation marks the source loves: «Hullet i veggen» and "Fakta om makta".
  text = text.replace(/[«»"”“'’`]/g, " ");
  // Parenthetical asides are usually an address or a district, not part of the name.
  text = text.replace(/\([^)]*\)/g, " ");

  let transliterated = "";
  for (const char of text) transliterated += TRANSLITERATION[char] ?? char;

  return transliterated
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " og ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s{2,}/g, " ");
}

export function tokens(input: string, dropGeneric = false): string[] {
  return normalizeVenueName(input)
    .split(" ")
    .filter((word) => word.length > 0 && !NOISE_WORDS.has(word))
    // Single characters are never the identity of a place, but they do survive
    // punctuation stripping: "Dr. Jekyll's Pub" leaves an "s" and "Pane e Vino" an "e".
    // Left in, they look like distinctive extra words and block otherwise clean matches.
    .filter((word) => word.length > 1)
    .filter((word) => !dropGeneric || !GENERIC_WORDS.has(word));
}

/** Sørensen-Dice over character bigrams. Robust to small spelling differences. */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const gram = a.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
  }

  let hits = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const gram = b.slice(i, i + 2);
    const count = bigrams.get(gram) ?? 0;
    if (count > 0) {
      bigrams.set(gram, count - 1);
      hits += 1;
    }
  }

  return (2 * hits) / (a.length - 1 + (b.length - 1));
}

export type MatchKind = "exact" | "strong" | "fuzzy";

export interface NameMatch {
  kind: MatchKind;
  score: number;
}

/** Below this, two names are considered unrelated. Tuned to reject "Bar 1" vs "Bar 9". */
const FUZZY_THRESHOLD = 0.82;

/**
 * Stricter bar for the "distinctive part only" comparison.
 *
 * Once generic words are stripped, a name can shrink to a single token, and two unrelated
 * single tokens are far too easy to score highly: "Kjøkkenet (Rockefeller)" reduces to
 * "kjokkenet" and scored 0.86 against "Kjøkken og Bar" - a different venue entirely.
 * Full-string comparison keeps the looser threshold because it has more to go on.
 */
const CORE_FUZZY_THRESHOLD = 0.9;

export interface MatchContext {
  /**
   * Place words that legitimately appear as a *suffix* on an OSM name to disambiguate a
   * chain - the kommune and the source's own place name. "Grand Hotel" in Egersund really
   * is "Grand hotell Egersund"; it is not "Grand Cafe".
   */
  placeWords?: string[];
}

function isPlaceContext(word: string, context: MatchContext | undefined): boolean {
  if (GENERIC_WORDS.has(word) || NOISE_WORDS.has(word)) return true;
  for (const place of context?.placeWords ?? []) {
    for (const token of tokens(place)) {
      if (token === word) return true;
      // "Egersund" the town vs "Eigersund" the kommune - one letter apart, same place.
      if (token.length >= 5 && diceCoefficient(token, word) >= 0.85) return true;
    }
  }
  return false;
}

/**
 * Compares a source venue name with an OSM name.
 *
 * - `exact`  identical once normalized, or identical once generic words are dropped.
 * - `strong` one name contains the other, subject to the asymmetry rule below.
 * - `fuzzy`  high character-bigram similarity.
 */
export function matchVenueName(
  sourceName: string,
  osmName: string,
  context?: MatchContext,
): NameMatch | null {
  const a = normalizeVenueName(sourceName);
  const b = normalizeVenueName(osmName);
  if (!a || !b) return null;

  if (a === b) return { kind: "exact", score: 1 };

  const aTokens = tokens(sourceName, true);
  const bTokens = tokens(osmName, true);
  const aCore = aTokens.join(" ");
  const bCore = bTokens.join(" ");
  if (!aCore || !bCore) return null;
  if (aCore === bCore) return { kind: "exact", score: 0.98 };

  // Norwegian and English both compound freely: "Flyfisher" and "The Fly Fisher" are one
  // pub, and "Brød og Sirkus" / "Brødogsirkus" one cafe. Whitespace carries no meaning.
  if (aCore.replace(/ /g, "") === bCore.replace(/ /g, "")) {
    return { kind: "exact", score: 0.97 };
  }

  const strong = containmentMatch(aTokens, bTokens, context);
  if (strong) return strong;

  const score = diceCoefficient(a, b);
  if (score >= FUZZY_THRESHOLD) return { kind: "fuzzy", score };

  const coreScore = diceCoefficient(aCore, bCore);
  if (coreScore >= CORE_FUZZY_THRESHOLD) return { kind: "fuzzy", score: coreScore };

  return null;
}

/**
 * Containment, with a deliberate asymmetry that reflects how the two sides go wrong.
 *
 * Extra words on the *source* side are almost always the volunteer adding location
 * context: "Lincoln Pub, Torshov", "Postkontoret på Tøyen", "Fryd Løren". Dropping them
 * is safe.
 *
 * Extra words on the *OSM* side change which business we are talking about, and this is
 * where the ladder produced its worst answers on the first live run: "Bølgen Kro" matched
 * "Bølgen & Moi", and "Hinna Bistro" matched "Dolly Dimples Hinna" - both share exactly
 * one common token and are different venues. So extra OSM words are only tolerated when
 * they are generic ("Glasset" / "Glasset Vinbar") or place context ("Skatten" /
 * "Skatten Oslo").
 */
function containmentMatch(
  aTokens: string[],
  bTokens: string[],
  context: MatchContext | undefined,
): NameMatch | null {
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);

  const sourceCoversOsm = bTokens.every((word) => aSet.has(word));
  const osmCoversSource = aTokens.every((word) => bSet.has(word));

  // Source is the longer side: the extra words are the volunteer's location context.
  if (sourceCoversOsm && bTokens.length > 0) {
    if (isDistinctive(bTokens, context)) return { kind: "strong", score: 0.9 };
  }

  // OSM is the longer side: every extra word must be generic or place context.
  if (osmCoversSource && aTokens.length > 0) {
    const extra = bTokens.filter((word) => !aSet.has(word));
    if (extra.every((word) => isPlaceContext(word, context)) && isDistinctive(aTokens, context)) {
      return { kind: "strong", score: 0.9 };
    }
  }

  return null;
}

/**
 * Is what the two names have in common actually about *this* venue?
 *
 * Both source and OSM names carry the place name surprisingly often, and if that is the
 * only thing they share the match is worthless. The live run produced the clearest
 * possible demonstration: "Heim Jessheim", "O'Connors Jessheim" and "Peppes Jessheim" all
 * landed on the same "Jessheim pizzeria", because "jessheim" was the shared token every
 * time. Three different pubs, one wrong coordinate each.
 */
function isDistinctive(shared: string[], context: MatchContext | undefined): boolean {
  if (shared.join(" ").length < 4) return false;
  return shared.some((word) => !isPlaceContext(word, context));
}

export interface Candidate {
  name: string;
  lat: number;
  lon: number;
  amenity?: string;
}

export interface BestMatch<T extends Candidate> {
  candidate: T;
  match: NameMatch;
  /** True when a second, different candidate matched just as well. */
  ambiguous: boolean;
}

const KIND_RANK: Record<MatchKind, number> = { exact: 3, strong: 2, fuzzy: 1 };

/**
 * Two candidates closer together than this are treated as the same physical place.
 * OpenStreetMap routinely holds both a node and a building way for one pub.
 */
const SAME_PLACE_METRES = 250;

function metresBetween(a: Candidate, b: Candidate): number {
  const R = 6_371_000;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Picks the best candidate, and flags the case where two *different locations* match
 * equally well.
 *
 * Ambiguity is measured by distance, not by name. Chains are the whole reason it exists:
 * "O'Learys" and "Samfundet" have branches in several towns and sometimes two inside one
 * kommune, and those rivals have *identical* names - so comparing names would miss
 * precisely the case that matters. Meanwhile two OSM records of the same building do
 * share a name and must not be flagged.
 */
export function bestMatch<T extends Candidate>(
  sourceName: string,
  candidates: T[],
  context?: MatchContext,
): BestMatch<T> | null {
  const scored: Array<{ candidate: T; match: NameMatch }> = [];
  for (const candidate of candidates) {
    const match = matchVenueName(sourceName, candidate.name, context);
    if (match) scored.push({ candidate, match });
  }
  if (scored.length === 0) return null;

  scored.sort(
    (x, y) =>
      KIND_RANK[y.match.kind] - KIND_RANK[x.match.kind] || y.match.score - x.match.score,
  );

  const top = scored[0];
  if (!top) return null;

  const rival = scored.find(
    (row) =>
      row !== top &&
      KIND_RANK[row.match.kind] === KIND_RANK[top.match.kind] &&
      Math.abs(row.match.score - top.match.score) < 0.02 &&
      metresBetween(row.candidate, top.candidate) > SAME_PLACE_METRES,
  );

  return { candidate: top.candidate, match: top.match, ambiguous: Boolean(rival) };
}
