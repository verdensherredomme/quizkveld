import { describe, expect, it } from "vitest";
import { extractSourceUpdatedAt, parseHtml, splitRowVariants } from "../parse.js";
import { loadFixture } from "./helpers.js";

describe("parseHtml", () => {
  it("reads the 'Sist oppdatert' date from the page", async () => {
    const result = parseHtml(await loadFixture());
    expect(result.sourceUpdatedAt).toBe("2026-07-27");
  });

  it("parses every data row without warnings", async () => {
    const result = parseHtml(await loadFixture());
    // 16 table rows, one of which (Skatten) splits into two quizzes.
    expect(result.rows).toHaveLength(17);
    expect(result.warnings).toEqual([]);
  });

  it("attributes each row to the fylke heading above it", async () => {
    const result = parseHtml(await loadFixture());
    const byFylke = new Map<string, number>();
    for (const row of result.rows) {
      byFylke.set(row.fylke, (byFylke.get(row.fylke) ?? 0) + 1);
    }
    expect(Object.fromEntries(byFylke)).toEqual({
      Østfold: 4,
      Oslo: 8,
      Akershus: 3,
      Troms: 2,
    });
  });

  it("takes the venue url from the venue cell only", async () => {
    const result = parseHtml(await loadFixture());

    const heim = result.rows.find((row) => row.venueRaw.includes("Heim"));
    expect(heim?.venueUrl).toBe("https://www.heim.no/events/heim-quiz#fredrikstad");

    // Unlinked venue.
    const olavs = result.rows.find((row) => row.venueRaw === "Olavs pub");
    expect(olavs?.venueUrl).toBeUndefined();

    // Hells Kitchen has links in the weekday and category cells too; those are
    // decoration and must not be mistaken for the venue url.
    const hells = result.rows.find((row) => row.venueRaw === "Hells Kitchen");
    expect(hells?.venueUrl).toBe("https://www.hellskitchenoslo.no/");
    expect(hells?.weekdayRaw).toBe("Onsdag (oddetallsuker)");
    expect(hells?.categoryRaw).toBe("Allmenn");
  });

  it("splits a row that encodes two quizzes into two rows", async () => {
    const result = parseHtml(await loadFixture());
    const skatten = result.rows.filter((row) => row.venueRaw === "Skatten");
    expect(skatten).toHaveLength(2);
    expect(skatten.map((row) => [row.timeRaw, row.categoryRaw])).toEqual([
      ["18:00", "Allmenn"],
      ["20:30", "Musikk"],
    ]);
    // Both halves keep the shared weekday.
    expect(new Set(skatten.map((row) => row.weekdayRaw))).toEqual(new Set(["Torsdag"]));
  });

  it("decodes html entities and preserves the newline inside a venue name", async () => {
    const result = parseHtml(await loadFixture());

    const marienlyst = result.rows.find((row) => row.venueRaw.startsWith("Café"));
    expect(marienlyst?.venueRaw).toBe(
      "Café Marienlyst\n(«Hullet i veggen»), Kirkeveien 104)",
    );

    const nydalen = result.rows.find((row) => row.venueRaw.startsWith("Nydalen"));
    // &#8211; is an en dash, not a hyphen.
    expect(nydalen?.weekdayRaw).toBe(
      "Onsdager (annenhver – høstsesong 2024 fra 28/8 til 4/12)",
    );
  });

  it("keeps empty and unknown times as raw text for the normalizer to judge", async () => {
    const result = parseHtml(await loadFixture());
    const wembley = result.rows.find((row) => row.venueRaw.startsWith("Wembley"));
    expect(wembley?.timeRaw).toBe("?");

    const kjokkenet = result.rows.find((row) => row.venueRaw.startsWith("Kjøkkenet"));
    expect(kjokkenet?.timeRaw).toBe("");
  });

  it("throws a clear error when the table is missing entirely", () => {
    expect(() => parseHtml("<html><body><p>ingen tabell her</p></body></html>")).toThrow(
      /endret struktur/,
    );
  });
});

