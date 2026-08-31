import { describe, expect, it } from "vitest";
import { cleanCategory, normalizeCategories, primaryCategory } from "../category.js";
import { normalizeRows } from "../normalize.js";
import { parseHtml } from "../parse.js";
import { quizId, slug, venueId } from "../slug.js";
import { normalizeTime } from "../time.js";
import { cleanVenue } from "../venue.js";
import { FIXED_NOW, loadFixture } from "./helpers.js";

describe("slug", () => {
  it("transliterates Norwegian characters deterministically", () => {
    expect(slug("Bølgen Kro")).toBe("boelgen-kro");
    expect(slug("Tromsø")).toBe("tromsoe");
    expect(slug("Ålesund")).toBe("aalesund");
    expect(slug("Ærlig Æsel")).toBe("aerlig-aesel");
    expect(slug("Café Marienlyst")).toBe("cafe-marienlyst");
    expect(slug("«Hullet i veggen»")).toBe("hullet-i-veggen");
  });

  it("collapses separators and trims", () => {
    expect(slug("  Bar   &  Scene  ")).toBe("bar-scene");
    expect(slug("--Pub--")).toBe("pub");
  });

  it("distinguishes venues that share a name across kommuner", () => {
    expect(venueId("Oslo", "Smelteverket")).not.toBe(venueId("Bergen", "Smelteverket"));
  });

  it("marks a missing time explicitly rather than dropping the segment", () => {
    expect(quizId("Oslo", "Skatten", "torsdag", null)).toBe("oslo-skatten-torsdag-natid");
    expect(quizId("Oslo", "Skatten", "torsdag", "18:00")).toBe(
      "oslo-skatten-torsdag-18-00",
    );
    expect(quizId("Oslo", "Skatten", null, "18:00")).toBe("oslo-skatten-ukjent-18-00");
  });

  it("disambiguates real collisions by meaning, not by row order", async () => {
    const { makeUnique } = await import("../slug.js");

    // Two quizzes at Vertshuset on Ålgård: one weekly Friday at 20:00, one on the last
    // Friday of the month at 20:00. Same kommune, venue, weekday and time.
    const base = quizId("Ålgård", "Vertshuset", "fredag", "20:00");

    const forward = new Set<string>();
    const a1 = makeUnique(base, forward, ["weekly", "allmenn"]);
    const a2 = makeUnique(base, forward, ["last-of-month", "allmenn"]);

    // Now the source reorders its table and emits them the other way round.
    const reversed = new Set<string>();
    const b2 = makeUnique(base, reversed, ["last-of-month", "allmenn"]);
    const b1 = makeUnique(base, reversed, ["weekly", "allmenn"]);

    expect(a1).toBe("aalgaard-vertshuset-fredag-20-00");
    expect(a2).toBe("aalgaard-vertshuset-fredag-20-00-last-of-month");
    // The weekly one keeps the bare id either way; the other keeps its meaningful suffix.
    expect(b1).toBe("aalgaard-vertshuset-fredag-20-00-weekly");
    expect(b2).toBe("aalgaard-vertshuset-fredag-20-00");
    expect(a2).toBe(`${base}-last-of-month`);
  });

  it("falls back to a counter when no hint can separate two entries", async () => {
    const { makeUnique } = await import("../slug.js");
    const taken = new Set<string>();
    expect(makeUnique("pub", taken, ["weekly"])).toBe("pub");
    expect(makeUnique("pub", taken, ["weekly"])).toBe("pub-weekly");
    expect(makeUnique("pub", taken, ["weekly"])).toBe("pub-2");
  });

  it("ignores volatile recurrence detail so ids survive source edits", async () => {    const { normalizeRows } = await import("../normalize.js");
    const { parseHtml } = await import("../parse.js");
    const html = await loadFixture();

    const before = normalizeRows(parseHtml(html), FIXED_NOW);
    // The source periodically rewrites the season range inside the weekday cell.
    const edited = html.replace(
      "h&oslash;stsesong 2024 fra 28/8 til 4/12",
      "v&aring;rsesong 2027 fra 14/1 til 20/5",
    );
    const after = normalizeRows(parseHtml(edited), FIXED_NOW);

    expect(after.quizzes.map((quiz) => quiz.id)).toEqual(
      before.quizzes.map((quiz) => quiz.id),
    );
  });
});

