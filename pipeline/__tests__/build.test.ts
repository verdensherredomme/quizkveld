import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_ID_CHURN,
  DEFAULT_MIN_ROWS,
  SafetyRailError,
  checkSafetyRails,
  mergeData,
  serialize,
} from "../build.js";
import { normalizeRows } from "../normalize.js";
import { parseHtml } from "../parse.js";
import { QuizDataSchema, OverridesSchema, type Overrides, type QuizData } from "../schema.js";
import { FIXED_NOW, loadFixture } from "./helpers.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

async function normalizedFixture() {
  return normalizeRows(parseHtml(await loadFixture()), FIXED_NOW);
}

describe("mergeData", () => {
  it("produces schema-valid output", async () => {
    const { data } = mergeData(await normalizedFixture(), { now: FIXED_NOW });
    expect(QuizDataSchema.safeParse(data).success).toBe(true);
    expect(data.generatedAt).toBe("2026-07-28T04:00:00.000Z");
    expect(data.sourceUpdatedAt).toBe("2026-07-27");
  });

  it("is byte-for-byte reproducible across runs", async () => {
    const first = mergeData(await normalizedFixture(), { now: FIXED_NOW });
    const second = mergeData(await normalizedFixture(), { now: FIXED_NOW });
    expect(serialize(first.data)).toBe(serialize(second.data));
  });

  it("keeps ids stable when the source is unchanged", async () => {
    const first = mergeData(await normalizedFixture(), { now: FIXED_NOW });
    const second = mergeData(await normalizedFixture(), {
      now: FIXED_NOW,
      previous: first.data,
    });
    expect(second.report.newIds).toEqual([]);
    expect(second.report.removedIds).toEqual([]);
    expect(second.report.idChurn).toBe(0);
  });

  it("reuses the previous generatedAt when nothing else changed", async () => {
    const first = mergeData(await normalizedFixture(), { now: FIXED_NOW });
    // Same day, later hour: lastSeen is a date so it does not move, and the only thing
    // that would otherwise differ is the timestamp itself.
    const later = new Date(FIXED_NOW.getTime() + 6 * 60 * 60 * 1000);
    const second = mergeData(await normalizedFixture(), {
      now: later,
      previous: first.data,
    });
    expect(second.data.generatedAt).toBe(first.data.generatedAt);
    expect(serialize(second.data)).toBe(serialize(first.data));
  });

  it("advances generatedAt as soon as something real changes", async () => {
    const first = mergeData(await normalizedFixture(), { now: FIXED_NOW });
    const later = new Date(FIXED_NOW.getTime() + 6 * 60 * 60 * 1000);
    const trimmed = await normalizedFixture();
    trimmed.quizzes = trimmed.quizzes.slice(1);
    const second = mergeData(trimmed, { now: later, previous: first.data });
    expect(second.data.generatedAt).toBe(later.toISOString());
  });

  it("sorts venues and quizzes by id", async () => {
    const { data } = mergeData(await normalizedFixture(), { now: FIXED_NOW });
    const quizIds = data.quizzes.map((quiz) => quiz.id);
    expect(quizIds).toEqual([...quizIds].sort());
    const venueIds = data.venues.map((venue) => venue.id);
    expect(venueIds).toEqual([...venueIds].sort());
  });
});

