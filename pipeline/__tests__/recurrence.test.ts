import { describe, expect, it } from "vitest";
import { parseRecurrence, parseWeekday } from "../recurrence.js";
import type { RecurrenceKind } from "../schema.js";

interface Case {
  raw: string;
  kind: RecurrenceKind;
  rrule?: string;
}

/**
 * Every phrasing below was either specified up front or observed on the live page.
 * When a phrasing is genuinely ambiguous we assert `irregular` on purpose: shipping a
 * confident-but-wrong RRULE would send people to a pub on the wrong night.
 */
const CASES: Case[] = [
  // --- plain weekly -------------------------------------------------------------
  { raw: "Mandag", kind: "weekly", rrule: "FREQ=WEEKLY;BYDAY=MO" },
  { raw: "Tirsdag", kind: "weekly", rrule: "FREQ=WEEKLY;BYDAY=TU" },
  { raw: "Onsdag", kind: "weekly", rrule: "FREQ=WEEKLY;BYDAY=WE" },
  { raw: "Torsdag", kind: "weekly", rrule: "FREQ=WEEKLY;BYDAY=TH" },
  { raw: "Fredag", kind: "weekly", rrule: "FREQ=WEEKLY;BYDAY=FR" },
  { raw: "Lørdag", kind: "weekly", rrule: "FREQ=WEEKLY;BYDAY=SA" },
  { raw: "Søndag", kind: "weekly", rrule: "FREQ=WEEKLY;BYDAY=SU" },
  // Plural and definite forms.
  { raw: "Onsdager", kind: "weekly", rrule: "FREQ=WEEKLY;BYDAY=WE" },
  { raw: "Mandagen", kind: "weekly", rrule: "FREQ=WEEKLY;BYDAY=MO" },
  // A qualifier that does not change the frequency.
  { raw: "Torsdag (også i ferien)", kind: "weekly", rrule: "FREQ=WEEKLY;BYDAY=TH" },

  // --- biweekly -----------------------------------------------------------------
  { raw: "Mandag (annenhver)", kind: "biweekly", rrule: "FREQ=WEEKLY;BYDAY=MO;INTERVAL=2" },
  { raw: "Annenhver tirsdag", kind: "biweekly", rrule: "FREQ=WEEKLY;BYDAY=TU;INTERVAL=2" },
  {
    raw: "Tirsdag (annenhver - oddetallsuker)",
    kind: "biweekly",
    rrule: "FREQ=WEEKLY;BYDAY=TU;INTERVAL=2",
  },
  {
    raw: "Torsdag (annenhver – partallsuker)",
    kind: "biweekly",
    rrule: "FREQ=WEEKLY;BYDAY=TH;INTERVAL=2",
  },
  { raw: "Onsdag (oddetallsuker)", kind: "biweekly", rrule: "FREQ=WEEKLY;BYDAY=WE;INTERVAL=2" },
  { raw: "Torsdag (partallsuker)", kind: "biweekly", rrule: "FREQ=WEEKLY;BYDAY=TH;INTERVAL=2" },
  {
    raw: "Onsdager (annenhver – høstsesong 2024 fra 28/8 til 4/12)",
    kind: "biweekly",
    rrule: "FREQ=WEEKLY;BYDAY=WE;INTERVAL=2",
  },

  // --- nth of the month ---------------------------------------------------------
  {
    raw: "Første onsdag i måneden",
    kind: "monthly-nth",
    rrule: "FREQ=MONTHLY;BYDAY=WE;BYSETPOS=1",
  },
  {
    raw: "Onsdag (1. onsdag i måneden)",
    kind: "monthly-nth",
    rrule: "FREQ=MONTHLY;BYDAY=WE;BYSETPOS=1",
  },
  {
    raw: "Mandag (2. mandag i måneden)",
    kind: "monthly-nth",
    rrule: "FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2",
  },
  {
    raw: "1. tirsdag hver måned",
    kind: "monthly-nth",
    rrule: "FREQ=MONTHLY;BYDAY=TU;BYSETPOS=1",
  },
  {
    raw: "1. tirsdag hver måned (ikke januar 2025)",
    kind: "monthly-nth",
    rrule: "FREQ=MONTHLY;BYDAY=TU;BYSETPOS=1",
  },
  {
    raw: "Mandag (den andre i hver måned)",
    kind: "monthly-nth",
    rrule: "FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2",
  },
  // Two positions in one entry - both must survive.
  {
    raw: "Fredag (1. og 3. i mnd)",
    kind: "monthly-nth",
    rrule: "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=1,3",
  },

  // --- last of the month --------------------------------------------------------
  {
    raw: "Fredag (siste i mnd)",
    kind: "last-of-month",
    rrule: "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1",
  },
  {
    raw: "Siste fredag i mnd",
    kind: "last-of-month",
    rrule: "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1",
  },
  {
    raw: "Onsdag (siste i måneden)",
    kind: "last-of-month",
    rrule: "FREQ=MONTHLY;BYDAY=WE;BYSETPOS=-1",
  },
  {
    raw: "Torsdag (sent i måneden)",
    kind: "last-of-month",
    rrule: "FREQ=MONTHLY;BYDAY=TH;BYSETPOS=-1",
  },
  {
    raw: "Fredag (siste hver måned, ikke desember)",
    kind: "last-of-month",
    rrule: "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1",
  },

  // --- irregular ----------------------------------------------------------------
  // Monthly, but the source never says which week.
  { raw: "Mandag (én gang per måned)", kind: "irregular" },
  { raw: "Mandag (én gang i måneden)", kind: "irregular" },
  { raw: "Fredag (månedlig)", kind: "irregular" },
  { raw: "En gang i måneden", kind: "irregular" },
  {
    raw: "Omtrent én gang per måned (sjekk facebookgruppa «Spillquiz i Tromsø»)",
    kind: "irregular",
  },
  // Two weekdays: not expressible as one reliable rule.
  { raw: "Torsdag (eller fredag)", kind: "irregular" },
  { raw: "Mandag (og fredag)", kind: "irregular" },
  { raw: "Mandag (Søndag)", kind: "irregular" },
  // Explicitly not a fixed schedule.
  { raw: "En torsdag i måneden (varierer)", kind: "irregular" },
  { raw: "Torsdag (utvalgte)", kind: "irregular" },
  // "hver N-te <ukedag>" is ambiguous in Norwegian and we deliberately refuse to guess.
  // It can mean either "every Nth week" (an interval) or "the Nth <weekday> of the
  // month" (a position), and those produce different dates. Even read as an interval it
  // is unusable: an interval needs an anchor date to count from, and the source never
  // gives one. "annenhver" is the one exception, because "every other week" is its only
  // reading - see the biweekly cases above.
  // Do not "fix" these into monthly-nth without first getting an anchor date from the
  // source; a wrong RRULE sends people to the pub on the wrong night.
  { raw: "Hver fjerde søndag", kind: "irregular" },
  { raw: "Torsdag (hver tredje)", kind: "irregular" },
  { raw: "Torsdag (hver fjerde)", kind: "irregular" },
  // Nothing to go on at all.
  { raw: "", kind: "irregular" },
  { raw: "?", kind: "irregular" },
  { raw: "Sjekk facebook", kind: "irregular" },
];

