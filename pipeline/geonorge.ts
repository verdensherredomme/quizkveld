import { politeFetchJson } from "./http.js";
import type { Kommune } from "./schema.js";

/**
 * Kartverket / Geonorge APIs. All free, no key, documented at
 * https://ws.geonorge.no/. Coordinates are EPSG:4258 (≈ WGS84) throughout.
 */

const KOMMUNEINFO = "https://ws.geonorge.no/kommuneinfo/v1";
const STEDSNAVN = "https://ws.geonorge.no/stedsnavn/v1";

interface KommuneListItem {
  kommunenummer: string;
  kommunenavn: string;
  kommunenavnNorsk: string;
}

interface KommuneDetail {
  kommunenummer: string;
  kommunenavn: string;
  kommunenavnNorsk: string;
  fylkesnummer: string;
  fylkesnavn: string;
  punktIOmrade?: { coordinates: [number, number] };
  avgrensningsboks?: { coordinates: number[][][] };
}

export async function listKommuner(): Promise<KommuneListItem[]> {
  return await politeFetchJson<KommuneListItem[]>(`${KOMMUNEINFO}/kommuner`);
}

/** Bounding box as [minLon, minLat, maxLon, maxLat] from the API's polygon ring. */
function toBbox(ring: number[][] | undefined): [number, number, number, number] | null {
  if (!ring || ring.length === 0) return null;
  const lons = ring.map((p) => p[0]).filter((n): n is number => typeof n === "number");
  const lats = ring.map((p) => p[1]).filter((n): n is number => typeof n === "number");
  if (lons.length === 0 || lats.length === 0) return null;
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

export async function getKommune(nr: string): Promise<Kommune | null> {
  const detail = await politeFetchJson<KommuneDetail>(`${KOMMUNEINFO}/kommuner/${nr}`);
  const point = detail.punktIOmrade?.coordinates;
  const bbox = toBbox(detail.avgrensningsboks?.coordinates?.[0]);
  if (!point || !bbox) return null;

  return {
    nr: detail.kommunenummer,
    navn: detail.kommunenavnNorsk || detail.kommunenavn,
    fylkesnr: detail.fylkesnummer,
    fylke: detail.fylkesnavn,
    // The API returns [lon, lat]; we store named fields so the order cannot be confused.
    point: { lat: point[1], lon: point[0] },
    bbox,
  };
}

/** Reverse lookup: which kommune contains this point? Null when outside Norway. */
export async function kommuneAtPoint(
  lat: number,
  lon: number,
): Promise<{ kommunenummer: string; kommunenavn: string; fylkesnavn: string } | null> {
  const result = await politeFetchJson<{
    kommunenummer?: string;
    kommunenavn?: string;
    fylkesnavn?: string;
  }>(`${KOMMUNEINFO}/punkt?nord=${lat}&ost=${lon}&koordsys=4258`);

  if (!result.kommunenummer) return null;
  return {
    kommunenummer: result.kommunenummer,
    kommunenavn: result.kommunenavn ?? "",
    fylkesnavn: result.fylkesnavn ?? "",
  };
}

export interface StedsnavnHit {
  navn: string;
  /** Kartverket's classification, e.g. "Tettsted", "By", "Bydel", "Grend". */
  type: string;
  kommunenummer: string;
  kommunenavn: string;
  lat: number;
  lon: number;
}

interface StedsnavnResponse {
  navn?: Array<{
    skrivemåte?: string;
    navneobjekttype?: string;
    kommuner?: Array<{ kommunenavn?: string; kommunenummer?: string }>;
    representasjonspunkt?: { nord?: number; øst?: number };
  }>;
}

/**
 * Kartverket Stedsnavn. Used both to resolve place names to a kommune (Greaaker ->
 * Sarpsborg) and as a geocoding fallback for named places.
 */
export async function searchStedsnavn(
  name: string,
  options: { perPage?: number } = {},
): Promise<StedsnavnHit[]> {
  const params = new URLSearchParams({
    sok: name,
    treffPerSide: String(options.perPage ?? 25),
  });
  const result = await politeFetchJson<StedsnavnResponse>(
    `${STEDSNAVN}/navn?${params.toString()}`,
  );

  const hits: StedsnavnHit[] = [];
  for (const entry of result.navn ?? []) {
    const kommune = entry.kommuner?.[0];
    const point = entry.representasjonspunkt;
    if (!kommune?.kommunenummer || point?.nord === undefined || point.øst === undefined) {
      continue;
    }
    hits.push({
      navn: entry.skrivemåte ?? name,
      type: entry.navneobjekttype ?? "",
      kommunenummer: kommune.kommunenummer,
      kommunenavn: kommune.kommunenavn ?? "",
      lat: point.nord,
      lon: point.øst,
    });
  }
  return hits;
}

interface AdresseResponse {
  adresser?: Array<{
    representasjonspunkt?: { lat?: number; lon?: number };
    kommunenummer?: string;
    kommunenavn?: string;
    adressetekst?: string;
  }>;
}

/** Kartverket Adresse. Only useful for the handful of venues with a street address. */
export async function searchAdresse(
  query: string,
  kommunenummer?: string,
): Promise<Array<{ lat: number; lon: number; kommunenummer: string; adressetekst: string }>> {
  const params = new URLSearchParams({ sok: query, treffPerSide: "10" });
  if (kommunenummer) params.set("kommunenummer", kommunenummer);

  const result = await politeFetchJson<AdresseResponse>(
    `https://ws.geonorge.no/adresser/v1/sok?${params.toString()}`,
  );

  const hits = [];
  for (const entry of result.adresser ?? []) {
    const point = entry.representasjonspunkt;
    if (point?.lat === undefined || point.lon === undefined || !entry.kommunenummer) continue;
    hits.push({
      lat: point.lat,
      lon: point.lon,
      kommunenummer: entry.kommunenummer,
      adressetekst: entry.adressetekst ?? query,
    });
  }
  return hits;
}
