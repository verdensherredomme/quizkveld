import { cleanCategory, normalizeCategories, primaryCategory } from "./category.js";
import { parseRecurrence, parseWeekday } from "./recurrence.js";
import { makeUnique, quizId, venueId } from "./slug.js";
import { normalizeTime } from "./time.js";
import { cleanVenue } from "./venue.js";
import type { ParseResult, Quiz, RawRow, Venue } from "./schema.js";

export interface NormalizeResult {
  venues: Venue[];
  quizzes: Quiz[];
  sourceUpdatedAt: string | null;
  warnings: string[];
}

function collapse(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Turns raw scraped rows into the typed model.
 *
 * `today` is injectable so tests can pin `lastSeen` and produce stable snapshots.
 */
export function normalizeRows(
  parsed: ParseResult,
  today: Date = new Date(),
): NormalizeResult {
  const warnings = [...parsed.warnings];
  const venues = new Map<string, Venue>();
  const quizzes: Quiz[] = [];
  const takenQuizIds = new Set<string>();
  const lastSeen = isoDate(today);

  for (const row of parsed.rows) {
    const kommune = collapse(row.city);
    const fylke = collapse(row.fylke);
    if (!kommune || !fylke) {
      warnings.push(
        `Hoppet over rad uten kommune eller fylke: ${collapse(row.venueRaw) || "(uten navn)"}`,
      );
      continue;
    }

    const cleaned = cleanVenue(row.venueRaw);
    if (!cleaned.name) {
      warnings.push(`Hoppet over rad der stedsnavnet ble tomt etter vasking (${kommune}).`);
      continue;
    }

    const vId = venueId(kommune, cleaned.name);
    const existing = venues.get(vId);
    if (existing) {
      // Later rows may carry a url or an address hint the first one lacked.
      if (!existing.url && row.venueUrl) {
        existing.url = row.venueUrl;
        // The flag describes this url, so it has to travel with it rather than be set
        // independently - otherwise a later good link inherits an earlier dead one's mark.
        if (row.venueUrlBroken) existing.urlBroken = true;
      }
      if (!existing.addressHint && cleaned.addressHint) {
        existing.addressHint = cleaned.addressHint;
      }
    } else {
      const venue: Venue = {
        id: vId,
        name: cleaned.name,
        rawName: row.venueRaw,
        kommune,
        fylke,
      };
      if (cleaned.addressHint) venue.addressHint = cleaned.addressHint;
      if (row.venueUrl) {
        venue.url = row.venueUrl;
        if (row.venueUrlBroken) venue.urlBroken = true;
      }
      venues.set(vId, venue);
    }

    const time = normalizeTime(row.timeRaw);
    const weekday = parseWeekday(row.weekdayRaw);
    const recurrence = parseRecurrence(row.weekdayRaw);
    const category = cleanCategory(row.categoryRaw);

    quizzes.push({
      id: makeUnique(quizId(kommune, cleaned.name, weekday, time), takenQuizIds, [
        recurrence.kind,
        primaryCategory(category),
      ]),
      venueId: vId,
      weekday,
      time,
      recurrence,
      category,
      categoryNorm: normalizeCategories(category),
      lastSeen,
    });
  }

  return {
    venues: [...venues.values()].sort(byId),
    quizzes: quizzes.sort(byId),
    sourceUpdatedAt: parsed.sourceUpdatedAt,
    warnings,
  };
}

/**
 * Ids are pure ASCII after slugging, so a plain codepoint comparison is used rather than
 * `localeCompare`, which would make the output depend on the machine's locale.
 */
export function byId(a: { id: string }, b: { id: string }): number {
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export type { RawRow };
