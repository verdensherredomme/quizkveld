import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { QuizDataSchema } from "../../../pipeline/schema.js";
import { addDays, weekWindow } from "../date.js";
import { caveatOf, hasCategoryCaveat, hasCaveat, isUndated, occurrenceOn, occursOn, splitByDates } from "../occurrence.js";
import { buildPlaceSlugs, formerFylker, fylkeOf } from "../place.js";
import { countByCategory, joinQuizzes, partitionByFreshness, sortQuizzes } from "../model.js";

/**
 * Checks the site logic against the dataset that will actually be published.
 *
 * These are guard rails, not fixtures: they assert properties that must hold whatever the
 * source publishes next week, rather than today's exact numbers. The one thing they are
 * strict about is that no quiz may fall out of the site silently.
 */

const raw = readFileSync(
  path.resolve(import.meta.dirname, "..", "..", "..", "data", "quizzes.json"),
  "utf8",
);
const data = QuizDataSchema.parse(JSON.parse(raw));
const { items, orphans } = joinQuizzes(data.quizzes, data.venues);

describe("the published dataset", () => {
  it("validates against the pipeline schema", () => {
    expect(data.quizzes.length).toBeGreaterThan(250);
    expect(data.venues.length).toBeGreaterThan(200);
  });

  it("has no quiz pointing at a venue that does not exist", () => {
    expect(orphans).toEqual([]);
  });

  it("gives every place and county a unique URL", () => {
    const { bySted, byFylke } = buildPlaceSlugs(data.venues);
    expect(new Set(bySted.values()).size).toBe(bySted.size);
    expect(new Set(byFylke.values()).size).toBe(byFylke.size);
  });
});

describe("no quiz disappears", () => {
  const dates = weekWindow("2026-07-30");
  const { dated, undated } = splitByDates(items, dates);

  it("accounts for every quiz as either datable or undated", () => {
    const undatedIds = new Set(undated.map((item) => item.quiz.id));
    const datableIds = new Set(
      items.filter((item) => !isUndated(item.quiz)).map((item) => item.quiz.id),
    );
    expect(undatedIds.size + datableIds.size).toBe(items.length);
  });

  it("puts every irregular quiz in the undated bucket, including those with a weekday", () => {
    const irregular = items.filter((item) => item.quiz.recurrence.kind === "irregular");
    expect(irregular.length).toBeGreaterThan(0);
    const undatedIds = new Set(undated.map((item) => item.quiz.id));
    for (const item of irregular) {
      expect(undatedIds.has(item.quiz.id)).toBe(true);
    }
  });

  it("keeps the quizzes with no weekday at all", () => {
    const noWeekday = items.filter((item) => item.quiz.weekday === null);
    expect(noWeekday.length).toBeGreaterThan(0);
    const undatedIds = new Set(undated.map((item) => item.quiz.id));
    for (const item of noWeekday) {
      expect(undatedIds.has(item.quiz.id)).toBe(true);
    }
  });

  it("never renders an undated quiz on a date", () => {
    for (const item of undated) {
      for (const date of dates) {
        expect(occursOn(item.quiz, date)).toBe(false);
      }
    }
  });

  it("places every datable quiz on at least one day within five weeks", () => {
    // A week is not long enough: monthly rules legitimately skip whole weeks. Five weeks
    // guarantees every monthly position comes round, so anything still missing here would
    // be a quiz the site can never show on a date.
    const window = Array.from({ length: 35 }, (_, offset) => addDays("2026-07-30", offset));
    const missing = items
      .filter((item) => !isUndated(item.quiz))
      .filter((item) => !window.some((date) => occursOn(item.quiz, date)))
      .map((item) => item.quiz.id);
    expect(missing).toEqual([]);
  });

  it("lists a weekly quiz exactly once per seven-day window", () => {
    const weekly = items.find((item) => item.quiz.recurrence.kind === "weekly");
    expect(weekly).toBeDefined();
    const appearances = [...dated.values()].filter((list) => list.includes(weekly!));
    expect(appearances).toHaveLength(1);
  });
});

