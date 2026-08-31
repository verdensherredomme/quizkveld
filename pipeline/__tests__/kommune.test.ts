import { describe, expect, it } from "vitest";
import {
  LEGACY_FYLKE_TO_NR,
  expectedFylkeNr,
  indexRegister,
  normalizePlace,
  placeTypeRank,
  resolvePlace,
  stripPlaceQualifier,
  type StedsnavnCandidate,
} from "../kommune.js";
import { KommuneRegisterSchema } from "../schema.js";
import fixture from "./fixtures/kommuner.json" with { type: "json" };

/**
 * The source's "kommune" column is a place name a volunteer typed, not a kommune. Getting
 * this wrong moves a pub to another town while looking perfectly fine, so the cases below
 * are all drawn from real rows that actually broke.
 */

const register = KommuneRegisterSchema.parse(fixture);
const index = indexRegister(register.kommuner);

function resolve(place: string, fylke: string, stedsnavn?: StedsnavnCandidate[]) {
  return resolvePlace({ place, fylke, index, stedsnavn });
}

describe("normalizePlace / stripPlaceQualifier", () => {
  it("strips the human disambiguator", () => {
    expect(stripPlaceQualifier("Bø i Telemark")).toBe("Bø");
    expect(stripPlaceQualifier("Herøy i Nordland")).toBe("Herøy");
    expect(stripPlaceQualifier("Nes kommune")).toBe("Nes");
  });

  it("folds Norwegian characters and casing together", () => {
    expect(normalizePlace("Ålgård")).toBe(normalizePlace("ålgård"));
    expect(normalizePlace("Ås")).toBe("aas");
    expect(normalizePlace("Tromsø")).toBe("tromsoe");
  });

  it("leaves an ordinary name alone", () => {
    expect(stripPlaceQualifier("Sarpsborg")).toBe("Sarpsborg");
  });
});

describe("expectedFylkeNr", () => {
  it("maps pre-2020 fylke names to today's numbers", () => {
    expect(expectedFylkeNr("Hordaland")).toBe("46");
    expect(expectedFylkeNr("Sogn og Fjordane")).toBe("46");
    expect(expectedFylkeNr("Sør-Trøndelag")).toBe("50");
    expect(expectedFylkeNr("Vest-Agder")).toBe("42");
  });

  it("returns null for Svalbard, which is not a fylke", () => {
    expect(expectedFylkeNr("Svalbard")).toBeNull();
    expect(LEGACY_FYLKE_TO_NR["Svalbard"]).toBeNull();
  });

  it("returns null for something it has never heard of", () => {
    expect(expectedFylkeNr("Atlantis")).toBeNull();
  });
});

describe("placeTypeRank", () => {
  /**
   * Farms are the classic false positive: Norway is covered in them, and their names
   * collide with towns. "Rygge" is a parish in Moss and also a farm in Indre Østfold.
   * An unknown type must therefore outrank a known farm.
   */
  it("ranks farms below an unknown type", () => {
    expect(placeTypeRank("Gard")).toBeLessThan(placeTypeRank("En type vi ikke kjenner"));
    expect(placeTypeRank("Navnegard")).toBeLessThan(placeTypeRank("Sokn"));
  });

  it("ranks settlements above everything else", () => {
    expect(placeTypeRank("Tettsted")).toBeGreaterThan(placeTypeRank("Sokn"));
    expect(placeTypeRank("By")).toBeGreaterThan(placeTypeRank("Tettsted"));
  });
});

