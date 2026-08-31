#!/usr/bin/env node
import fs from "node:fs/promises";
import {
  DEFAULT_MAX_ID_CHURN,
  DEFAULT_MIN_ROWS,
  SafetyRailError,
  build,
  writeQuizData,
} from "./build.js";
import { GeoCache, runGeocode } from "./geocode.js";
import {
  fetchRegister,
  loadAliases,
  loadRegister,
  resolveAliases,
  saveAliases,
  saveRegister,
} from "./kommuneregister.js";
import { normalizeRows } from "./normalize.js";
import { parse } from "./parse.js";
import { PATHS } from "./paths.js";
import { scrape } from "./scrape.js";
import type { QuizData } from "./schema.js";

type Step = "scrape" | "parse" | "normalize" | "kommuner" | "geocode" | "build" | "all";
const STEPS: Step[] = [
  "scrape",
  "parse",
  "normalize",
  "kommuner",
  "geocode",
  "build",
  "all",
];

interface Flags {
  force: boolean;
  minRows: number;
  maxIdChurn: number;
  skipScrape: boolean;
  refreshRegister: boolean;
  onlyNew: boolean;
  limit: number | null;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    force: false,
    minRows: DEFAULT_MIN_ROWS,
    maxIdChurn: DEFAULT_MAX_ID_CHURN,
    skipScrape: false,
    refreshRegister: false,
    onlyNew: false,
    limit: null,
  };

  for (const arg of argv) {
    if (arg === "--force") flags.force = true;
    else if (arg === "--skip-scrape") flags.skipScrape = true;
    else if (arg === "--refresh-register") flags.refreshRegister = true;
    else if (arg === "--only-new") flags.onlyNew = true;
    else if (arg.startsWith("--limit=")) {
      const value = Number(arg.slice("--limit=".length));
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`Ugyldig verdi for --limit: ${arg}`);
      }
      flags.limit = value;
    } else if (arg.startsWith("--min-rows=")) {
      const value = Number(arg.slice("--min-rows=".length));
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Ugyldig verdi for --min-rows: ${arg}`);
      }
      flags.minRows = value;
    } else if (arg.startsWith("--max-id-churn=")) {
      const value = Number(arg.slice("--max-id-churn=".length));
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`Ugyldig verdi for --max-id-churn (0-1): ${arg}`);
      }
      flags.maxIdChurn = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`Ukjent flagg: ${arg}`);
    }
  }

  return flags;
}

function usage(): string {
  return [
    "Bruk: pnpm pipeline <steg> [flagg]",
    "",
    "Steg:",
    "  scrape      Hent kildesiden og lagre den til raw/latest.html",
    "  parse       Les raw/latest.html og skriv ut en oppsummering av radene",
    "  normalize   Parse + normaliser, og skriv ut fordelinger",
    "  kommuner    Oppdater kommune-aliastabellen mot Kartverket",
    "  geocode     Kjor geokodingsstigen",
    "  build       Bygg data/quizzes.json med overstyringer og sikkerhetssjekker",
    "  all         scrape -> build -> geocode",
    "",
    "Flagg:",
    "  --force              Overstyr sikkerhetssjekkene (ikke skjemavalidering)",
    "  --min-rows=N         Minste antall quizer for byggingen feiler (standard 250)",
    "  --max-id-churn=0.1   Storste tillatte andel endrede id-er (standard 0.1)",
    "  --skip-scrape        For 'all': bruk eksisterende raw/latest.html",
    "  --refresh-register   For 'kommuner': hent kommuneregisteret pa nytt",
    "  --only-new           For 'geocode': bare steder som mangler i cachen",
    "  --limit=N            For 'geocode': stopp etter N nye oppslag",
  ].join("\n");
}

function tally(values: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

function printTally(label: string, values: string[]): void {
  console.log(`\n${label}:`);
  for (const [key, count] of tally(values)) {
    console.log(`  ${key.padEnd(16)} ${count}`);
  }
}

function printWarnings(warnings: string[]): void {
  if (warnings.length === 0) return;
  console.log(`\nAdvarsler (${warnings.length}):`);
  for (const warning of warnings.slice(0, 20)) console.log(`  - ${warning}`);
  if (warnings.length > 20) console.log(`  ... og ${warnings.length - 20} til`);
}

async function runScrape(): Promise<void> {
  const result = await scrape();
  console.log(
    `Hentet kildesiden (${result.bytes} bytes) -> raw/latest.html` +
      (result.changed ? " (endret)" : " (uendret)"),
  );
}

async function runParse(): Promise<void> {
  const parsed = await parse();
  console.log(`Sist oppdatert hos kilden: ${parsed.sourceUpdatedAt ?? "ukjent"}`);
  console.log(`Antall rader: ${parsed.rows.length}`);
  printTally(
    "Rader per fylke",
    parsed.rows.map((row) => row.fylke),
  );
  printWarnings(parsed.warnings);
}

async function runNormalize(): Promise<void> {
  const parsed = await parse();
  const normalized = normalizeRows(parsed);
  console.log(`Steder: ${normalized.venues.length}`);
  console.log(`Quizer: ${normalized.quizzes.length}`);
  printTally(
    "Gjentakelse",
    normalized.quizzes.map((quiz) => quiz.recurrence.kind),
  );
  // A quiz can name several genres, so these buckets deliberately overlap and will sum
  // to more than the number of quizzes.
  printTally(
    "Kategori (en quiz kan telle i flere)",
    normalized.quizzes.flatMap((quiz) => quiz.categoryNorm),
  );
  const multiGenre = normalized.quizzes.filter((quiz) => quiz.categoryNorm.length > 1).length;
  console.log(`Quizer med mer enn en sjanger: ${multiGenre}`);
  const withAddress = normalized.venues.filter((venue) => venue.addressHint).length;
  console.log(`\nSteder med adressehint: ${withAddress} av ${normalized.venues.length}`);
  const withoutTime = normalized.quizzes.filter((quiz) => quiz.time === null).length;
  console.log(`Quizer uten klokkeslett: ${withoutTime}`);
  printWarnings(normalized.warnings);
}

async function runGeocodeStep(flags: Flags): Promise<void> {
  const data = JSON.parse(await fs.readFile(PATHS.quizzes, "utf8")) as QuizData;
  const cache = await GeoCache.load();

  const venues = flags.onlyNew ? data.venues.filter((v) => !cache.has(v.id)) : data.venues;
  console.log(`Geokoder ${venues.length} steder (cache har ${cache.size} fra for) ...`);

  const stats = await runGeocode(venues, {
    cache,
    limit: flags.limit,
    log: (message) => console.log(message),
  });

  console.log(
    `\nGeokoding: ${stats.total} steder, ${stats.cached} fra cache, ` +
      `${stats.resolved} nye, ${stats.unresolved} uten treff.`,
  );

  if (Object.keys(stats.bySource).length > 0) {
    console.log("\nKilde:");
    for (const [source, count] of Object.entries(stats.bySource).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${source.padEnd(12)} ${count}`);
    }
    console.log("Sikkerhet:");
    for (const [level, count] of Object.entries(stats.byConfidence).sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`  ${level.padEnd(12)} ${count}`);
    }
  }

  if (stats.rejected.length > 0) {
    console.log(`\nForkastet fordi koordinaten havnet i feil kommune (${stats.rejected.length}):`);
    for (const item of stats.rejected.slice(0, 25)) console.log(`  - ${item}`);
    if (stats.rejected.length > 25) console.log(`  ... og ${stats.rejected.length - 25} til`);
  }

  if (stats.lowConfidence.length > 0) {
    console.log(`\nBare kommunesentrum (lav sikkerhet, ${stats.lowConfidence.length}):`);
    for (const item of stats.lowConfidence.slice(0, 40)) console.log(`  - ${item}`);
    if (stats.lowConfidence.length > 40) {
      console.log(`  ... og ${stats.lowConfidence.length - 40} til`);
    }
  }

  if (stats.missing.length > 0) {
    console.log(`\nUten koordinat i det hele tatt (${stats.missing.length}):`);
    for (const item of stats.missing) console.log(`  - ${item}`);
  }
}

