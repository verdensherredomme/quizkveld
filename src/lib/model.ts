import type { CategoryNorm, Quiz, Venue, Weekday } from "../../pipeline/schema.js";
import { fylkeOf } from "./place.js";

/** A quiz together with the venue it happens at. The unit everything on the site renders. */
export interface QuizAtVenue {
  quiz: Quiz;
  venue: Venue;
}

/**
 * Joins quizzes to their venues.
 *
 * A quiz whose venue is missing is dropped rather than rendered venue-less, and the count
 * is returned so the caller can fail the build instead of quietly shipping a smaller site.
 * In healthy data `orphans` is always 0.
 */
export function joinQuizzes(
  quizzes: Quiz[],
  venues: Venue[],
): { items: QuizAtVenue[]; orphans: string[] } {
  const byId = new Map(venues.map((venue) => [venue.id, venue]));
  const items: QuizAtVenue[] = [];
  const orphans: string[] = [];

  for (const quiz of quizzes) {
    const venue = byId.get(quiz.venueId);
    if (!venue) {
      orphans.push(quiz.id);
      continue;
    }
    items.push({ quiz, venue });
  }

  return { items, orphans };
}

/**
 * Splits joined rows into the ones the source still lists and the ones it has dropped.
 *
 * The pipeline soft-deletes: a quiz that disappears from the source keeps its id and its
 * old `lastSeen` and gains `stale: true`. Both halves are needed, and for opposite reasons.
 * Stale rows must stay out of every dated view, because "i kveld" pointing at a pub that
 * stopped hosting quizzes is the worst mistake this site can make. But deleting them
 * outright would break `/pub/<id>/` and `/sted/<sted>/` URLs people have already shared,
 * so they still render - clearly marked, never under a date.
 *
 * A venue can go stale while its quizzes have not been marked yet, so both flags count.
 */
export function partitionByFreshness(items: QuizAtVenue[]): {
  fresh: QuizAtVenue[];
  stale: QuizAtVenue[];
} {
  const fresh: QuizAtVenue[] = [];
  const stale: QuizAtVenue[] = [];

  for (const item of items) {
    (item.quiz.stale || item.venue.stale ? stale : fresh).push(item);
  }

  return { fresh, stale };
}

/**
 * Sorts by start time, then venue name.
 *
 * 16 quizzes have `time: null` because the source writes "?" there. They sort last rather
 * than first: treating a missing time as 00:00 would put them at the top of every evening,
 * which reads as "these start first" - the opposite of what is known.
 */
export function byTimeThenName(a: QuizAtVenue, b: QuizAtVenue): number {
  const timeA = a.quiz.time;
  const timeB = b.quiz.time;

  if (timeA === null && timeB !== null) return 1;
  if (timeA !== null && timeB === null) return -1;
  if (timeA !== null && timeB !== null && timeA !== timeB) {
    return timeA < timeB ? -1 : 1;
  }

  return a.venue.name.localeCompare(b.venue.name, "nb");
}

export function sortQuizzes(items: QuizAtVenue[]): QuizAtVenue[] {
  return [...items].sort(byTimeThenName);
}

/**
 * Category filtering is "contains", never equality.
 *
 * `categoryNorm` is an array because 23 rows name more than one genre
 * ("Allmenn/film/musikk"). An equality check would hide those 23 from the music filter,
 * which is exactly the data loss the array exists to prevent.
 */
export function hasCategory(quiz: Quiz, category: CategoryNorm): boolean {
  return quiz.categoryNorm.includes(category);
}

/**
 * Counts per genre.
 *
 * These buckets overlap, so the counts sum to more than the number of quizzes (376 vs 352
 * at the time of writing). That is correct, not a bug, and the UI says so next to the
 * filter rather than leaving people to notice the discrepancy themselves.
 */
export function countByCategory(items: QuizAtVenue[]): Map<CategoryNorm, number> {
  const counts = new Map<CategoryNorm, number>();
  for (const { quiz } of items) {
    for (const category of quiz.categoryNorm) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return counts;
}

export function countByWeekday(items: QuizAtVenue[]): Map<Weekday, number> {
  const counts = new Map<Weekday, number>();
  for (const { quiz } of items) {
    if (quiz.weekday === null) continue;
    counts.set(quiz.weekday, (counts.get(quiz.weekday) ?? 0) + 1);
  }
  return counts;
}

/** Groups while preserving a stable, Norwegian-collated key order. */
export function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = key(item);
    const existing = groups.get(group);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(group, [item]);
    }
  }
  return new Map([...groups].sort(([a], [b]) => a.localeCompare(b, "nb")));
}

export function groupByFylke(items: QuizAtVenue[]): Map<string, QuizAtVenue[]> {
  return groupBy(items, (item) => fylkeOf(item.venue));
}

export function groupBySted(items: QuizAtVenue[]): Map<string, QuizAtVenue[]> {
  return groupBy(items, (item) => item.venue.kommune);
}

/** Every distinct place, with how many quizzes it has, ordered for a picker. */
export function placeSummary(
  items: QuizAtVenue[],
): Array<{ sted: string; fylke: string; count: number }> {
  const summary = new Map<string, { sted: string; fylke: string; count: number }>();
  for (const { venue } of items) {
    const existing = summary.get(venue.kommune);
    if (existing) {
      existing.count += 1;
    } else {
      summary.set(venue.kommune, { sted: venue.kommune, fylke: fylkeOf(venue), count: 1 });
    }
  }
  return [...summary.values()].sort((a, b) => a.sted.localeCompare(b.sted, "nb"));
}
