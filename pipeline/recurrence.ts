// rrule 2.x ships a UMD bundle whose named exports Node's ESM loader cannot detect,
// so we take the default (module.exports) and destructure it ourselves.
import rrulePkg from "rrule";
import type { Frequency } from "rrule";
import type { Recurrence, Weekday } from "./schema.js";

const { RRule } = rrulePkg;

/**
 * Parser for the free-text Norwegian recurrence descriptions in the source table.
 *
 * The guiding rule is: never guess. Anything we cannot confidently map becomes
 * `irregular`, with the original text always preserved in `raw`. A wrong RRULE is far
 * worse than an honest "irregular", because the site would send people to a pub on the
 * wrong night.
 */

const WEEKDAY_PATTERNS: Array<{ weekday: Weekday; re: RegExp; rruleDay: number }> = [
  { weekday: "mandag", re: /\bmandag(?:er|en|ene)?\b/, rruleDay: RRule.MO.weekday },
  { weekday: "tirsdag", re: /\btirsdag(?:er|en|ene)?\b/, rruleDay: RRule.TU.weekday },
  { weekday: "onsdag", re: /\bonsdag(?:er|en|ene)?\b/, rruleDay: RRule.WE.weekday },
  { weekday: "torsdag", re: /\btorsdag(?:er|en|ene)?\b/, rruleDay: RRule.TH.weekday },
  { weekday: "fredag", re: /\bfredag(?:er|en|ene)?\b/, rruleDay: RRule.FR.weekday },
  {
    weekday: "lordag",
    re: /\b(?:lordag|lørdag)(?:er|en|ene)?\b/,
    rruleDay: RRule.SA.weekday,
  },
  {
    weekday: "sondag",
    re: /\b(?:sondag|søndag)(?:er|en|ene)?\b/,
    rruleDay: RRule.SU.weekday,
  },
];

/** Ordinal words and digits that place an occurrence within the month. */
const ORDINALS: Array<{ position: number; re: RegExp }> = [
  { position: 1, re: /\b(?:forste|første|1|1\.|1st)\b/ },
  { position: 2, re: /\b(?:andre|annen|2|2\.)\b/ },
  { position: 3, re: /\b(?:tredje|3|3\.)\b/ },
  { position: 4, re: /\b(?:fjerde|4|4\.)\b/ },
];

const LAST_OF_MONTH_RE =
  /\bsiste\b|\bsist\s+i\b|\bsent\s+i\s+(?:mnd|maneden|måneden)\b/;
const MONTH_RE = /\b(?:mnd|md|maned|måned|maneden|måneden|manedlig|månedlig)\b/;

/**
 * Volunteers spell the same word several ways, and the two ways that bite are dropping a
 * doubled consonant ("Oddetalsuker") and splitting a compound ("annen hver"). Both slipped
 * past a literal pattern list and were classified `weekly`, which is the one error this
 * site must not make: it says there is a quiz tonight when there is not.
 *
 * Rather than bolt on one alternative per misspelling, keyword tests run against a
 * compacted form - separators removed, runs of a repeated letter collapsed. The keywords
 * below are written in ordinary Norwegian and pushed through the *same* function, so a
 * pattern can never drift out of sync with the normalization applied to the input.
 *
 * Measured against all 352 rows: this catches exactly the two known misspellings and
 * changes no other row's classification.
 */
function compact(text: string): string {
  return lower(text)
    .replace(/[\s\-.,()]+/g, "")
    .replace(/(.)\1+/g, "$1");
}

function compactedMatcher(keywords: string[]): (text: string) => boolean {
  const needles = [...new Set(keywords.map(compact))];
  return (text: string) => {
    const haystack = compact(text);
    return needles.some((needle) => haystack.includes(needle));
  };
}

const isBiweeklyText = compactedMatcher([
  "annenhver",
  "annen hver",
  "hver andre",
  "hveranden",
  // Singular forms are enough for these two: matching is by substring, so "oddetallsuke"
  // also covers "oddetallsuker".
  "oddetallsuke",
  "partallsuke",
]);

/**
 * Which ISO week half of the biweekly rows fall in.
 *
 * "INTERVAL=2" says "every other week" but not *which* other week, so on its own it cannot
 * answer "is it on tonight?". Week parity settles that, and unlike a start date it never
 * expires - ISO week numbers are a property of the calendar, not of one season.
 *
 * Order is load-bearing. Compacted, "ulike uker" (odd) becomes "ulikeuker", which contains
 * "likeuker" (even) as a substring, so the even test fires on it too. Odd is checked first
 * so the more specific word wins. The two differ by one leading letter and mean the
 * opposite thing, so there is an explicit test for it.
 */
const isOddWeekText = compactedMatcher([
  "oddetallsuker",
  "oddetallsuke",
  "ulike uker",
  "ulik uke",
  "odde uker",
  "odde uke",
]);
const isEvenWeekText = compactedMatcher([
  "partallsuker",
  "partallsuke",
  "like uker",
  "like uke",
  "jevne uker",
  "jevne uke",
]);

