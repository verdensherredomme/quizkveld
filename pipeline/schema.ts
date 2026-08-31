import { z } from "zod";

/**
 * Shared data model for quizkveld.
 *
 * These schemas are the contract between the data pipeline and the (future) Astro site,
 * which will reuse them through the Content Layer. Keep them dependency-free.
 */

export const GEO_SOURCES = ["address", "osm", "kartverket", "centroid", "manual"] as const;
export const GeoSourceSchema = z.enum(GEO_SOURCES);
export type GeoSource = z.infer<typeof GeoSourceSchema>;

export const GEO_CONFIDENCES = ["high", "medium", "low"] as const;
export const GeoConfidenceSchema = z.enum(GEO_CONFIDENCES);
export type GeoConfidence = z.infer<typeof GeoConfidenceSchema>;

export const RECURRENCE_KINDS = [
  "weekly",
  "biweekly",
  "monthly-nth",
  "last-of-month",
  "irregular",
] as const;
export const RecurrenceKindSchema = z.enum(RECURRENCE_KINDS);
export type RecurrenceKind = z.infer<typeof RecurrenceKindSchema>;

export const CATEGORY_NORMS = ["allmenn", "musikk", "sport", "film", "annet"] as const;
export const CategoryNormSchema = z.enum(CATEGORY_NORMS);
export type CategoryNorm = z.infer<typeof CategoryNormSchema>;

export const WEEKDAYS = [
  "mandag",
  "tirsdag",
  "onsdag",
  "torsdag",
  "fredag",
  "lordag",
  "sondag",
] as const;
export const WeekdaySchema = z.enum(WEEKDAYS);
export type Weekday = z.infer<typeof WeekdaySchema>;

export const RecurrenceSchema = z.object({
  kind: RecurrenceKindSchema,
  /** RFC 5545 RRULE string. Absent for `irregular`. */
  rrule: z.string().optional(),
  /** The original Norwegian text from the source, always preserved verbatim. */
  raw: z.string(),
  /**
   * Which ISO week a `biweekly` quiz falls in, when the source says so ("oddetallsuker",
   * "partallsuker", "ulik uke"). An RRULE with INTERVAL=2 and no DTSTART only says "every
   * other week" without saying which one, so this is what makes half of them exact.
   *
   * Week parity is deliberately preferred over a DTSTART anchor: it is absolute and never
   * expires, whereas an anchor date is a fact about one season that silently rots.
   */
  weekParity: z.enum(["odd", "even"]).optional(),
});
export type Recurrence = z.infer<typeof RecurrenceSchema>;

export const VenueSchema = z.object({
  id: z.string().min(1),
  /** Cleaned, display-ready venue name. */
  name: z.string().min(1),
  /** Untouched venue text as scraped, newlines and all. */
  rawName: z.string(),
  /** Street address pulled out of the venue name, when one was embedded there. */
  addressHint: z.string().optional(),
  /**
   * The city/place column from the source. Note: this is *not* strictly a kommune -
   * e.g. "Greaaker" is a place within Sarpsborg kommune. Real kommune resolution
   * arrives with the geocoding step.
   */
  kommune: z.string().min(1),
  fylke: z.string().min(1),
  /**
   * Official kommune number (4 digits) the place resolves to, when we could resolve it.
   * `kommune` above is kept verbatim because people search for "Greaaker", not
   * "Sarpsborg" - this field is what geocoding and navigation should key on.
   */
  kommuneNr: z.string().regex(/^\d{4}$/).optional(),
  /** Official kommune name matching `kommuneNr`. */
  kommuneName: z.string().min(1).optional(),
  /** Current (post-2024) fylke name. The scraped `fylke` uses pre-2020 names. */
  fylkeNow: z.string().min(1).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  geoSource: GeoSourceSchema.optional(),
  geoConfidence: GeoConfidenceSchema.optional(),
  url: z.string().optional(),
  /**
   * True when the source itself marks the link as dead (it runs a link checker and strikes
   * those through). Derived from the source on every scrape, so it heals when they fix it.
   */
  urlBroken: z.boolean().optional(),
  /** True when the venue was absent from the most recent scrape (soft delete). */
  stale: z.boolean().optional(),
});
export type Venue = z.infer<typeof VenueSchema>;

export const QuizSchema = z.object({
  id: z.string().min(1),
  venueId: z.string().min(1),
  weekday: WeekdaySchema.nullable(),
  /** Start time as HH:MM, or null when the source has "?" or nothing usable. */
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable(),
  recurrence: RecurrenceSchema,
  /** Original category text from the source. */
  category: z.string(),
  /**
   * Every genre the row names, deduplicated and ordered by CATEGORY_NORMS. A row can
   * legitimately be both, e.g. "Allmenn/film/musikk", so a single value would drop data
   * a genre filter needs.
   */
  categoryNorm: CategoryNormSchema.array().nonempty(),
  note: z.string().optional(),
  /** ISO date (YYYY-MM-DD) of the last scrape that still contained this quiz. */
  lastSeen: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** True when the quiz was absent from the most recent scrape (soft delete). */
  stale: z.boolean().optional(),
});
export type Quiz = z.infer<typeof QuizSchema>;