describe("overrides", () => {
  it("beat the scraped values for both venues and quizzes", async () => {
    const overrides: Overrides = {
      venues: {
        "oslo-skatten": {
          name: "Skatten Bar",
          addressHint: "Rådhusgata 1",
          lat: 59.9105,
          lon: 10.7405,
          geoSource: "manual",
          geoConfidence: "high",
        },
      },
      quizzes: {
        "oslo-skatten-torsdag-18-00": {
          time: "17:45",
          categoryNorm: ["sport"],
          note: "Flyttet en time frem i sommerhalvåret.",
        },
      },
    };

    const { data } = mergeData(await normalizedFixture(), { now: FIXED_NOW, overrides });

    const venue = data.venues.find((item) => item.id === "oslo-skatten");
    expect(venue).toMatchObject({
      name: "Skatten Bar",
      addressHint: "Rådhusgata 1",
      lat: 59.9105,
      geoSource: "manual",
    });
    // Untouched fields survive the merge.
    expect(venue?.kommune).toBe("Oslo");
    expect(venue?.url).toBe("https://www.skattenoslo.no/");

    const quiz = data.quizzes.find((item) => item.id === "oslo-skatten-torsdag-18-00");
    expect(quiz).toMatchObject({
      time: "17:45",
      categoryNorm: ["sport"],
      note: "Flyttet en time frem i sommerhalvåret.",
    });
    expect(quiz?.weekday).toBe("torsdag");
    // The sibling quiz from the same row is untouched.
    expect(
      data.quizzes.find((item) => item.id === "oslo-skatten-torsdag-20-30")?.time,
    ).toBe("20:30");
  });

  it("beat the geocache", async () => {
    const geocache = {
      get: () => ({
        lat: 1,
        lon: 2,
        geoSource: "centroid" as const,
        geoConfidence: "low" as const,
        resolvedAt: FIXED_NOW.toISOString(),
      }),
    };

    const { data } = mergeData(await normalizedFixture(), {
      now: FIXED_NOW,
      geocache: geocache as never,
      overrides: {
        venues: { "oslo-skatten": { lat: 59.9, lon: 10.7, geoSource: "manual" } },
        quizzes: {},
      },
    });

    expect(data.venues.find((venue) => venue.id === "oslo-skatten")).toMatchObject({
      lat: 59.9,
      lon: 10.7,
      geoSource: "manual",
    });
    // A venue without an override still picks up the cached coordinates.
    expect(data.venues.find((venue) => venue.id === "oslo-kulturhuset")).toMatchObject({
      lat: 1,
      geoSource: "centroid",
    });
  });
});

describe("lastSeen and soft deletion", () => {
  it("stamps lastSeen with the current run date", async () => {
    const { data } = mergeData(await normalizedFixture(), { now: FIXED_NOW });
    expect(new Set(data.quizzes.map((quiz) => quiz.lastSeen))).toEqual(
      new Set(["2026-07-28"]),
    );
  });

  it("keeps entries that vanished upstream, flagged stale with their old lastSeen", async () => {
    const normalized = await normalizedFixture();
    const previous: QuizData = {
      generatedAt: "2026-07-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-06-30",
      venues: [
        {
          id: "bergen-nedlagt-pub",
          name: "Nedlagt Pub",
          rawName: "Nedlagt Pub",
          kommune: "Bergen",
          fylke: "Hordaland",
        },
      ],
      quizzes: [
        {
          id: "bergen-nedlagt-pub-mandag-19-00",
          venueId: "bergen-nedlagt-pub",
          weekday: "mandag",
          time: "19:00",
          recurrence: { kind: "weekly", rrule: "FREQ=WEEKLY;BYDAY=MO", raw: "Mandag" },
          category: "Allmenn",
          categoryNorm: ["allmenn"],
          lastSeen: "2026-07-01",
        },
      ],
    };

    const { data, report } = mergeData(normalized, { now: FIXED_NOW, previous });

    const gone = data.quizzes.find((quiz) => quiz.id === "bergen-nedlagt-pub-mandag-19-00");
    expect(gone).toBeDefined();
    expect(gone?.stale).toBe(true);
    expect(gone?.lastSeen).toBe("2026-07-01");

    const goneVenue = data.venues.find((venue) => venue.id === "bergen-nedlagt-pub");
    expect(goneVenue?.stale).toBe(true);

    expect(report.removedIds).toEqual(["bergen-nedlagt-pub-mandag-19-00"]);
    expect(report.staleQuizzes).toBe(1);
    expect(report.staleVenues).toBe(1);
    // Still schema-valid with the stale entries present.
    expect(QuizDataSchema.safeParse(data).success).toBe(true);
  });

  it("clears the stale flag when an entry reappears upstream", async () => {
    const normalized = await normalizedFixture();
    const firstQuiz = normalized.quizzes[0];
    expect(firstQuiz).toBeDefined();

    const previous: QuizData = {
      generatedAt: "2026-07-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-06-30",
      venues: [],
      quizzes: [{ ...firstQuiz!, stale: true, lastSeen: "2026-05-01" }],
    };

    const { data } = mergeData(normalized, { now: FIXED_NOW, previous });
    const revived = data.quizzes.find((quiz) => quiz.id === firstQuiz!.id);
    expect(revived?.stale).toBeUndefined();
    expect(revived?.lastSeen).toBe("2026-07-28");
  });
});