describe("categories", () => {
  it("has quizzes naming more than one genre", () => {
    const multi = items.filter((item) => item.quiz.categoryNorm.length > 1);
    expect(multi.length).toBeGreaterThan(0);
  });

  it("counts genres into overlapping buckets, so they sum above the quiz count", () => {
    const counts = countByCategory(items);
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    expect(total).toBeGreaterThan(items.length);
  });
});

describe("sorting the real data", () => {
  const sorted = sortQuizzes(items);

  it("keeps every quiz", () => {
    expect(sorted).toHaveLength(items.length);
  });

  it("puts all the untimed quizzes after all the timed ones", () => {
    const firstUntimed = sorted.findIndex((item) => item.quiz.time === null);
    if (firstUntimed === -1) return;
    expect(sorted.slice(firstUntimed).every((item) => item.quiz.time === null)).toBe(true);
  });
});

describe("caveats in the published dataset", () => {
  const dated = data.quizzes.filter((quiz) => !isUndated(quiz));

  it("flags only a small minority, so the badge keeps meaning something", () => {
    const flagged = dated.filter((quiz) => caveatOf(quiz));
    expect(flagged.length).toBeGreaterThan(0);
    // Today it is 8 of 332. If a source rewording ever pushed this past a tenth of the
    // dataset, "sjekk selv" would be on so many cards that nobody would read it, and the
    // marker list would need rethinking rather than quietly spreading.
    expect(flagged.length).toBeLessThan(dated.length / 10);
  });

  it("catches the phrasings we know are in there", () => {
    const flagged = dated
      .filter((quiz) => hasCaveat(quiz.recurrence.raw))
      .map((quiz) => quiz.recurrence.raw);
    expect(flagged).toContain("Torsdag (sent i måneden)");
    expect(flagged).toContain("Fredag (unntatt sommer)");
    expect(flagged).toContain("Torsdag (vanligvis)");
    // Stored as plain weekly, so without this it would be certain every Sunday.
    expect(flagged).toContain("Sporadiske søndager");
  });

  it("catches the schedule a volunteer typed into the genre column", () => {
    const flagged = dated.filter((quiz) => hasCategoryCaveat(quiz.category));
    // Three rows today. The rule is meant to be narrow: if it ever fires on twenty, it has
    // started reading genre text as schedule text and is too loose.
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.length).toBeLessThan(10);
    expect(flagged.map((quiz) => quiz.category)).toContain("Musikkquiz (én gang i måneden)");
  });

  it("leaves the rows that only look like schedules alone", () => {
    // Both run exactly as often as their recurrence says: the first alternates themes week
    // to week, the second is a theme rota on a genuinely weekly Saturday quiz.
    for (const category of [
      "Annenhver allmennquiz og musikkbingo",
      "Friends (1. lørdag); Seinfeld (2. lørdag); The Office (3. lørdag); Disney (4. lørdag)",
    ]) {
      const row = dated.find((quiz) => quiz.category === category);
      expect(row, `${category} finnes ikke lenger i dataene`).toBeDefined();
      expect(hasCategoryCaveat(category)).toBe(false);
    }
  });

  it("never shows a caveated quiz as certain", () => {
    const window = weekWindow("2026-07-28");
    for (const quiz of dated) {
      if (!caveatOf(quiz)) continue;
      for (const date of window) {
        expect(occurrenceOn(quiz, date)).not.toBe("certain");
      }
    }
  });

  it("still lists caveated quizzes rather than hiding them", () => {
    // The whole point is a softer label, not a smaller site.
    const flagged = dated.filter((quiz) => caveatOf(quiz));
    const window = weekWindow("2026-07-28");
    const shown = flagged.filter((quiz) => window.some((date) => occursOn(quiz, date)));
    expect(shown.length).toBeGreaterThan(0);
  });
});

/**
 * The guard rail that is not a word list.
 *
 * `CAVEAT` and `hasCategoryCaveat` are blacklists, and a blacklist is by definition missing
 * the next word. Both mistakes that have slipped past so far were a *new word for
 * "irregular"* rather than a new kind of mistake: `unntatt sommer` first, then `sporadisk`.
 * Reading rows by hand caught them, but only because someone happened to look.
 *
 * So invert the question. A `weekly` quiz claims `certain` on the strength of nothing but
 * its weekday, and 248 of the 332 dated rows have a `raw` that is *exactly* a weekday name -
 * proof that there is nothing else in there to surprise us. Only the remainder can hide
 * something, and for `weekly` that is six rows.
 *
 * This test fails when a `weekly` row carries text beyond the weekday that no rule catches.
 * It needs no vocabulary, so it keeps working the day the source invents a word we have
 * never seen.
 */