function findWeekParity(text: string): "odd" | "even" | undefined {
  if (isOddWeekText(text)) return "odd";
  if (isEvenWeekText(text)) return "even";
  return undefined;
}
const AMBIGUOUS_RE =
  /\bvarierer\b|\bvarierende\b|\butvalgte\b|\buregelmessig\b|\bsporadisk\b|\bav\s+og\s+til\b|\bved\s+behov\b|\better\s+avtale\b|\bikke\s+fast\b|\bdiverse\b/;
const ALTERNATIVE_RE = /\beller\b|\bevt\.?\b|\beventuelt\b/;

function lower(text: string): string {
  return text
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function findWeekdays(text: string): Array<{ weekday: Weekday; rruleDay: number }> {
  return WEEKDAY_PATTERNS.filter((pattern) => pattern.re.test(text)).map(
    ({ weekday, rruleDay }) => ({ weekday, rruleDay }),
  );
}

/** Detects the weekday alone, without committing to a recurrence kind. */
export function parseWeekday(raw: string): Weekday | null {
  const found = findWeekdays(lower(raw));
  if (found.length !== 1) return null;
  return found[0]?.weekday ?? null;
}

/**
 * Finds every ordinal that qualifies the weekday, ignoring digits that belong to dates or
 * season ranges such as "fra 28/8 til 4/12". Returns them sorted and deduplicated, so
 * "Fredag (1. og 3. i mnd)" yields [1, 3] rather than silently dropping the third.
 */
function findOrdinals(text: string): number[] {
  const withoutDates = text.replace(/\d{1,2}\s*[/.]\s*\d{1,2}/g, " ");
  const found = ORDINALS.filter(({ re }) => re.test(withoutDates)).map(
    ({ position }) => position,
  );
  return [...new Set(found)].sort((a, b) => a - b);
}

function buildRrule(options: {
  freq: Frequency;
  byweekday: number;
  interval?: number;
  bysetpos?: number[];
}): string {
  const rule = new RRule({
    freq: options.freq,
    byweekday: [options.byweekday],
    ...(options.interval !== undefined ? { interval: options.interval } : {}),
    ...(options.bysetpos !== undefined ? { bysetpos: options.bysetpos } : {}),
  });
  // RRule#toString() emits "RRULE:FREQ=..."; we store the rule body only.
  return rule.toString().replace(/^RRULE:/, "");
}

export function parseRecurrence(raw: string): Recurrence {
  const text = lower(raw);
  const irregular = (): Recurrence => ({ kind: "irregular", raw });

  if (!text) return irregular();

  const weekdays = findWeekdays(text);

  // No weekday at all, or several of them ("Torsdag (eller fredag)"): we cannot express
  // that as a single reliable rule.
  if (weekdays.length !== 1) return irregular();
  const match = weekdays[0];
  if (!match) return irregular();

  // Explicit statements that the schedule is not fixed.
  if (AMBIGUOUS_RE.test(text)) return irregular();

  const isMonthly = MONTH_RE.test(text);

  if (LAST_OF_MONTH_RE.test(text)) {
    return {
      kind: "last-of-month",
      rrule: buildRrule({
        freq: RRule.MONTHLY,
        byweekday: match.rruleDay,
        bysetpos: [-1],
      }),
      raw,
    };
  }

  // "annenhver" beats a monthly reading: "Annenhver tirsdag" is every other week.
  if (isBiweeklyText(text)) {
    // Guard the case where "andre" is really an ordinal position, e.g.
    // "andre tirsdag i maneden" - that is monthly, not biweekly.
    const ordinalMonthly = isMonthly && findOrdinals(text).length > 0;
    if (!ordinalMonthly) {
      const parity = findWeekParity(text);
      return {
        kind: "biweekly",
        rrule: buildRrule({
          freq: RRule.WEEKLY,
          byweekday: match.rruleDay,
          interval: 2,
        }),
        raw,
        ...(parity ? { weekParity: parity } : {}),
      };
    }
  }

  if (isMonthly) {
    const ordinals = findOrdinals(text);
    if (ordinals.length === 0) {
      // "En gang per maned" / "Fredag (manedlig)" - monthly, but no stated position.
      return irregular();
    }
    return {
      kind: "monthly-nth",
      rrule: buildRrule({
        freq: RRule.MONTHLY,
        byweekday: match.rruleDay,
        bysetpos: ordinals,
      }),
      raw,
    };
  }

  // "Hver fjerde sondag" / "Torsdag (hver tredje)" - an interval without the word
  // "maned". This is genuinely ambiguous in Norwegian: it can mean every fourth week, or
  // the fourth <weekday> of the month, and those fall on different dates. Rather than
  // pick one and send people out on the wrong night, we call it irregular and keep the
  // original text. "annenhver" is the one exception, handled above, because every other
  // week is its only reading.
  if (/\bhver\s+(?:forste|første|andre|tredje|fjerde|femte)\b/.test(text)) {
    return irregular();
  }

  // A leftover alternative marker means the text lists options we cannot resolve,
  // e.g. "Torsdag (eller senere)".
  if (ALTERNATIVE_RE.test(text)) return irregular();

  return {
    kind: "weekly",
    rrule: buildRrule({ freq: RRule.WEEKLY, byweekday: match.rruleDay }),
    raw,
  };
}
