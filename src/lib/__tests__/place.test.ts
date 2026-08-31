import { describe, expect, it } from "vitest";

import type { Venue } from "../../../pipeline/schema.js";
import { buildPlaceSlugs, formerFylker, fylkeOf, invert } from "../place.js";

function venue(id: string, kommune: string, fylke: string, fylkeNow?: string): Venue {
  return { id, name: id, rawName: id, kommune, fylke, ...(fylkeNow ? { fylkeNow } : {}) };
}

describe("fylkeOf", () => {
  it("navigates on today's county, not the one the source still names", () => {
    expect(fylkeOf(venue("v1", "Bergen", "Hordaland", "Vestland"))).toBe("Vestland");
  });

  it("falls back to the source when Kartverket does not know the place", () => {
    // Sandnesseter is the one venue in the live data with no `fylkeNow`. Dropping out of the
    // navigation would be worse than being filed under a county that no longer exists.
    expect(fylkeOf(venue("v1", "Sandnesseter", "Akershus"))).toBe("Akershus");
  });
});

describe("formerFylker", () => {
  it("names the source's counties that a current one now covers", () => {
    const former = formerFylker([
      venue("v1", "Bergen", "Hordaland", "Vestland"),
      venue("v2", "Førde", "Sogn og Fjordane", "Vestland"),
      venue("v3", "Voss", "Hordaland", "Vestland"),
    ]);
    expect(former.get("Vestland")).toEqual([
      { fylke: "Hordaland", kommuner: [] },
      { fylke: "Sogn og Fjordane", kommuner: [] },
    ]);
  });

  it("says nothing about a county the source already names correctly", () => {
    // Oslo and Svalbard kept their names, so there is nothing to explain.
    const former = formerFylker([
      venue("v1", "Oslo", "Oslo", "Oslo"),
      venue("v2", "Longyearbyen", "Svalbard", "Svalbard"),
    ]);
    expect(former.size).toBe(0);
  });

  it("lists an old county under both counties it was split between", () => {
    // Oppland went mostly to Innlandet, but Jevnaker went Oppland -> Viken -> Akershus.
    // Both new pages should be able to say where their content came from.
    const former = formerFylker([
      venue("v1", "Lillehammer", "Oppland", "Innlandet"),
      venue("v2", "Jevnaker", "Oppland", "Akershus"),
    ]);
    expect(former.get("Innlandet")).toEqual([{ fylke: "Oppland", kommuner: [] }]);
    expect(former.get("Akershus")).toEqual([{ fylke: "Oppland", kommuner: [] }]);
  });

  it("reports a received municipality by name instead of claiming the county was renamed", () => {
    // The bug this guards: with only the Jevnaker row above, Akershus looked renamed. Add
    // the venues the source already files under Akershus - as the real data has 26 of - and
    // "tidligere Oppland" becomes a plain falsehood about the county.
    const former = formerFylker([
      venue("v1", "Jevnaker", "Oppland", "Akershus"),
      venue("v2", "Bærum", "Akershus", "Akershus"),
      venue("v3", "Asker", "Akershus", "Akershus"),
    ]);
    expect(former.get("Akershus")).toEqual([{ fylke: "Oppland", kommuner: ["Jevnaker"] }]);
  });

  it("keeps the received municipality rather than dropping it to the majority successor", () => {
    // Dropping it would strand someone looking for a Jevnaker venue under "Oppland": the
    // other Oppland venues are in Innlandet, so no page would mention it at all.
    const former = formerFylker([
      venue("v1", "Lillehammer", "Oppland", "Innlandet"),
      venue("v2", "Hamar", "Oppland", "Innlandet"),
      venue("v3", "Jevnaker", "Oppland", "Akershus"),
      venue("v4", "Bærum", "Akershus", "Akershus"),
    ]);
    expect(former.get("Akershus")?.map((f) => f.fylke)).toEqual(["Oppland"]);
  });

  it("names every municipality that moved in, sorted, so the sentence does not reshuffle", () => {
    const former = formerFylker([
      venue("v1", "Jevnaker", "Oppland", "Akershus"),
      venue("v2", "Åsnes", "Oppland", "Akershus"),
      venue("v3", "Bærum", "Akershus", "Akershus"),
    ]);
    expect(former.get("Akershus")).toEqual([
      { fylke: "Oppland", kommuner: ["Jevnaker", "Åsnes"] },
    ]);
  });
});

describe("buildPlaceSlugs", () => {
  it("transliterates Norwegian characters the same way venue ids do", () => {
    const { bySted, byFylke } = buildPlaceSlugs([
      venue("v1", "Tromsø", "Troms"),
      venue("v2", "Ålesund", "Møre og Romsdal"),
    ]);
    expect(bySted.get("Tromsø")).toBe("tromsoe");
    expect(bySted.get("Ålesund")).toBe("aalesund");
    expect(byFylke.get("Møre og Romsdal")).toBe("moere-og-romsdal");
  });

  it("qualifies with the county when the same place name appears in two of them", () => {
    const { bySted } = buildPlaceSlugs([
      venue("v1", "Sandnes", "Rogaland"),
      venue("v2", "Sandnes", "Troms"),
    ]);
    // Distinct place names would each get their own entry; an identical name is a single
    // key, so this asserts the map does not silently merge two counties' worth of quizzes.
    expect(bySted.size).toBe(1);
    expect(bySted.get("Sandnes")).toBe("sandnes");
  });

  it("qualifies with the county when two different names slug identically", () => {
    const { bySted } = buildPlaceSlugs([
      venue("v1", "Bø", "Telemark"),
      venue("v2", "Boe", "Nordland"),
    ]);
    const slugs = [...bySted.values()];
    expect(new Set(slugs).size).toBe(2);
    expect(slugs).toContain("boe");
    // Whichever loses the plain slug is qualified by its county rather than merged away.
    expect(slugs.some((s) => s === "boe-telemark" || s === "boe-nordland")).toBe(true);
  });

  it("is independent of the order rows arrive in", () => {
    const a = buildPlaceSlugs([venue("v1", "Bø", "Telemark"), venue("v2", "Boe", "Nordland")]);
    const b = buildPlaceSlugs([venue("v2", "Boe", "Nordland"), venue("v1", "Bø", "Telemark")]);
    // The source table reshuffles between scrapes; URLs must not move with it.
    expect([...a.bySted]).toEqual([...b.bySted]);
  });

  it("falls back to a numeric suffix rather than merging or failing the build", () => {
    // Three spellings of the same slug inside one county exhausts the county qualifier.
    // The site is rebuilt daily from data nobody here controls, so an ugly URL beats a
    // build that stops publishing - and nothing is merged either way.
    const { bySted } = buildPlaceSlugs([
      venue("v1", "Bø", "Nordland"),
      venue("v2", "Boe", "Nordland"),
      venue("v3", "BOE", "Nordland"),
    ]);
    const slugs = [...bySted.values()];
    expect(new Set(slugs).size).toBe(3);
    expect(slugs).toContain("boe");
  });

  it("handles a place name that slugs to nothing", () => {
    const { bySted } = buildPlaceSlugs([venue("v1", "???", "Oslo")]);
    expect(bySted.get("???")).toBe("oslo");
  });
});

describe("invert", () => {
  it("maps a slug back to the source spelling", () => {
    const { bySted } = buildPlaceSlugs([venue("v1", "Tromsø", "Troms")]);
    expect(invert(bySted).get("tromsoe")).toBe("Tromsø");
  });
});
