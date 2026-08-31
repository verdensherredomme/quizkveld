import fs from "node:fs/promises";
import path from "node:path";
import { GeoCache } from "./geocode.js";
import { loadAliases } from "./kommuneregister.js";
import { byId, normalizeRows, type NormalizeResult } from "./normalize.js";
import { PATHS } from "./paths.js";
import {
  OverridesSchema,
  QuizDataSchema,
  type KommuneAliases,
  type Overrides,
  type ParseResult,
  type Quiz,
  type QuizData,
  type Venue,
} from "./schema.js";

/**
 * Fewer rows than this means the parser almost certainly broke.
 *
 * The live page holds ~350 quizzes (not the 600-900 originally assumed), so a floor of
 * 300 would leave only ~15 % headroom and misfire whenever venues close for the summer.
 * 250 is roughly 70 % of the real count: low enough not to cry wolf, high enough that a
 * structural break in the parser cannot slip past.
 */
export const DEFAULT_MIN_ROWS = 250;

/** More id churn than this means the source was redesigned under us. */
export const DEFAULT_MAX_ID_CHURN = 0.1;

export class SafetyRailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyRailError";
  }
}

export interface BuildOptions {
  minRows?: number;
  maxIdChurn?: number;
  /** Bypasses the row-count and id-churn rails. Schema validation is never bypassed. */
  force?: boolean;
  /** Injected for deterministic tests. */
  now?: Date;
  previous?: QuizData | null;
  overrides?: Overrides;
  geocache?: GeoCache | null;
  /** Source place name -> official kommune. Null skips kommune resolution entirely. */
  aliases?: KommuneAliases | null;
}

export interface BuildReport {
  rowCount: number;
  venueCount: number;
  quizCount: number;
  newIds: string[];
  removedIds: string[];
  staleQuizzes: number;
  staleVenues: number;
  idChurn: number;
  railsTripped: string[];
  warnings: string[];
}

export interface BuildOutcome {
  data: QuizData;
  report: BuildReport;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function readJsonIfExists<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new Error(`Kunne ikke lese ${file}: ugyldig JSON.`);
    }
    throw error;
  }
}

export async function loadOverrides(file: string = PATHS.overrides): Promise<Overrides> {
  const raw = await readJsonIfExists<unknown>(file);
  if (raw === null) return { venues: {}, quizzes: {} };
  return OverridesSchema.parse(raw);
}

/**
 * Applies a partial override on top of a record. Every key present in the override wins,
 * including explicit nulls; keys set to `undefined` are ignored so an override file never
 * has to repeat unrelated fields.
 */
