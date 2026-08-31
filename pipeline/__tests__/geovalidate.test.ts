import { describe, expect, it } from "vitest";
import {
  MAINLAND_BBOX,
  SVALBARD_BBOX,
  checkInNorway,
  distanceKm,
  withinKommuneBbox,
} from "../geovalidate.js";
import type { Kommune } from "../schema.js";

/**
 * A wrong coordinate is worse than a missing one: it puts a pub confidently in the wrong
 * place, and nothing downstream can tell. These checks are the last line of defence.
 */

const BERGEN: Kommune = {
  nr: "4601",
  navn: "Bergen",
  fylkesnr: "46",
  fylke: "Vestland",
  point: { lat: 60.35609130261, lon: 5.379238501004 },
  bbox: [5.144578179049, 60.176091099905, 5.686791425409, 60.536093128491],
};

describe("checkInNorway", () => {
  it("accepts mainland coordinates", () => {
    expect(checkInNorway(59.9139, 10.7522)).toMatchObject({ ok: true, region: "mainland" });
    expect(checkInNorway(69.6492, 18.9553)).toMatchObject({ ok: true, region: "mainland" });
  });

  /**
   * Longyearbyen sits at ~78°N, far outside the mainland box. A single Norway-wide box
   * would either reject it or be so wide it stopped catching real errors, so Svalbard is
   * its own region.
   */
  it("accepts Longyearbyen as Svalbard, not as an error", () => {
    expect(checkInNorway(78.2232, 15.6267)).toMatchObject({ ok: true, region: "svalbard" });
  });

  it("rejects the null island", () => {
    const result = checkInNorway(0, 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/0,0/);
  });

  it("rejects coordinates well outside Norway", () => {
    expect(checkInNorway(51.5074, -0.1278).ok).toBe(false); // London
    expect(checkInNorway(52.52, 13.405).ok).toBe(false); // Berlin
    expect(checkInNorway(-33.8688, 151.2093).ok).toBe(false); // Sydney
  });

  it("rejects values that are not numbers", () => {
    expect(checkInNorway(Number.NaN, 10).ok).toBe(false);
    expect(checkInNorway(60, Number.POSITIVE_INFINITY).ok).toBe(false);
  });

  /**
   * Deliberate limitation, documented rather than hidden: Stockholm falls inside the
   * mainland box. The box is a coarse filter for obviously broken values; the
   * authoritative test is the point-in-kommune lookup in verifyInKommune().
   */
  it("is only a coarse filter - Stockholm passes the box", () => {
    expect(checkInNorway(59.3293, 18.0686).ok).toBe(true);
  });

  it("has boxes that do not overlap", () => {
    expect(MAINLAND_BBOX.maxLat).toBeLessThan(SVALBARD_BBOX.minLat);
  });
});

describe("withinKommuneBbox", () => {
  it("accepts a point inside the kommune", () => {
    expect(withinKommuneBbox(60.3913, 5.3221, BERGEN)).toBe(true);
  });

  it("rejects a point in a different part of the country", () => {
    expect(withinKommuneBbox(59.9139, 10.7522, BERGEN)).toBe(false);
  });

  it("allows a small margin, because venues sit on borders", () => {
    // Just outside the northern edge, inside the default margin.
    expect(withinKommuneBbox(60.55, 5.4, BERGEN)).toBe(true);
    expect(withinKommuneBbox(60.55, 5.4, BERGEN, 0)).toBe(false);
  });
});

describe("distanceKm", () => {
  it("measures Oslo to Bergen at roughly 300 km", () => {
    const km = distanceKm({ lat: 59.9139, lon: 10.7522 }, { lat: 60.3913, lon: 5.3221 });
    expect(km).toBeGreaterThan(290);
    expect(km).toBeLessThan(320);
  });

  it("is zero for the same point", () => {
    expect(distanceKm({ lat: 60, lon: 5 }, { lat: 60, lon: 5 })).toBe(0);
  });
});