export const QuizDataSchema = z.object({
  generatedAt: z.string().datetime(),
  /** "Sist oppdatert" as advertised by the source page, ISO date. Null if not found. */
  sourceUpdatedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  venues: z.array(VenueSchema),
  quizzes: z.array(QuizSchema),
});
export type QuizData = z.infer<typeof QuizDataSchema>;

export const GeoCacheEntrySchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  geoSource: GeoSourceSchema,
  geoConfidence: GeoConfidenceSchema,
  resolvedAt: z.string().datetime(),
});
export type GeoCacheEntry = z.infer<typeof GeoCacheEntrySchema>;

/** Append-only, keyed by venue id. */
export const GeoCacheSchema = z.record(z.string(), GeoCacheEntrySchema);
export type GeoCacheData = z.infer<typeof GeoCacheSchema>;

/**
 * Hand corrections. Keyed by venue id / quiz id; every field present here wins over
 * whatever the scraper produced.
 */
export const OverridesSchema = z.object({
  venues: z.record(z.string(), VenueSchema.partial()).default({}),
  quizzes: z.record(z.string(), QuizSchema.partial()).default({}),
});
export type Overrides = z.infer<typeof OverridesSchema>;

/**
 * Official kommune register, fetched once from Kartverket and committed. We do not look
 * this up at runtime: it changes a few times a decade, and a build should not depend on
 * a third-party API being up.
 */
export const KommuneSchema = z.object({
  nr: z.string().regex(/^\d{4}$/),
  navn: z.string().min(1),
  fylkesnr: z.string().regex(/^\d{2}$/),
  fylke: z.string().min(1),
  /** Point guaranteed to be inside the kommune. Doubles as the last-resort geocode. */
  point: z.object({ lat: z.number(), lon: z.number() }),
  /** [minLon, minLat, maxLon, maxLat], EPSG:4258. Bounds Overpass queries. */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});
export type Kommune = z.infer<typeof KommuneSchema>;

export const KommuneRegisterSchema = z.object({
  fetchedAt: z.string().datetime(),
  source: z.string(),
  kommuner: z.array(KommuneSchema),
});
export type KommuneRegister = z.infer<typeof KommuneRegisterSchema>;

export const ALIAS_METHODS = ["exact", "normalized", "stedsnavn", "manual"] as const;
export const AliasMethodSchema = z.enum(ALIAS_METHODS);
export type AliasMethod = z.infer<typeof AliasMethodSchema>;

/**
 * One source place name resolved to an official kommune.
 *
 * `kommuneNr` is nullable on purpose: Longyearbyen is on Svalbard, which is not a
 * kommune and has no kommunenummer. Forcing it into the register would be a lie, so
 * such entries carry their own `point` instead.
 */
export const KommuneAliasEntrySchema = z.object({
  kommuneNr: z
    .string()
    .regex(/^\d{4}$/)
    .nullable(),
  kommuneName: z.string().nullable(),
  fylkeNow: z.string().nullable(),
  method: AliasMethodSchema,
  /** Fallback point for entries with no kommuneNr. */
  point: z.object({ lat: z.number(), lon: z.number() }).optional(),
  /** Evidence for the decision, so a human reviewing the table can check it. */
  note: z.string().optional(),
});
export type KommuneAliasEntry = z.infer<typeof KommuneAliasEntrySchema>;

export const KommuneAliasSchema = z.object({
  aliases: z.record(z.string(), KommuneAliasEntrySchema).default({}),
});
export type KommuneAliases = z.infer<typeof KommuneAliasSchema>;

/** A single scraped table row, before any normalization. */
export const RawRowSchema = z.object({  fylke: z.string(),
  city: z.string(),
  venueRaw: z.string(),
  venueUrl: z.string().optional(),
  /** The source marked this link as dead via its link checker. */
  venueUrlBroken: z.boolean().optional(),
  weekdayRaw: z.string(),
  timeRaw: z.string(),
  categoryRaw: z.string(),
});
export type RawRow = z.infer<typeof RawRowSchema>;

export const ParseResultSchema = z.object({
  sourceUpdatedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  rows: z.array(RawRowSchema),
  /** Non-fatal oddities encountered while parsing, for the run report. */
  warnings: z.array(z.string()),
});
export type ParseResult = z.infer<typeof ParseResultSchema>;