function applyOverride<T extends object>(base: T, override: Partial<T> | undefined): T {
  if (!override) return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

export function mergeData(
  normalized: NormalizeResult,
  options: BuildOptions = {},
): BuildOutcome {
  const now = options.now ?? new Date();
  const previous = options.previous ?? null;
  const overrides = options.overrides ?? { venues: {}, quizzes: {} };
  const geocache = options.geocache ?? null;
  const aliases = options.aliases ?? null;
  const today = isoDate(now);
  const warnings = [...normalized.warnings];

  const currentQuizIds = new Set(normalized.quizzes.map((quiz) => quiz.id));
  const currentVenueIds = new Set(normalized.venues.map((venue) => venue.id));

  const venues = new Map<string, Venue>();
  for (const venue of normalized.venues) {
    let next: Venue = { ...venue };

    // Official kommune, when the alias table knows this place name. The source's own
    // spelling is deliberately left in `kommune`: people search for "Greaaker", not
    // "Sarpsborg".
    const alias = aliases?.aliases[venue.kommune];
    if (alias) {
      if (alias.kommuneNr) next.kommuneNr = alias.kommuneNr;
      if (alias.kommuneName) next.kommuneName = alias.kommuneName;
      if (alias.fylkeNow) next.fylkeNow = alias.fylkeNow;
    }

    // Geocache first, then manual overrides, so a hand-placed pin always wins.
    const geo = geocache?.get(venue.id);
    if (geo) {
      next.lat = geo.lat;
      next.lon = geo.lon;
      next.geoSource = geo.geoSource;
      next.geoConfidence = geo.geoConfidence;
    }

    next = applyOverride(next, overrides.venues[venue.id]);
    delete next.stale;
    venues.set(next.id, next);
  }

  const quizzes = new Map<string, Quiz>();
  for (const quiz of normalized.quizzes) {
    let next: Quiz = { ...quiz, lastSeen: today };
    next = applyOverride(next, overrides.quizzes[quiz.id]);
    delete next.stale;
    quizzes.set(next.id, next);
  }

  // Soft-delete: anything that was in the previous build but is gone now is kept with its
  // old lastSeen and flagged stale, rather than dropped.
  const removedIds: string[] = [];
  if (previous) {
    for (const venue of previous.venues) {
      if (currentVenueIds.has(venue.id)) continue;
      venues.set(venue.id, applyOverride<Venue>({ ...venue, stale: true }, overrides.venues[venue.id]));
    }
    for (const quiz of previous.quizzes) {
      if (currentQuizIds.has(quiz.id)) continue;
      removedIds.push(quiz.id);
      quizzes.set(quiz.id, applyOverride<Quiz>({ ...quiz, stale: true }, overrides.quizzes[quiz.id]));
    }
  }

  const previousLiveIds = new Set(
    (previous?.quizzes ?? []).filter((quiz) => !quiz.stale).map((quiz) => quiz.id),
  );
  const newIds = [...currentQuizIds].filter((id) => !previousLiveIds.has(id));

  const data: QuizData = {
    generatedAt: now.toISOString(),
    sourceUpdatedAt: normalized.sourceUpdatedAt,
    venues: [...venues.values()].sort(byId),
    quizzes: [...quizzes.values()].sort(byId),
  };

  // If nothing but the timestamp would change, keep the previous one. Otherwise every
  // scheduled run produces a one-line diff and the daily job commits pure noise forever.
  if (previous && isSameExceptGeneratedAt(previous, data)) {
    data.generatedAt = previous.generatedAt;
  }

  const changedIds = new Set([...newIds, ...removedIds]);
  // Measured against the larger of the two sets so the figure stays a meaningful
  // percentage even when the dataset grows or shrinks dramatically.
  const denominator = Math.max(previousLiveIds.size, currentQuizIds.size);
  const idChurn =
    previousLiveIds.size === 0 || denominator === 0 ? 0 : changedIds.size / denominator;

  const report: BuildReport = {
    rowCount: normalized.quizzes.length,
    venueCount: data.venues.length,
    quizCount: data.quizzes.length,
    newIds,
    removedIds,
    staleQuizzes: data.quizzes.filter((quiz) => quiz.stale).length,
    staleVenues: data.venues.filter((venue) => venue.stale).length,
    idChurn,
    railsTripped: [],
    warnings,
  };

  return { data, report };
}

export function checkSafetyRails(report: BuildReport, options: BuildOptions = {}): void {
  const minRows = options.minRows ?? DEFAULT_MIN_ROWS;
  const maxIdChurn = options.maxIdChurn ?? DEFAULT_MAX_ID_CHURN;
  const tripped: string[] = [];

  if (report.rowCount < minRows) {
    tripped.push(
      `Fant bare ${report.rowCount} quizer (minimum ${minRows}). Kilden har trolig endret struktur.`,
    );
  }

  if (report.idChurn > maxIdChurn) {
    tripped.push(
      `${(report.idChurn * 100).toFixed(1)} % av id-ene endret seg (grense ${(maxIdChurn * 100).toFixed(0)} %). ` +
        `${report.newIds.length} nye, ${report.removedIds.length} forsvunnet.`,
    );
  }

  report.railsTripped = tripped;

  if (tripped.length > 0 && !options.force) {
    throw new SafetyRailError(
      `Sikkerhetssjekk feilet:\n  - ${tripped.join("\n  - ")}\n` +
        `Kjor med --force (eller --min-rows=N) hvis endringen er reell.`,
    );
  }
}

/** Serializes with sorted arrays and stable indentation so git diffs stay reviewable. */
export function serialize(data: QuizData): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** True when two payloads differ only by their generatedAt timestamp. */
export function isSameExceptGeneratedAt(a: QuizData, b: QuizData): boolean {
  return serialize({ ...a, generatedAt: "" }) === serialize({ ...b, generatedAt: "" });
}

export async function build(
  parsed: ParseResult,
  options: BuildOptions = {},
): Promise<BuildOutcome> {
  const now = options.now ?? new Date();
  const normalized = normalizeRows(parsed, now);

  const previous =
    options.previous !== undefined
      ? options.previous
      : await readJsonIfExists<QuizData>(PATHS.quizzes);
  const overrides = options.overrides ?? (await loadOverrides());
  const geocache =
    options.geocache !== undefined ? options.geocache : await GeoCache.load();
  const aliases = options.aliases !== undefined ? options.aliases : await loadAliases();

  const outcome = mergeData(normalized, {
    ...options,
    now,
    previous,
    overrides,
    geocache,
    aliases,
  });

  // Schema validation runs before the rails and is never bypassable by --force:
  // writing structurally invalid data would break the site outright.
  const validated = QuizDataSchema.safeParse(outcome.data);
  if (!validated.success) {
    const issues = validated.error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n  - ");
    throw new Error(`Utdata er ikke gyldig mot skjemaet:\n  - ${issues}`);
  }

  checkSafetyRails(outcome.report, options);

  return outcome;
}

export async function writeQuizData(
  data: QuizData,
  file: string = PATHS.quizzes,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, serialize(data), "utf8");
}
