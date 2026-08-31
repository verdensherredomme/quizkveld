import { describe, expect, it } from "vitest";
import {
  bestMatch,
  diceCoefficient,
  matchVenueName,
  normalizeVenueName,
  tokens,
} from "../venuematch.js";

/**
 * Name matching decides whether a pub gets placed on the right building, the wrong one,
 * or none at all. The bias throughout is "no match beats a wrong match": an unplaced pub
 * is a visible gap, a mis-placed one is an invisible lie.
 */

describe("normalizeVenueName", () => {
  it("strips the quotation marks the source is fond of", () => {
    expect(normalizeVenueName("«Hullet i veggen»")).toBe("hullet i veggen");
  });

  it("drops parenthetical asides, which are usually an address", () => {
    expect(normalizeVenueName("Bølgen Kro (Mikrobølgen 29, Munkelia)")).toBe("boelgen kro");
  });

  it("folds Norwegian characters", () => {
    expect(normalizeVenueName("Ærlig Øl Ås")).toBe("aerlig oel aas");
  });

  it("treats & and 'og' the same", () => {
    expect(normalizeVenueName("Kaffe & Kake")).toBe(normalizeVenueName("Kaffe og Kake"));
  });
});

describe("tokens", () => {
  it("can drop words that describe the kind of place rather than which place", () => {
    expect(tokens("Dirty Nelly Pub", true)).toEqual(["dirty", "nelly"]);
    expect(tokens("Dirty Nelly Pub")).toEqual(["dirty", "nelly", "pub"]);
  });
});

describe("diceCoefficient", () => {
  it("is 1 for identical strings and 0 for nothing in common", () => {
    expect(diceCoefficient("kvarteret", "kvarteret")).toBe(1);
    expect(diceCoefficient("abcd", "wxyz")).toBe(0);
  });
});

describe("matchVenueName", () => {
  it("matches through decoration", () => {
    expect(matchVenueName("«Hullet i veggen»", "Hullet i veggen")?.kind).toBe("exact");
  });

  it("matches when only a generic word differs", () => {
    expect(matchVenueName("Dirty Nelly", "Dirty Nelly Pub")?.kind).toBe("exact");
    expect(matchVenueName("Bølgen Kro", "Bølgen")?.kind).toBe("exact");
  });

  it("tolerates a small spelling difference", () => {
    const match = matchVenueName("Kvarteret", "Kvarterett");
    expect(match?.kind).toBe("fuzzy");
  });

  it("refuses unrelated names", () => {
    expect(matchVenueName("Skatten", "Samfundet")).toBeNull();
    expect(matchVenueName("Kvarteret", "Bergen Kjøtt")).toBeNull();
  });

  /**
   * The dangerous near-miss: two venues whose names differ only in a digit or a single
   * distinguishing word. These must not match.
   */
  it("refuses near-misses that differ in the part that matters", () => {
    expect(matchVenueName("Bar 1", "Bar 9")).toBeNull();
    expect(matchVenueName("Café Sør", "Café Nord")).toBeNull();
  });

  it("refuses a bare generic word, which would match half the country", () => {
    expect(matchVenueName("Pub", "Puben på hjørnet")).toBeNull();
  });

  it("returns nothing for empty input", () => {
    expect(matchVenueName("", "Kvarteret")).toBeNull();
    expect(matchVenueName("«»", "Kvarteret")).toBeNull();
  });
});

describe("bestMatch", () => {
  const candidates = [
    { name: "Bergen Kjøtt", lat: 60.39, lon: 5.32 },
    { name: "Kvarteret", lat: 60.3878, lon: 5.3237 },
    { name: "Kvarterett", lat: 60.3, lon: 5.3 },
  ];

  it("prefers the exact match over the fuzzy one", () => {
    const best = bestMatch("Kvarteret", candidates);
    expect(best?.candidate.name).toBe("Kvarteret");
    expect(best?.match.kind).toBe("exact");
    expect(best?.ambiguous).toBe(false);
  });

  it("returns nothing when no candidate is close enough", () => {
    expect(bestMatch("Samfundet", candidates)).toBeNull();
  });

  /**
   * Chains are the reason this flag exists. "O'Learys" has branches in several towns and
   * sometimes two inside one kommune; picking the first one silently would be a coin
   * flip, so the caller is told instead.
   */
  it("flags the case where two different places match equally well", () => {
    const best = bestMatch("O'Learys", [
      { name: "O'Learys", lat: 59.91, lon: 10.75 },
      { name: "O'Learys", lat: 59.93, lon: 10.78 },
    ]);
    expect(best?.ambiguous).toBe(true);
  });

  it("does not flag two records of the same place as ambiguous", () => {
    const best = bestMatch("Kvarteret", [
      { name: "Kvarteret", lat: 60.3878, lon: 5.3237 },
      { name: "kvarteret", lat: 60.3878, lon: 5.3237 },
    ]);
    expect(best?.ambiguous).toBe(false);
  });

  it("handles an empty candidate list", () => {
    expect(bestMatch("Kvarteret", [])).toBeNull();
  });
});