describe("cleanVenue", () => {
  it("pulls an address off a second line", () => {
    expect(cleanVenue("«Hullet i veggen»\n(Café Marienlyst, Kirkeveien 104)")).toEqual({
      name: "«Hullet i veggen»",
      addressHint: "Kirkeveien 104",
    });
  });

  it("pulls an address out of parentheses", () => {
    expect(cleanVenue("Bølgen Kro (Mikrobølgen 29, Munkelia)")).toEqual({
      name: "Bølgen Kro",
      addressHint: "Mikrobølgen 29, Munkelia",
    });
    expect(cleanVenue("Wembley Pub (Schouterrassen 25)")).toEqual({
      name: "Wembley Pub",
      addressHint: "Schouterrassen 25",
    });
  });

  it("survives the malformed parentheses in the live data", () => {
    expect(cleanVenue("Café Marienlyst\n(«Hullet i veggen»), Kirkeveien 104)")).toEqual({
      name: "Café Marienlyst",
      addressHint: "Kirkeveien 104",
    });
  });

  it("keeps non-address parentheticals as part of the name", () => {
    expect(cleanVenue("Kjøkkenet (Rockefeller)")).toEqual({
      name: "Kjøkkenet (Rockefeller)",
    });
    expect(cleanVenue("Radisson RED (Økern)")).toEqual({ name: "Radisson RED (Økern)" });
    expect(cleanVenue("Bror Bar (Piasquiz)")).toEqual({ name: "Bror Bar (Piasquiz)" });
    // A street name without a house number is not an address we can geocode.
    expect(cleanVenue("Stasjonen (Tordenskiolds gate)")).toEqual({
      name: "Stasjonen (Tordenskiolds gate)",
    });
  });

  it("collapses stray whitespace", () => {
    expect(cleanVenue("  Heim   Fredrikstad ")).toEqual({ name: "Heim Fredrikstad" });
  });
});

describe("normalizeTime", () => {
  it("normalizes the shapes the source actually uses", () => {
    expect(normalizeTime("19:00")).toBe("19:00");
    expect(normalizeTime("19.00")).toBe("19:00");
    expect(normalizeTime("9:05")).toBe("09:05");
    expect(normalizeTime("19")).toBe("19:00");
    expect(normalizeTime("kl 20")).toBe("20:00");
  });

  it("returns null rather than inventing a time", () => {
    expect(normalizeTime("?")).toBeNull();
    expect(normalizeTime("")).toBeNull();
    expect(normalizeTime(" ")).toBeNull();
    expect(normalizeTime("-")).toBeNull();
    expect(normalizeTime("varierer")).toBeNull();
    expect(normalizeTime("25:00")).toBeNull();
    expect(normalizeTime("19:75")).toBeNull();
  });
});

describe("normalizeCategories", () => {
  it("maps the common values to a single-element array", () => {
    expect(normalizeCategories("Allmenn")).toEqual(["allmenn"]);
    expect(normalizeCategories("Musikk")).toEqual(["musikk"]);
    expect(normalizeCategories("Sport")).toEqual(["sport"]);
    expect(normalizeCategories("Film")).toEqual(["film"]);
  });

  it("maps freeform variants", () => {
    expect(normalizeCategories("Allmenn (also in English)")).toEqual(["allmenn"]);
    expect(normalizeCategories("Rock")).toEqual(["musikk"]);
    expect(normalizeCategories("Popkultur")).toEqual(["musikk"]);
    expect(normalizeCategories("Musikkbingo")).toEqual(["musikk"]);
  });

  // "seriespill" is a league format for general quizzes, not a TV-series quiz. The
  // film rule must not reach into it.
  it("does not let seriespill trigger film", () => {
    expect(normalizeCategories("Allmenn (seriespill)")).toEqual(["allmenn"]);
    expect(normalizeCategories("Allmenn (ikke seriespill)")).toEqual(["allmenn"]);
  });

  // These are the real multi-genre strings from the source. Collapsing any of them to a
  // single value hides a quiz from a genre filter that should find it.
  it("keeps every genre a row names", () => {
    expect(normalizeCategories("Musikk og film")).toEqual(["musikk", "film"]);
    expect(normalizeCategories("Allmenn/film/musikk")).toEqual(["allmenn", "musikk", "film"]);
    expect(normalizeCategories("Allmenn og musikk")).toEqual(["allmenn", "musikk"]);
    expect(normalizeCategories("Allmenn/popkultur")).toEqual(["allmenn", "musikk"]);
    expect(normalizeCategories("Film og musikk")).toEqual(["musikk", "film"]);
    expect(normalizeCategories("Live musikk/Allmenn quiz")).toEqual(["allmenn", "musikk"]);
    expect(normalizeCategories("Musikk m/ liveband")).toEqual(["musikk"]);
  });

  it("orders genres by the fixed ranking, not by where they appear in the text", () => {
    expect(normalizeCategories("Musikk og allmenn")).toEqual(["allmenn", "musikk"]);
    expect(normalizeCategories("Allmenn og musikk")).toEqual(["allmenn", "musikk"]);
    expect(normalizeCategories("Film og musikk")).toEqual(["musikk", "film"]);
  });

  it("deduplicates when a genre is named twice", () => {
    expect(normalizeCategories("Musikk/musikkbingo")).toEqual(["musikk"]);
    expect(normalizeCategories("Allmenn – med påfølgende allmennquiz")).toEqual(["allmenn"]);
  });

  it("catches a second genre even without a clean separator", () => {
    expect(normalizeCategories("Allmenn – med påfølgende musikkquiz")).toEqual([
      "allmenn",
      "musikk",
    ]);
    expect(normalizeCategories("Annenhver allmennquiz og musikkbingo")).toEqual([
      "allmenn",
      "musikk",
    ]);
  });

  it("falls back to annet for genuinely unclassifiable text", () => {
    expect(normalizeCategories("IconaPopQuiz")).toEqual(["annet"]);
    expect(normalizeCategories("«Fakta om makta» - Samfunn og politikk")).toEqual(["annet"]);
    expect(normalizeCategories("Videospill")).toEqual(["annet"]);
    expect(normalizeCategories("")).toEqual(["annet"]);
  });

  it("never returns an empty array", () => {
    for (const raw of ["", "   ", "??", "Sjekk programmet", "Kvalifisert gjetning"]) {
      expect(normalizeCategories(raw).length).toBeGreaterThan(0);
    }
  });

  it("exposes the broadest genre as the id tie-breaker", () => {
    expect(primaryCategory("Allmenn/film/musikk")).toBe("allmenn");
    expect(primaryCategory("Musikk og film")).toBe("musikk");
    expect(primaryCategory("Videospill")).toBe("annet");
  });

  it("keeps the original text readable", () => {
    expect(cleanCategory("Allmenn\nMusikk")).toBe("Allmenn / Musikk");
    expect(cleanCategory("  Allmenn  ")).toBe("Allmenn");
  });
});