async function runKommuner(flags: Flags): Promise<void> {
  let register;
  if (flags.refreshRegister) {
    console.log("Henter kommuneregisteret fra Kartverket ...");
    register = await fetchRegister((done, total) => {
      if (done % 50 === 0 || done === total) console.log(`  ${done}/${total}`);
    });
    await saveRegister(register);
    console.log(`Skrev data/kommuner.json (${register.kommuner.length} kommuner)`);
  } else {
    register = await loadRegister();
    console.log(
      `Leste data/kommuner.json (${register.kommuner.length} kommuner, hentet ${register.fetchedAt.slice(0, 10)})`,
    );
  }

  const parsed = await parse();
  const normalized = normalizeRows(parsed);
  const places = normalized.venues.map((venue) => ({
    place: venue.kommune,
    fylke: venue.fylke,
  }));

  const existing = await loadAliases();
  const { aliases, report } = await resolveAliases(places, register, existing);
  await saveAliases(aliases);

  const distinct = new Set(places.map((p) => p.place)).size;
  console.log(`\nStedsnavn i kilden: ${distinct}`);
  console.log(`  Allerede i tabellen: ${report.alreadyKnown}`);
  console.log(`  Lost automatisk na: ${report.resolved}`);
  console.log(`  Uavklart: ${report.unresolved.length}`);

  const byMethod = new Map<string, number>();
  for (const entry of Object.values(aliases.aliases)) {
    byMethod.set(entry.method, (byMethod.get(entry.method) ?? 0) + 1);
  }
  console.log("\nMetode:");
  for (const [method, count] of [...byMethod].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${method.padEnd(12)} ${count}`);
  }

  if (report.unresolved.length > 0) {
    console.log(`\nMa handkurateres i data/kommune-alias.json:`);
    for (const item of report.unresolved) {
      console.log(`  - ${item.place} [${item.fylke}]: ${item.reason}`);
      for (const candidate of item.candidates.slice(0, 4)) {
        console.log(`      kandidat: ${candidate}`);
      }
    }
  }
}

async function runBuild(flags: Flags): Promise<void> {
  const parsed = await parse();
  const outcome = await build(parsed, {
    force: flags.force,
    minRows: flags.minRows,
    maxIdChurn: flags.maxIdChurn,
  });
  await writeQuizData(outcome.data);

  const { report, data } = outcome;
  console.log(`Skrev data/quizzes.json`);
  console.log(`  Steder: ${report.venueCount} (${report.staleVenues} markert utgatt)`);
  console.log(`  Quizer: ${report.quizCount} (${report.staleQuizzes} markert utgatt)`);
  console.log(`  Nye id-er: ${report.newIds.length}, forsvunnet: ${report.removedIds.length}`);
  console.log(`  Id-endring: ${(report.idChurn * 100).toFixed(1)} %`);
  console.log(`  Sist oppdatert hos kilden: ${data.sourceUpdatedAt ?? "ukjent"}`);
  if (report.railsTripped.length > 0) {
    console.log(`\nSikkerhetssjekker utlost, men overstyrt med --force:`);
    for (const rail of report.railsTripped) console.log(`  - ${rail}`);
  }
  printWarnings(report.warnings);
}

async function main(): Promise<void> {
  const [, , stepArg, ...rest] = process.argv;

  if (!stepArg || stepArg === "--help" || stepArg === "-h") {
    console.log(usage());
    process.exit(stepArg ? 0 : 1);
  }

  if (!STEPS.includes(stepArg as Step)) {
    console.error(`Ukjent steg: ${stepArg}\n`);
    console.error(usage());
    process.exit(1);
  }

  const step = stepArg as Step;
  const flags = parseFlags(rest);

  switch (step) {
    case "scrape":
      await runScrape();
      break;
    case "parse":
      await runParse();
      break;
    case "normalize":
      await runNormalize();
      break;
    case "kommuner":
      await runKommuner(flags);
      break;
    case "geocode":
      await runGeocodeStep(flags);
      break;
    case "build":
      await runBuild(flags);
      break;
    case "all":
      if (!flags.skipScrape) await runScrape();
      await runBuild(flags);
      await runGeocodeStep(flags);
      break;
  }
}

main().catch((error: unknown) => {
  if (error instanceof SafetyRailError) {
    console.error(`\n${error.message}`);
    process.exit(2);
  }
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
