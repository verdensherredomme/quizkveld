import fs from "node:fs/promises";
import path from "node:path";
import { getKommune, listKommuner, searchStedsnavn } from "./geonorge.js";
import { indexRegister, resolvePlace, stripPlaceQualifier, type RegisterIndex } from "./kommune.js";
import { PATHS } from "./paths.js";
import {
  KommuneAliasSchema,
  KommuneRegisterSchema,
  type Kommune,
  type KommuneAliases,
  type KommuneRegister,
} from "./schema.js";

/**
 * Loading, refreshing and applying the official kommune register.
 *
 * The register is committed to the repo rather than fetched at build time: it changes a
 * handful of times per decade, and neither the daily job nor a site build should fall
 * over because Kartverket is having a bad morning.
 */

const REGISTER_SOURCE = "https://ws.geonorge.no/kommuneinfo/v1/kommuner";

/**
 * Written to the top of the alias file on every save. Zod strips unknown keys, so this
 * is inert as far as the pipeline is concerned - it exists for whoever opens the file.
 */
const ALIAS_FILE_NOTE = [
  "Kildens stedsnavn -> offisiell kommune. Generert av `pnpm pipeline kommuner`.",
  "method: exact = navnet er en kommune. normalized = kommune etter a ha fjernet",
  "en presisering. stedsnavn = slatt opp i Kartverkets stedsnavnregister.",
  "manual = handkuratert; disse overskrives aldri av den automatiske kjoringen.",
  "Stedsnavn som ikke lar seg avklare far bevisst ingen rad her, slik at de blir",
  "forsokt pa nytt ved neste kjoring hvis Kartverket far dem inn.",
];

export async function loadRegister(file: string = PATHS.kommuner): Promise<KommuneRegister> {
  const text = await fs.readFile(file, "utf8");
  return KommuneRegisterSchema.parse(JSON.parse(text));
}

export async function loadAliases(file: string = PATHS.kommuneAlias): Promise<KommuneAliases> {
  try {
    const text = await fs.readFile(file, "utf8");
    return KommuneAliasSchema.parse(JSON.parse(text));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { aliases: {} };
    throw error;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function saveAliases(
  aliases: KommuneAliases,
  file: string = PATHS.kommuneAlias,
): Promise<void> {
  const sorted: KommuneAliases["aliases"] = {};
  for (const key of Object.keys(aliases.aliases).sort((a, b) => a.localeCompare(b, "nb"))) {
    const entry = aliases.aliases[key];
    if (entry) sorted[key] = entry;
  }
  await writeJson(file, { _note: ALIAS_FILE_NOTE, aliases: sorted });
}

/** Fetches all 350-odd kommuner with their bounding box and interior point. */
export async function fetchRegister(
  onProgress?: (done: number, total: number) => void,
): Promise<KommuneRegister> {
  const list = await listKommuner();
  const kommuner: Kommune[] = [];

  for (const [index, item] of list.entries()) {
    const detail = await getKommune(item.kommunenummer);
    if (detail) kommuner.push(detail);
    onProgress?.(index + 1, list.length);
  }

  kommuner.sort((a, b) => a.nr.localeCompare(b.nr));
  return {
    fetchedAt: new Date().toISOString(),
    source: REGISTER_SOURCE,
    kommuner,
  };
}

export async function saveRegister(
  register: KommuneRegister,
  file: string = PATHS.kommuner,
): Promise<void> {
  await writeJson(file, register);
}

export interface AliasResolution {
  resolved: number;
  alreadyKnown: number;
  unresolved: Array<{ place: string; fylke: string; reason: string; candidates: string[] }>;
}

export interface PlaceInput {
  place: string;
  fylke: string;
}

/**
 * Resolves every distinct source place name to an official kommune.
 *
 * Hand-curated entries (`method: "manual"`) are never overwritten - they are the whole
 * point of the file. Anything the automatic pass cannot resolve *confidently* is reported
 * rather than guessed.
 */
export async function resolveAliases(
  places: PlaceInput[],
  register: KommuneRegister,
  existing: KommuneAliases,
  onProgress?: (place: string, outcome: string) => void,
): Promise<{ aliases: KommuneAliases; report: AliasResolution }> {
  const index: RegisterIndex = indexRegister(register.kommuner);
  const aliases: KommuneAliases = { aliases: { ...existing.aliases } };
  const report: AliasResolution = { resolved: 0, alreadyKnown: 0, unresolved: [] };

  const seen = new Set<string>();
  for (const { place, fylke } of places) {
    if (seen.has(place)) continue;
    seen.add(place);

    const known = aliases.aliases[place];
    if (known) {
      report.alreadyKnown += 1;
      continue;
    }

    // First pass without the place-name register: an exact kommune match needs no call.
    let outcome = resolvePlace({ place, fylke, index });

    if (!outcome.ok) {
      // Search the name as written first; if the source added a human disambiguator
      // ("Bø i Telemark") the place-name register will not know it, so retry stripped.
      let hits = await searchStedsnavn(place);
      const stripped = stripPlaceQualifier(place);
      if (hits.length === 0 && stripped !== place) {
        hits = await searchStedsnavn(stripped);
      }
      outcome = resolvePlace({
        place,
        fylke,
        index,
        stedsnavn: hits.map((hit) => ({
          navn: hit.navn,
          type: hit.type,
          kommunenummer: hit.kommunenummer,
        })),
      });
    }

    if (outcome.ok) {
      aliases.aliases[place] = outcome.entry;
      report.resolved += 1;
      onProgress?.(place, `${outcome.entry.kommuneName} (${outcome.entry.method})`);
    } else {
      report.unresolved.push({
        place,
        fylke,
        reason: outcome.reason,
        candidates: outcome.candidates,
      });
      onProgress?.(place, `uavklart: ${outcome.reason}`);
    }
  }

  return { aliases, report };
}
