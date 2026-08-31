import { describe, expect, it } from "vitest";
import { buildQuery } from "../overpass.js";
import type { Kommune } from "../schema.js";

const oslo: Kommune = {
  nr: "0301",
  navn: "Oslo",
  fylkesnr: "03",
  fylke: "Oslo",
  point: { lat: 59.9723, lon: 10.7757 },
  bbox: [10.4891, 59.8093, 10.9513, 60.1351],
};

describe("buildQuery", () => {
  /**
   * Regression guard for a real bug. The first live run returned 49 places for the whole
   * of Oslo instead of 1500+, because the query listed several `nwr` statements without a
   * union. In Overpass QL a bare `out` emits only the *last* statement's result set, so
   * every earlier statement was silently discarded - no error, just missing data. Anyone
   * adding a statement here must keep it inside the parentheses.
   */
  it("wraps every statement in a union so `out` sees all of them", () => {
    const query = buildQuery(oslo);
    const body = query.slice(query.indexOf("("), query.lastIndexOf(")") + 1);
    const statements = query.match(/nwr\[/g) ?? [];
    expect(statements.length).toBeGreaterThan(1);
    expect(body.match(/nwr\[/g)?.length).toBe(statements.length);
    expect(query.indexOf("out tags center")).toBeGreaterThan(query.lastIndexOf(")"));
  });

  it("orders the bounding box as south,west,north,east", () => {
    expect(buildQuery(oslo)).toContain("(59.8093,10.4891,60.1351,10.9513)");
  });

  it("asks for tags and centres so ways and relations are usable", () => {
    expect(buildQuery(oslo)).toContain("out tags center;");
  });

  it("covers the tag families our venues actually use", () => {
    const query = buildQuery(oslo);
    for (const tag of ["pub", "bar", "community_centre", "hotel", "sports_centre"]) {
      expect(query).toContain(tag);
    }
    // Student societies carry `club` and no amenity at all.
    expect(query).toContain('nwr["club"]');
  });
});