describe("parseRecurrence", () => {
  for (const testCase of CASES) {
    it(`maps ${JSON.stringify(testCase.raw)} to ${testCase.kind}`, () => {
      const result = parseRecurrence(testCase.raw);
      expect(result.kind).toBe(testCase.kind);
      if (testCase.rrule) {
        expect(result.rrule).toBe(testCase.rrule);
      } else {
        expect(result.rrule).toBeUndefined();
      }
    });
  }

  it("always preserves the original text verbatim", () => {
    for (const testCase of CASES) {
      expect(parseRecurrence(testCase.raw).raw).toBe(testCase.raw);
    }
  });

  it("never emits an rrule for an irregular recurrence", () => {
    for (const testCase of CASES.filter((c) => c.kind === "irregular")) {
      expect(parseRecurrence(testCase.raw).rrule).toBeUndefined();
    }
  });

  it("produces rrule strings that rrule itself can round-trip", async () => {
    const { RRule } = (await import("rrule")).default;
    for (const testCase of CASES.filter((c) => c.rrule)) {
      const parsed = parseRecurrence(testCase.raw);
      expect(() => RRule.fromString(`RRULE:${parsed.rrule}`)).not.toThrow();
    }
  });
});

/**
 * Guard rail against a well-meaning future "fix".
 *
 * "hver tredje/fjerde <ukedag>" reads two ways in Norwegian - every Nth week, or the
 * Nth occurrence in the month - and they fall on different dates. Read as an interval it
 * still needs an anchor date to count from, which the source never provides. So there is
 * no correct RRULE to emit here, only a plausible-looking wrong one.
 *
 * The fix is to report them to the source (admin@norgesquizforbund.no) so the correction
 * arrives in the next scrape. Do not teach the parser to guess, and do not park a
 * hand-checked schedule in data/overrides.json - see _note there for why we hold no
 * facts of our own about quiz schedules.
 */
describe("ambiguous interval phrasings stay irregular on purpose", () => {
  const AMBIGUOUS = [
    "Hver fjerde søndag",
    "Torsdag (hver tredje)",
    "Torsdag (hver fjerde)",
    "Hver tredje onsdag",
  ];

  for (const raw of AMBIGUOUS) {
    it(`refuses to guess a schedule for ${JSON.stringify(raw)}`, () => {
      const result = parseRecurrence(raw);
      expect(result.kind).toBe("irregular");
      expect(result.rrule).toBeUndefined();
      expect(result.raw).toBe(raw);
    });
  }

  it("still resolves annenhver, whose only reading is every other week", () => {
    const result = parseRecurrence("Annenhver tirsdag");
    expect(result.kind).toBe("biweekly");
    expect(result.rrule).toBe("FREQ=WEEKLY;BYDAY=TU;INTERVAL=2");
  });
});