describe("extractSourceUpdatedAt", () => {
  it("pads single-digit days and months", () => {
    expect(extractSourceUpdatedAt("Sist oppdatert: 3.9.2025")).toBe("2025-09-03");
  });

  it("returns null when the date is absent", () => {
    expect(extractSourceUpdatedAt("ingen dato her")).toBeNull();
  });
});

describe("splitRowVariants", () => {
  it("pairs equal numbers of segments", () => {
    expect(splitRowVariants("18:00\n20:30", "Allmenn\nMusikk")).toEqual([
      { timeRaw: "18:00", categoryRaw: "Allmenn" },
      { timeRaw: "20:30", categoryRaw: "Musikk" },
    ]);
  });

  it("repeats a single value across several segments", () => {
    expect(splitRowVariants("18:00\n20:30", "Allmenn")).toEqual([
      { timeRaw: "18:00", categoryRaw: "Allmenn" },
      { timeRaw: "20:30", categoryRaw: "Allmenn" },
    ]);
  });

  it("keeps the row intact when the segment counts cannot be reconciled", () => {
    const result = splitRowVariants("18:00\n20:30\n22:00", "Allmenn\nMusikk");
    expect(result).toEqual([
      { timeRaw: "18:00\n20:30\n22:00", categoryRaw: "Allmenn\nMusikk" },
    ]);
  });

  it("leaves single-value cells alone", () => {
    expect(splitRowVariants("19:00", "Allmenn")).toEqual([
      { timeRaw: "19:00", categoryRaw: "Allmenn" },
    ]);
  });
});

/**
 * The source runs a link checker and strikes dead links through with class="broken_link".
 * That is a judgement they have already made and published; dropping it would leave every
 * link looking equally trustworthy when we know better.
 */
describe("dead links flagged by the source", () => {
  it("marks the venue link the source struck through", async () => {
    const result = parseHtml(await loadFixture());
    const samfundet = result.rows.find((r) => r.venueRaw.includes("Samfundet"));
    expect(samfundet?.venueUrl).toBe("http://ukaihalden.no/hss/");
    expect(samfundet?.venueUrlBroken).toBe(true);
  });

  it("leaves live links unflagged rather than setting false", async () => {
    const result = parseHtml(await loadFixture());
    const heim = result.rows.find((r) => r.venueRaw.includes("Heim Fredrikstad"));
    expect(heim?.venueUrl).toBeTruthy();
    expect(heim?.venueUrlBroken).toBeUndefined();
  });

  // The weekday cell sometimes carries its own link. Only the venue cell's link is the
  // venue's, so a broken marker elsewhere in the row must not leak onto it.
  it("ignores links outside the venue cell", async () => {
    const result = parseHtml(await loadFixture());
    const hells = result.rows.find((r) => r.venueRaw.includes("Hells Kitchen"));
    expect(hells?.venueUrl).toBe("https://www.hellskitchenoslo.no/");
  });
});

/**
 * Every one of the 103 Facebook links on the live page carries class="broken_link" - a
 * 100 % failure rate that is the checker being blocked, not 103 dead pages. Instagram
 * links on the same page are not flagged, which is what pins it to Facebook specifically.
 *
 * Passing the verdict through would strike out the links most likely to be current, since
 * a pub's Facebook page is usually its most actively maintained channel.
 */
describe("link checker blind spots", () => {
  it("does not trust the dead-link mark on Facebook", async () => {
    const result = parseHtml(await loadFixture());
    const gulating = result.rows.find((r) => r.venueRaw.includes("Gulating"));
    expect(gulating?.venueUrl).toContain("facebook.com");
    expect(gulating?.venueUrlBroken).toBeUndefined();
  });

  it("still trusts it on hosts the checker can reach", async () => {
    const result = parseHtml(await loadFixture());
    const samfundet = result.rows.find((r) => r.venueRaw.includes("Samfundet"));
    expect(samfundet?.venueUrlBroken).toBe(true);
  });
});