describe("safety rails", () => {
  function report(overrides: Partial<Parameters<typeof checkSafetyRails>[0]> = {}) {
    return {
      rowCount: 400,
      venueCount: 380,
      quizCount: 400,
      newIds: [],
      removedIds: [],
      staleQuizzes: 0,
      staleVenues: 0,
      idChurn: 0,
      railsTripped: [],
      warnings: [],
      ...overrides,
    };
  }

  it("passes a healthy run", () => {
    expect(() => checkSafetyRails(report())).not.toThrow();
  });

  it("trips when the row count collapses", () => {
    expect(() => checkSafetyRails(report({ rowCount: 12 }))).toThrow(SafetyRailError);
    expect(() => checkSafetyRails(report({ rowCount: 12 }))).toThrow(
      new RegExp(String(DEFAULT_MIN_ROWS)),
    );
  });

  it("trips when too many ids change", () => {
    const churned = report({
      idChurn: 0.42,
      newIds: ["a", "b"],
      removedIds: ["c"],
    });
    expect(() => checkSafetyRails(churned)).toThrow(SafetyRailError);
    expect(() => checkSafetyRails(churned)).toThrow(/42\.0 %/);
  });

  it("tolerates churn right at the threshold", () => {
    expect(() => checkSafetyRails(report({ idChurn: DEFAULT_MAX_ID_CHURN }))).not.toThrow();
  });

  it("records what tripped even when forced through", () => {
    const forced = report({ rowCount: 5, idChurn: 0.9 });
    expect(() => checkSafetyRails(forced, { force: true })).not.toThrow();
    expect(forced.railsTripped).toHaveLength(2);
  });

  it("honours an explicit --min-rows override", () => {
    expect(() => checkSafetyRails(report({ rowCount: 100 }), { minRows: 50 })).not.toThrow();
  });

  it("does not trip on the very first run, when there is nothing to compare against", async () => {
    const { report: first } = mergeData(await normalizedFixture(), {
      now: FIXED_NOW,
      previous: null,
    });
    expect(first.idChurn).toBe(0);
    expect(() => checkSafetyRails(first, { minRows: 1 })).not.toThrow();
  });

  it("catches a parser regression that silently drops most rows", async () => {
    const html = await loadFixture();
    const full = normalizeRows(parseHtml(html), FIXED_NOW);
    const { data: previous } = mergeData(full, { now: FIXED_NOW });

    // Simulate the source dropping all but the first fylke.
    const truncated = {
      ...full,
      quizzes: full.quizzes.slice(0, 2),
      venues: full.venues.slice(0, 2),
    };
    const { report: broken } = mergeData(truncated, { now: FIXED_NOW, previous });

    expect(() => checkSafetyRails(broken, { minRows: 10 })).toThrow(SafetyRailError);
  });
});

describe("serialize", () => {
  it("writes stable, newline-terminated json", async () => {
    const { data } = mergeData(await normalizedFixture(), { now: FIXED_NOW });
    const text = serialize(data);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.startsWith("{\n  ")).toBe(true);
    expect(JSON.parse(text)).toEqual(data);
  });
});

describe("data/overrides.json som ligger i repoet", () => {
  const file = fileURLToPath(new URL("../../data/overrides.json", import.meta.url));

  // The shipped file carries a _note block documenting the upstream outbox. Zod strips
  // unknown keys, so this parses today - the test exists so that adding .strict() later
  // fails here instead of in production.
  it("parses even though it carries a _note block", async () => {
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(raw["_note"]).toBeDefined();
    const parsed = OverridesSchema.parse(raw);
    expect(parsed.venues).toEqual({});
    expect(parsed.quizzes).toEqual({});
    expect("_note" in parsed).toBe(false);
  });

  // Maintenance policy: we hold no facts of our own about when a quiz runs. A schedule we
  // confirmed once rots silently when the venue changes it and nobody tells us. Wrong
  // schedules are reported upstream instead. This is easy to erode one well-meaning entry
  // at a time, so it is asserted rather than merely documented.
  it("holds no claims about quiz schedules", async () => {
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const parsed = OverridesSchema.parse(raw);
    for (const [id, override] of Object.entries(parsed.quizzes)) {
      expect(
        override.recurrence,
        `${id} overstyrer recurrence - rapporter det til kilden i stedet, se _note.utboks`,
      ).toBeUndefined();
    }
  });
});