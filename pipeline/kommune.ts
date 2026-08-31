import { slug } from "./slug.js";
import type { Kommune, KommuneAliasEntry } from "./schema.js";

/**
 * Resolving the source's place names to official kommuner.
 *
 * The source's "kommune" column is whatever a volunteer typed: sometimes a real kommune
 * ("Bergen"), often a place inside one ("Greaaker" is in Sarpsborg), occasionally a
 * district or a village. Everything here is pure so it can be tested against committed
 * fixtures; the network calls live in geonorge.ts.
 */

/**
 * Pre-2020 fylke names (what the source uses) mapped to today's fylkesnummer.
 *
 * This is a *hint*, not a rule. The 2024 split did not restore the pre-2020 boundaries
 * exactly - Jevnaker went Oppland -> Viken -> Buskerud, not to Innlandet - so a mismatch
 * means "look closer", not "reject". Svalbard is deliberately null: it is not a fylke and
 * has no kommune.
 */
export const LEGACY_FYLKE_TO_NR: Record<string, string | null> = {
  Oslo: "03",
  Rogaland: "11",
  "Møre og Romsdal": "15",
  Nordland: "18",
  Østfold: "31",
  Akershus: "32",
  Buskerud: "33",
  Hedmark: "34",
  Oppland: "34",
  Vestfold: "39",
  Telemark: "40",
  "Aust-Agder": "42",
  "Vest-Agder": "42",
  Hordaland: "46",
  "Sogn og Fjordane": "46",
  "Sør-Trøndelag": "50",
  "Nord-Trøndelag": "50",
  Troms: "55",
  Finnmark: "56",
  Svalbard: null,
};

export function expectedFylkeNr(legacyFylke: string): string | null {
  return LEGACY_FYLKE_TO_NR[legacyFylke.trim()] ?? null;
}

/**
 * How much a Kartverket place type suggests "a place people live and drink in".
 * Higher is better.
 *
 * Farms rank *below* the default on purpose. Norway is covered in farms whose names
 * collide with towns, and they are the classic false positive: "Rygge" is a parish in
 * Moss and also a farm in Indre Østfold, and ranking the farm first silently moved a pub
 * 40 km. An unknown type is more trustworthy than a known farm.
 */
const PLACE_TYPE_RANK: Record<string, number> = {
  By: 100,
  Tettsted: 95,
  Tettbebyggelse: 90,
  Bydel: 85,
  "Del av by": 80,
  Sokn: 75,
  "Annen administrativ inndeling": 70,
  Grend: 60,
  "Bygdelag (bygd)": 58,
  Bygd: 55,
  Boligfelt: 50,
  Kommune: 45,
  Stasjon: 30,
  Kirke: 25,
  Flyplass: 20,
  Øy: 15,
  Gard: 2,
  Navnegard: 1,
};

/** Unknown types sit here: below real settlements, above farms. */
const DEFAULT_PLACE_TYPE_RANK = 35;

export function placeTypeRank(type: string): number {
  return PLACE_TYPE_RANK[type] ?? DEFAULT_PLACE_TYPE_RANK;
}

/**
 * Removes the human disambiguator from a place name: "Bø i Telemark" -> "Bø",
 * "Herøy i Nordland" -> "Herøy", "Nes kommune" -> "Nes". Returns the display form, not a
 * slug, so it can be fed back into a name search.
 */
export function stripPlaceQualifier(name: string): string {
  return name
    .trim()
    .replace(/\s+i\s+[A-ZÆØÅ][^\s]*$/u, "")
    .replace(/\s+kommune$/iu, "")
    .trim();
}

/**
 * Comparison key for place names. Uses the same transliteration as ids so "Ålgård",
 * "aalgaard" and "ÅLGÅRD" all collapse together.
 */
export function normalizePlace(name: string): string {
  return slug(stripPlaceQualifier(name));
}

export interface RegisterIndex {
  byNr: Map<string, Kommune>;
  byName: Map<string, Kommune[]>;
}

export function indexRegister(kommuner: Kommune[]): RegisterIndex {
  const byNr = new Map<string, Kommune>();
  const byName = new Map<string, Kommune[]>();
  for (const kommune of kommuner) {
    byNr.set(kommune.nr, kommune);
    const key = normalizePlace(kommune.navn);
    const bucket = byName.get(key);
    if (bucket) bucket.push(kommune);
    else byName.set(key, [kommune]);
  }
  return { byNr, byName };
}

export interface StedsnavnCandidate {
  navn: string;
  type: string;
  kommunenummer: string;
}

export interface ResolveInput {
  /** The place name exactly as the source wrote it. */
  place: string;
  /** The source's pre-2020 fylke name. */
  fylke: string;
  index: RegisterIndex;
  /** Kartverket Stedsnavn results, or an empty list when we have not looked them up. */
  stedsnavn?: StedsnavnCandidate[];
}