/**
 * Cases taken verbatim from the first real geocoding run against OpenStreetMap.
 *
 * The first run accepted all four of the rejections below as "strong" matches, because
 * containment only required the shorter name to appear inside the longer one. Sharing a
 * single token is not evidence of being the same business - and a pub placed on top of a
 * different pub is the failure mode nobody reports, so these stay locked down.
 */
describe("matchVenueName against real OSM data", () => {
  const oslo = { placeWords: ["Oslo"] };

  it("rejects a chain sharing one token with a different business", () => {
    // Bølgen Kro is not Bølgen & Moi.
    expect(matchVenueName("Bølgen Kro", "Bølgen & Moi", oslo)).toBeNull();
  });

  it("rejects an OSM name that prepends a different brand", () => {
    // Hinna Bistro is not Dolly Dimples' branch at Hinna.
    expect(matchVenueName("Hinna Bistro", "Dolly Dimples Hinna", { placeWords: ["Stavanger"] })).toBeNull();
  });

  it("rejects a near-identical word that means a different venue", () => {
    // The parenthesis is stripped before comparing, so this reduces to
    // "kjokkenet" vs "kjokken" - 0.86 on bigrams, and still the wrong pub.
    expect(matchVenueName("Kjøkkenet (Rockefeller)", "Kjøkken og Bar", oslo)).toBeNull();
  });

  it("accepts an OSM name whose only extra word is generic", () => {
    expect(matchVenueName("Glasset", "Glasset Vinbar", oslo)?.kind).toBe("exact");
    expect(matchVenueName("Dr. Jekyll", "Dr. Jekyll's Pub", oslo)?.kind).toBe("exact");
  });

  it("accepts an OSM name whose only extra word is the place itself", () => {
    expect(matchVenueName("Skatten", "Skatten Oslo", oslo)?.kind).toBe("strong");
    // Egersund the town vs Eigersund the kommune - one letter apart, same place.
    expect(
      matchVenueName("Grand Hotel", "Grand hotell Egersund", { placeWords: ["Eigersund", "Egersund"] })?.kind,
    ).toBe("strong");
  });

  it("accepts extra words on the source side as the volunteer's location context", () => {
    expect(matchVenueName("Postkontoret på Tøyen", "Postkontoret", oslo)?.kind).toBe("strong");
    expect(matchVenueName("Alexandria Sports Bar & Music", "Alexandria", oslo)?.kind).toBe("strong");
  });

  it("treats compound spelling differences as the same name", () => {
    expect(matchVenueName("Flyfisher", "The Fly Fisher", oslo)?.kind).toBe("exact");
  });

  it("still matches the genuine spelling variants", () => {
    expect(matchVenueName("Heidi’s Bier Bar", "Heidi's Beer Bar", oslo)).not.toBeNull();
    expect(matchVenueName("Pane & Vino", "Pane e Vino", oslo)).not.toBeNull();
    expect(matchVenueName("Kafé Arv & Retro", "Arv Kaffe & Retro", oslo)).not.toBeNull();
  });
});

/**
 * Three different pubs in Jessheim all matched the same "Jessheim pizzeria" on the live
 * run, because the only token they shared with it was the name of the town. Sharing a
 * place name is not evidence of being the same place - it is evidence of being in the
 * same place.
 */
describe("matchVenueName when the only shared word is the place name", () => {
  const jessheim = { placeWords: ["Ullensaker", "Jessheim"] };

  it.each(["Heim Jessheim", "O’Connors Jessheim", "Peppes Jessheim"])(
    "rejects %s against Jessheim pizzeria",
    (source) => {
      expect(matchVenueName(source, "Jessheim pizzeria", jessheim)).toBeNull();
    },
  );

  it("still accepts a real name that happens to sit in the same town", () => {
    expect(matchVenueName("Heim Jessheim", "Heim", jessheim)?.kind).toBe("strong");
  });
});