describe("normalizeRows over the fixture", () => {
  async function normalizeFixture() {
    return normalizeRows(parseHtml(await loadFixture()), FIXED_NOW);
  }

  it("produces one venue per distinct place and one quiz per row", async () => {
    const result = await normalizeFixture();
    expect(result.quizzes).toHaveLength(17);
    // 17 rows, but Skatten appears twice, so 16 distinct venues.
    expect(result.venues).toHaveLength(16);
    expect(result.warnings).toEqual([]);
  });

  it("carries the fylke and kommune down onto the venue", async () => {
    const result = await normalizeFixture();
    const olavs = result.venues.find((venue) => venue.name === "Olavs pub");
    expect(olavs).toMatchObject({
      id: "greaaker-olavs-pub",
      kommune: "Greåker",
      fylke: "Østfold",
    });
    expect(olavs?.url).toBeUndefined();
  });

  it("links both halves of a split row to the same venue", async () => {
    const result = await normalizeFixture();
    const skatten = result.quizzes.filter((quiz) => quiz.venueId === "oslo-skatten");
    expect(skatten).toHaveLength(2);
    expect(skatten.map((quiz) => [quiz.time, quiz.categoryNorm]).sort()).toEqual([
      ["18:00", ["allmenn"]],
      ["20:30", ["musikk"]],
    ]);
    expect(result.venues.filter((venue) => venue.id === "oslo-skatten")).toHaveLength(1);
  });

  it("normalizes times and admits when it does not know one", async () => {
    const result = await normalizeFixture();
    const byVenue = new Map(result.quizzes.map((quiz) => [quiz.venueId, quiz]));
    // "19.00" in the source.
    expect(byVenue.get("kolbotn-boelgen-kro")?.time).toBe("19:00");
    // "?" in the source.
    expect(byVenue.get("oslo-wembley-pub")?.time).toBeNull();
    // Empty cell in the source.
    expect(byVenue.get("oslo-kjoekkenet-rockefeller")?.time).toBeNull();
  });

  it("keeps the untouched venue text in rawName", async () => {
    const result = await normalizeFixture();
    const marienlyst = result.venues.find((venue) => venue.name === "Café Marienlyst");
    expect(marienlyst?.rawName).toBe("Café Marienlyst\n(«Hullet i veggen»), Kirkeveien 104)");
    expect(marienlyst?.addressHint).toBe("Kirkeveien 104");
  });

  it("matches the full expected output", async () => {
    const result = await normalizeFixture();
    expect({
      sourceUpdatedAt: result.sourceUpdatedAt,
      venues: result.venues,
      quizzes: result.quizzes,
    }).toMatchSnapshot();
  });
});