describe("weekly rows that claim certainty on nothing but a weekday", () => {
  const BARE_WEEKDAY = /^(mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)(er)?$/i;

  /**
   * Rows looked at by a human and consciously left as `certain`.
   *
   * Keyed on the source text, so a rewording upstream drops the exemption rather than
   * carrying it silently onto different words.
   */
  const REVIEWED: Record<string, string> = {
    // The quiz runs weekly and the start date is long past. Nothing to hedge.
    "Mandag (start 29.7)": "startdato passert, ukentlig er riktig",

    // These two are biweekly quizzes that phase 1's recurrence parser did not recognise:
    // it looks for `oddetallsuker` and the source wrote `Oddetalsuker` with one l, and it
    // looks for `annenhver` and the source wrote `annen hver` with a space. Both are stored
    // as FREQ=WEEKLY, so we show them every week when they run every other week.
    //
    // Deliberately not patched here. Adding them to `CAVEAT` would be a detour around a
    // parser bug, and would leave the wrong data in place while looking fixed. They are
    // owned upstream; once the parser recognises them they become `biweekly` and pick up
    // the "annenhver uke - sjekk selv" path that already exists.
    "Tirsdag (Oddetalsuker)": "parserfeil i pipelinen, eies oppstrøms",
    "Fredag (annen hver)": "parserfeil i pipelinen, eies oppstrøms",
  };

  const weekly = data.quizzes.filter(
    (quiz) => quiz.recurrence.kind === "weekly" && !isUndated(quiz),
  );

  it("proves most rows clean rather than trusting a word list", () => {
    const bare = weekly.filter((quiz) => BARE_WEEKDAY.test(quiz.recurrence.raw.trim()));
    // If this ratio ever collapses, the source has changed how it writes weekdays and the
    // whole approach needs revisiting rather than the exemption list growing.
    expect(bare.length).toBeGreaterThan(weekly.length * 0.9);
  });

  it("leaves no weekly row unexplained", () => {
    const unexplained = weekly
      .filter((quiz) => !BARE_WEEKDAY.test(quiz.recurrence.raw.trim()))
      .filter((quiz) => !caveatOf(quiz))
      .map((quiz) => quiz.recurrence.raw)
      .filter((raw) => !(raw in REVIEWED));

    expect(
      unexplained,
      "Ukentlige quizer med tekst utover ukedagen som ingen regel fanger. " +
        "Les dem: enten er de harmløse og hører hjemme i REVIEWED, eller så mangler " +
        "CAVEAT et ord.",
    ).toEqual([]);
  });

  it("drops an exemption once the row it excuses is gone", () => {
    // Without this the list would quietly outlive the rows it was written for - including
    // the two parser bugs, whose exemptions must disappear the moment the pipeline fixes
    // them and they turn into biweekly.
    const present = new Set(weekly.map((quiz) => quiz.recurrence.raw));
    const stale = Object.keys(REVIEWED).filter((raw) => !present.has(raw));
    expect(stale, "Fjern disse fra REVIEWED - radene finnes ikke lenger").toEqual([]);
  });
});