describe("parseWeekday", () => {
  it("finds a single weekday regardless of qualifier", () => {
    expect(parseWeekday("Mandag (annenhver)")).toBe("mandag");
    expect(parseWeekday("Onsdager (annenhver)")).toBe("onsdag");
    expect(parseWeekday("Siste fredag i mnd")).toBe("fredag");
    expect(parseWeekday("Lørdag")).toBe("lordag");
    expect(parseWeekday("Søndag")).toBe("sondag");
  });

  it("returns null when there is no single unambiguous weekday", () => {
    expect(parseWeekday("Torsdag (eller fredag)")).toBeNull();
    expect(parseWeekday("En gang i måneden")).toBeNull();
    expect(parseWeekday("")).toBeNull();
  });
});

/**
 * Week parity is what makes a biweekly quiz answerable.
 *
 * "INTERVAL=2" says every other week but not which one, so without parity the site can
 * only say "maybe tonight". Parity is preferred over a DTSTART anchor because it is a
 * property of the calendar rather than of one season, so it never expires.
 */
describe("week parity on biweekly", () => {
  const ODD = [
    "Torsdag (oddetallsuker)",
    "Torsdag (annenhver - oddetallsuker)",
    "Tirsdag (annenhver, oddetallsuker)",
    "Torsdag (annenhver, ulik uke)",
  ];
  const EVEN = ["Torsdag (partallsuker)", "Mandag (annenhver - partallsuker)"];
  const NONE = ["Torsdag (annenhver)", "Annenhver mandag"];

  for (const raw of ODD) {
    it(`reads ${JSON.stringify(raw)} as odd weeks`, () => {
      const parsed = parseRecurrence(raw);
      expect(parsed.kind).toBe("biweekly");
      expect(parsed.weekParity).toBe("odd");
    });
  }

  for (const raw of EVEN) {
    it(`reads ${JSON.stringify(raw)} as even weeks`, () => {
      const parsed = parseRecurrence(raw);
      expect(parsed.kind).toBe("biweekly");
      expect(parsed.weekParity).toBe("even");
    });
  }

  for (const raw of NONE) {
    it(`leaves parity unset for ${JSON.stringify(raw)}`, () => {
      const parsed = parseRecurrence(raw);
      expect(parsed.kind).toBe("biweekly");
      expect(parsed.weekParity).toBeUndefined();
    });
  }

  // "ulike uker" (odd) and "like uker" (even) differ by one leading letter and mean the
  // opposite thing. Getting this backwards puts every affected quiz on the wrong week.
  it("does not read 'ulike uker' as even", () => {
    expect(parseRecurrence("Torsdag (annenhver, ulike uker)").weekParity).toBe("odd");
    expect(parseRecurrence("Torsdag (annenhver, like uker)").weekParity).toBe("even");
  });
});

/**
 * Spelling variants of words we already know.
 *
 * Both of these shipped to production classified as `weekly`, meaning the site told people
 * there was a quiz on a night there was not. That is the one error this parser exists to
 * prevent, so the fix normalizes before matching rather than adding one alternative per
 * misspelling - the same class had already appeared several times.
 */
describe("spelling variants of biweekly", () => {
  const VARIANTS = [
    // Live rows that were wrong: Radisson RED (Okern) and Pillarguri Cafe.
    "Tirsdag (Oddetalsuker)",
    "Fredag (annen hver)",
    // Same class, not currently in the data, but free to cover once compaction is in.
    "Fredag (annen-hver)",
    "Tirsdag (partalsuker)",
    "Mandag (Annenhver)",
  ];

  for (const raw of VARIANTS) {
    it(`reads ${JSON.stringify(raw)} as biweekly`, () => {
      expect(parseRecurrence(raw).kind).toBe("biweekly");
    });
  }

  it("keeps the parity that the misspelled row states", () => {
    expect(parseRecurrence("Tirsdag (Oddetalsuker)").weekParity).toBe("odd");
    expect(parseRecurrence("Tirsdag (partalsuker)").weekParity).toBe("even");
  });

  /**
   * The dangerous near-miss. Compaction removes spaces, so "hver andre" and a monthly
   * "den andre i hver maaned" both collapse towards the same letters. "Mandag (den andre i
   * hver maaned)" is the second Monday *of the month*, not every other Monday - reading it
   * as biweekly would put it on the wrong night roughly half the time.
   *
   * What separates them is the ordinal-plus-month guard, not the keyword list.
   */
  it("does not turn an ordinal monthly row into biweekly", () => {
    expect(parseRecurrence("Mandag (den andre i hver måned)").kind).toBe("monthly-nth");
    expect(parseRecurrence("Tirsdag (2. tirsdag hver måned)").kind).toBe("monthly-nth");
    expect(parseRecurrence("Mandag (den første i hver måned)").kind).toBe("monthly-nth");
  });

  // Compaction must not reach past the keyword tests into weekday detection.
  it("still finds the weekday in a compacted row", () => {
    expect(parseRecurrence("Tirsdag (Oddetalsuker)").rrule).toContain("TU");
    expect(parseRecurrence("Fredag (annen hver)").rrule).toContain("FR");
  });
});
