import { describe, expect, it } from "vitest";

import { addDays, isoWeekOf, osloDate, osloWeekday, partsOf, weekdayOf, weekWindow } from "../date.js";

/**
 * The site is built in CI, which runs in UTC. Every test here exists because a naive
 * `new Date()` would get the answer wrong on exactly these instants.
 */

describe("osloDate", () => {
  it("is still the same evening at 21:59 UTC in summer (23:59 in Oslo)", () => {
    expect(osloDate(new Date("2026-07-30T21:59:00Z"))).toBe("2026-07-30");
  });

  it("has already rolled over at 22:00 UTC in summer (00:00 in Oslo)", () => {
    // This is the trap: a build at 22:30 UTC on a Thursday must advertise Friday's
    // quizzes, because it is already Friday in Norway.
    expect(osloDate(new Date("2026-07-30T22:00:00Z"))).toBe("2026-07-31");
  });

  it("rolls over an hour later in winter, when Oslo is UTC+1", () => {
    expect(osloDate(new Date("2026-01-15T22:30:00Z"))).toBe("2026-01-15");
    expect(osloDate(new Date("2026-01-15T23:00:00Z"))).toBe("2026-01-16");
  });

  it("does not roll over at UTC midnight in winter until Oslo agrees", () => {
    expect(osloDate(new Date("2026-01-15T23:30:00Z"))).toBe("2026-01-16");
  });
});

describe("osloWeekday", () => {
  it("reports the Norwegian weekday, not the UTC one", () => {
    // 22:30 UTC on a Thursday is already Friday in Oslo.
    expect(osloWeekday(new Date("2026-07-30T22:30:00Z"))).toBe("fredag");
    expect(osloWeekday(new Date("2026-07-30T12:00:00Z"))).toBe("torsdag");
  });

  it("survives the spring DST transition", () => {
    // Clocks go forward 02:00 -> 03:00 on 2026-03-29, so Oslo is UTC+1 right up to it.
    expect(osloWeekday(new Date("2026-03-28T22:30:00Z"))).toBe("lordag");
    expect(osloWeekday(new Date("2026-03-28T23:30:00Z"))).toBe("sondag");
    expect(osloWeekday(new Date("2026-03-29T00:30:00Z"))).toBe("sondag");
  });

  it("survives the autumn DST transition", () => {
    // Clocks go back 03:00 -> 02:00 on 2026-10-25, so Oslo is still UTC+2 the night before
    // and the day rolls over an hour earlier in UTC terms than it does in January.
    expect(osloWeekday(new Date("2026-10-24T21:30:00Z"))).toBe("lordag");
    expect(osloWeekday(new Date("2026-10-24T22:30:00Z"))).toBe("sondag");
  });
});

describe("addDays", () => {
  it("adds a calendar day across the spring DST transition", () => {
    // The Norwegian day 2026-03-29 is only 23 hours long; adding 24h to a timestamp would
    // skip it. Civil-date arithmetic does not care.
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
  });

  it("adds a calendar day across the autumn DST transition", () => {
    expect(addDays("2026-10-24", 1)).toBe("2026-10-25");
    expect(addDays("2026-10-25", 1)).toBe("2026-10-26");
  });

  it("crosses months and years", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
  });

  it("goes backwards too", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("rejects anything that is not a civil date", () => {
    expect(() => addDays("30.07.2026", 1)).toThrow();
  });
});

describe("weekdayOf", () => {
  it("maps to the pipeline's Norwegian weekday enum", () => {
    expect(weekdayOf("2026-07-27")).toBe("mandag");
    expect(weekdayOf("2026-08-01")).toBe("lordag");
    expect(weekdayOf("2026-08-02")).toBe("sondag");
  });

  it("stays correct across the DST weekend", () => {
    expect(weekdayOf("2026-03-29")).toBe("sondag");
    expect(weekdayOf("2026-10-25")).toBe("sondag");
  });
});

describe("weekWindow", () => {
  it("is a rolling seven days starting today", () => {
    expect(weekWindow("2026-07-30")).toEqual([
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
    ]);
  });
});

describe("partsOf", () => {
  it("splits a civil date without timezone involvement", () => {
    expect(partsOf("2026-02-09")).toEqual({ year: 2026, month: 2, day: 9 });
  });
});

describe("isoWeekOf", () => {
  // Week parity decides whether a pub is listed at all, so an off-by-one here shows up as a
  // quiz on the wrong night. The dates below are the ones a naive implementation gets wrong.
  it("counts ordinary weeks", () => {
    expect(isoWeekOf("2026-07-28")).toBe(31);
    expect(isoWeekOf("2026-08-04")).toBe(32);
  });

  it("puts early January in the previous year's last week where ISO does", () => {
    // 1 January 2021 is a Friday, so ISO puts it in week 53 of 2020 - not week 1.
    expect(isoWeekOf("2021-01-01")).toBe(53);
    expect(isoWeekOf("2027-01-01")).toBe(53);
  });

  it("puts late December in the next year's first week where ISO does", () => {
    // 30 December 2024 is a Monday whose Thursday falls in 2025, so it is week 1.
    expect(isoWeekOf("2024-12-30")).toBe(1);
  });

  it("treats Sunday as the last day of the week, not the first", () => {
    // The classic off-by-one: getUTCDay() calls Sunday 0, which would push every Sunday
    // into the following week and flip the parity of every Sunday quiz.
    expect(isoWeekOf("2026-08-02")).toBe(31); // Sunday
    expect(isoWeekOf("2026-08-03")).toBe(32); // the Monday after
  });

  it("keeps a whole week on one number", () => {
    const week = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09"];
    expect(new Set(week.map(isoWeekOf))).toEqual(new Set([32]));
  });
});