describe("county navigation follows today's map", () => {
  /**
   * The source's `fylke` is pre-2020. Navigating on it stranded 78 venues behind counties
   * that had not existed for six years, while Vestland, Trøndelag, Innlandet and Agder had
   * no page at all - so someone looking for a quiz in Bergen had to guess "Hordaland".
   *
   * These assert the property, not today's numbers: whatever the source publishes next
   * week, the navigation must offer counties that exist and must not lose a venue.
   */
  const DISSOLVED_2020 = [
    "Hordaland",
    "Sogn og Fjordane",
    "Sør-Trøndelag",
    "Nord-Trøndelag",
    "Hedmark",
    "Oppland",
    "Aust-Agder",
    "Vest-Agder",
  ];

  it("offers no county that was dissolved in 2020", () => {
    const navigable = new Set(data.venues.map((venue) => fylkeOf(venue)));
    expect([...navigable].filter((name) => DISSOLVED_2020.includes(name))).toEqual([]);
  });

  it("still files the venues those counties held", () => {
    // The point of the change is that nothing moves out of reach, only under a new heading.
    const affected = data.venues.filter((venue) => DISSOLVED_2020.includes(venue.fylke));
    expect(affected.length).toBeGreaterThan(0);
    const { byFylke } = buildPlaceSlugs(data.venues);
    for (const venue of affected) {
      expect(byFylke.get(fylkeOf(venue)), `${venue.name} (${venue.fylke})`).toBeTruthy();
    }
  });

  it("gives every venue a county page, including those Kartverket does not know", () => {
    const { byFylke } = buildPlaceSlugs(data.venues);
    const stranded = data.venues.filter((venue) => !byFylke.get(fylkeOf(venue)));
    expect(stranded.map((venue) => venue.name)).toEqual([]);
  });

  it("navigates to every venue, so none can drop out quietly", () => {
    // The counting version of the test above. Silent loss has been the hardest failure to
    // spot in this project, and it would look like nothing at all: Kartverket stops
    // recognising a place, `fylkeNow` goes missing, and one venue is simply not on any page.
    // A count that must add up catches that without anyone reading rows.
    const { byFylke } = buildPlaceSlugs(data.venues);
    const reachable = data.venues.filter((venue) => byFylke.has(fylkeOf(venue)));
    expect(reachable.length).toBe(data.venues.length);
  });

  it("never claims a county was renamed when the source still uses its own name", () => {
    // The falsehood this catches: Akershus received Jevnaker when Oppland was dissolved, but
    // it was never called Oppland - 26 of its 28 venues are filed under Akershus by the
    // source. "Tidligere Oppland" on that page would be a confident lie about our own
    // derivation. A county that truly was renamed never appears under its own name.
    const former = formerFylker(data.venues);
    const own = new Set(data.venues.filter((v) => v.fylke === fylkeOf(v)).map((v) => fylkeOf(v)));
    for (const [now, entries] of former) {
      for (const entry of entries) {
        expect(
          entry.kommuner.length > 0,
          `${now} claims "tidligere ${entry.fylke}" while the source also writes ${now}`,
        ).toBe(own.has(now));
      }
    }
  });

  it("mentions every source county somewhere it actually has venues", () => {
    // The reader this protects is the one who knows the old name. Reporting an old county
    // only under its majority successor would leave Jevnaker unreachable from "Oppland",
    // since Oppland's other six venues are in Innlandet - the same silent wrong answer that
    // ruled out redirecting a split county to one destination.
    const former = formerFylker(data.venues);
    const missing = data.venues
      .filter((venue) => venue.fylke !== fylkeOf(venue))
      .filter(
        (venue) => !former.get(fylkeOf(venue))?.some((entry) => entry.fylke === venue.fylke),
      );
    expect(missing.map((v) => `${v.name} (${v.fylke} -> ${fylkeOf(v)})`)).toEqual([]);
  });

  it("keeps a venue Kartverket does not know under the source's county", () => {
    // Grendehuset (Sandnesseter) has no `fylkeNow`. The fallback is what stops it vanishing.
    const withoutLookup = data.venues.filter((venue) => !venue.fylkeNow);
    for (const venue of withoutLookup) {
      expect(fylkeOf(venue), venue.name).toBe(venue.fylke);
    }
  });

  it("tells each county which of the source's counties it covers", () => {
    // The navigation is our derivation, so the page has to say so rather than silently
    // replacing the source's word.
    const former = formerFylker(data.venues);
    expect(former.get("Vestland")?.map((entry) => entry.fylke)).toContain("Hordaland");
    const { byFylke } = buildPlaceSlugs(data.venues);
    for (const name of former.keys()) {
      expect(byFylke.has(name), name).toBe(true);
    }
  });
});

describe("staleness in the published dataset", () => {
  it("keeps stale rows out of the fresh half", () => {
    const { fresh, stale } = partitionByFreshness(items);
    expect(fresh.length + stale.length).toBe(items.length);
    expect(fresh.every((item) => !item.quiz.stale && !item.venue.stale)).toBe(true);
  });
});