describe("resolvePlace - direct kommune matches", () => {
  it("resolves a place that simply is a kommune", () => {
    const outcome = resolve("Bergen", "Hordaland");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entry).toMatchObject({
      kommuneNr: "4601",
      kommuneName: "Bergen",
      fylkeNow: "Vestland",
      method: "exact",
    });
  });

  /**
   * The 2024 split did not restore the pre-2020 boundaries exactly: Jevnaker went
   * Oppland -> Viken -> Akershus. An exact name match is strong enough to accept anyway,
   * but it must say so rather than pretend the fylke agreed.
   */
  it("accepts an exact name match even when the fylke moved, and says so", () => {
    const outcome = resolve("Jevnaker", "Oppland");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entry.kommuneNr).toBe("3236");
    expect(outcome.entry.fylkeNow).toBe("Akershus");
    expect(outcome.entry.note).toMatch(/Oppland/);
  });

  it("uses the fylke to pick between kommuner that share a name", () => {
    const ostfold = resolve("Våler", "Østfold");
    expect(ostfold.ok).toBe(true);
    if (ostfold.ok) expect(ostfold.entry.kommuneNr).toBe("3114");

    const innlandet = resolve("Våler", "Hedmark");
    expect(innlandet.ok).toBe(true);
    if (innlandet.ok) expect(innlandet.entry.kommuneNr).toBe("3419");
  });

  it("refuses to choose when the fylke does not separate the namesakes", () => {
    const outcome = resolve("Våler", "Nordland");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.candidates).toHaveLength(2);
  });
});

describe("resolvePlace - the Bø trap", () => {
  /**
   * Regression test. "Bø i Telemark" normalizes to "Bø", and the only kommune called Bø
   * today is in Nordland - 900 km away. An earlier version accepted that silently
   * because it compared the *stripped* name and called it an exact match.
   */
  it("does not accept Bø in Nordland for Bø i Telemark", () => {
    const outcome = resolve("Bø i Telemark", "Telemark");
    expect(outcome.ok).toBe(false);
  });

  it("resolves it correctly once the place-name register is consulted", () => {
    const outcome = resolve("Bø i Telemark", "Telemark", [
      { navn: "Bø", type: "Tettsted", kommunenummer: "4020" },
      { navn: "Bø", type: "Grend", kommunenummer: "1867" },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entry).toMatchObject({
      kommuneNr: "4020",
      kommuneName: "Midt-Telemark",
      method: "stedsnavn",
    });
  });
});

describe("resolvePlace - the Rygge trap", () => {
  /**
   * Regression test. Kartverket has "Rygge" as a parish in Moss and as a farm in Indre
   * Østfold. Both are in fylke 31, so the fylke cannot separate them - the place *type*
   * has to. An earlier ranking put the farm first and moved the pub 40 km.
   */
  it("prefers the parish in Moss over the farm in Indre Østfold", () => {
    const outcome = resolve("Rygge", "Østfold", [
      { navn: "Rygge", type: "Gard", kommunenummer: "3118" },
      { navn: "Rygge", type: "Sokn", kommunenummer: "3103" },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entry.kommuneName).toBe("Moss");
  });
});

describe("resolvePlace - place names inside a kommune", () => {
  it("resolves a tettsted to the kommune it sits in", () => {
    const outcome = resolve("Jessheim", "Akershus", [
      { navn: "Jessheim", type: "Tettsted", kommunenummer: "3209" },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entry).toMatchObject({ kommuneName: "Ullensaker", method: "stedsnavn" });
  });

  it("rejects a hit that lands in a different fylke than the source claims", () => {
    const outcome = resolve("Jessheim", "Nordland", [
      { navn: "Jessheim", type: "Tettsted", kommunenummer: "3209" },
    ]);
    expect(outcome.ok).toBe(false);
  });

  it("rejects a hit whose name is only similar, not equal", () => {
    const outcome = resolve("Jessheim", "Akershus", [
      { navn: "Jessheimbyen", type: "Tettsted", kommunenummer: "3209" },
    ]);
    expect(outcome.ok).toBe(false);
  });

  it("reports honestly when there is nothing to go on", () => {
    const outcome = resolve("Sandnesseter", "Akershus", []);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/Sandnesseter/);
  });

  it("cannot resolve Svalbard, because it has no kommune", () => {
    const outcome = resolve("Longyearbyen", "Svalbard", []);
    expect(outcome.ok).toBe(false);
  });
});