export type ResolveOutcome =
  | { ok: true; entry: KommuneAliasEntry }
  | { ok: false; reason: string; candidates: string[] };

function entryFor(
  kommune: Kommune,
  method: KommuneAliasEntry["method"],
  note?: string,
): KommuneAliasEntry {
  return {
    kommuneNr: kommune.nr,
    kommuneName: kommune.navn,
    fylkeNow: kommune.fylke,
    method,
    ...(note ? { note } : {}),
  };
}

/**
 * Resolves one place name.
 *
 * Order: an exact name match against the official register wins outright. Otherwise we
 * fall back to Kartverket's place-name register, but only accept a hit whose kommune sits
 * in the fylke the source claims. A confidently wrong kommune is worse than an honest
 * blank: it puts a pub in the wrong town, and nothing downstream can tell.
 */
export function resolvePlace(input: ResolveInput): ResolveOutcome {
  const { place, fylke, index } = input;
  const wanted = expectedFylkeNr(fylke);
  const key = normalizePlace(place);

  const direct = index.byName.get(key) ?? [];
  if (direct.length === 1) {
    const only = direct[0];
    if (only) {
      // Exactness is measured on the *unstripped* name. normalizePlace() removes the
      // " i <Fylke>" disambiguator, so comparing normalized forms would call
      // "Bø i Telemark" an exact match for the kommune "Bø" - which is the very mistake
      // this check exists to prevent.
      const exact = slug(only.navn) === slug(place);
      const fylkeAgrees = wanted === null || only.fylkesnr === wanted;

      // An exact kommune-name match is strong enough to stand on its own, even when the
      // fylke disagrees: the 2024 split did not restore the pre-2020 boundaries exactly,
      // so Jevnaker legitimately reads "Oppland" in the source but sits in Buskerud today.
      //
      // A match that only appeared after stripping a disambiguator is *not* strong enough.
      // "Bø i Telemark" normalizes to "Bø", and the only kommune called Bø today is in
      // Nordland - accepting that would move the quiz 900 km. Those fall through to the
      // place-name register, which knows Bø is a tettsted in Midt-Telemark.
      if (exact || fylkeAgrees) {
        const note =
          exact && !fylkeAgrees
            ? `Kilden sier ${fylke}; kommunen ligger i ${only.fylke} etter fylkesendringene.`
            : undefined;
        return { ok: true, entry: entryFor(only, exact ? "exact" : "normalized", note) };
      }
    }
  }
  if (direct.length > 1) {
    // Several kommuner share the name (Våler, Herøy, Bø, Sande, Nes). The fylke decides.
    const inFylke = direct.filter((k) => k.fylkesnr === wanted);
    const first = inFylke[0];
    if (inFylke.length === 1 && first) {
      return {
        ok: true,
        entry: entryFor(first, "normalized", `Flere kommuner heter ${place}; valgt via fylke ${fylke}.`),
      };
    }
    return {
      ok: false,
      reason: `Flere kommuner heter "${place}" og fylket (${fylke}) skiller dem ikke.`,
      candidates: direct.map((k) => `${k.navn} (${k.nr}, ${k.fylke})`),
    };
  }

  const hits = input.stedsnavn ?? [];
  if (hits.length === 0) {
    return { ok: false, reason: `Ingen treff for "${place}".`, candidates: [] };
  }

  const scored = hits
    .map((hit) => ({ hit, kommune: index.byNr.get(hit.kommunenummer) }))
    .filter((row): row is { hit: StedsnavnCandidate; kommune: Kommune } => Boolean(row.kommune))
    .map((row) => ({
      ...row,
      nameExact: normalizePlace(row.hit.navn) === key,
      inFylke: wanted !== null && row.kommune.fylkesnr === wanted,
      rank: placeTypeRank(row.hit.type),
    }))
    .sort(
      (a, b) =>
        Number(b.inFylke) - Number(a.inFylke) ||
        Number(b.nameExact) - Number(a.nameExact) ||
        b.rank - a.rank,
    );

  const best = scored[0];
  if (!best || !best.inFylke || !best.nameExact) {
    return {
      ok: false,
      reason: wanted
        ? `Fant ingen "${place}" i fylket ${fylke}.`
        : `"${place}" ligger i et fylke vi ikke kan utlede (${fylke}).`,
      candidates: scored
        .slice(0, 5)
        .map((row) => `${row.hit.navn} [${row.hit.type}] -> ${row.kommune.navn} (${row.kommune.fylke})`),
    };
  }

  return {
    ok: true,
    entry: entryFor(
      best.kommune,
      "stedsnavn",
      `"${place}" er ${best.hit.type.toLowerCase()} i ${best.kommune.navn}.`,
    ),
  };
}
