# Datakilder og lisenser

Denne fila eier den **eksakte ordlyden** hver lisens krever. Konstantene i
`src/lib/attribution.ts` skal oppdateres herfra, ikke fra hukommelsen.

Krediteringen i bunnteksten er avledet av hva dataene faktisk inneholder: en kilde
krediteres bare når minst ett sted har koordinat fra den. Se `dataCredits()`.

## Oversikt

| Kilde | Hva vi bruker den til | Lisens | Kreditering påkrevd |
| --- | --- | --- | --- |
| Norges Quizforbund | Selve quizoversikten | Ingen uttrykt lisens | Nei, men vi gjør det uansett |
| OpenStreetMap | Koordinater via Overpass (`geoSource: 'osm'`) | ODbL 1.0 | **Ja** |
| Kartverket / Geonorge | Adresse-, stedsnavn- og kommunedata (`address`, `kartverket`, `centroid`, og indirekte `osm`) | NLOD 2.0 | **Ja** |

## OpenStreetMap (ODbL 1.0)

OSMF sine krav: krediter «© OpenStreetMap contributors» og lenk til
<https://www.openstreetmap.org/copyright>. Oversettelse til norsk er tillatt, derfor
bruker vi **«© OpenStreetMap-bidragsytere»**.

Vi henter ut koordinater og lagrer dem i `data/geocache.json`, som publiseres sammen med
nettstedet. Det gjør cachen til en avledet database etter ODbL, og da må vi i tillegg
oppgi lisensen og si fra at dataene er bearbeidet.

- Lenke til lisensteksten: <https://opendatacommons.org/licenses/odbl/1-0/>
- Endringsmerknad: vi velger ut ett OSM-objekt per sted og lagrer bare navn og
  koordinat. Det står i bunnteksten som «Koordinatene er bearbeidet av oss.»

## Kartverket / Geonorge (NLOD 2.0)

NLOD 2.0 punkt 5 «Navngivelse» sier at når lisensgiver ikke har spesifisert noe annet,
skal man normalt oppgi:

> «Inneholder data under Norsk lisens for offentlige data (NLOD) tilgjengeliggjort av
> [navnet på lisensgiver]»

For oss er lisensgiver **Kartverket**. Lisensen krever i tillegg at vi lenker til både
lisensen og kilden når det er praktisk mulig, og at vi tydelig angir at dataene er endret.

- Kilde: <https://www.geonorge.no/>
- Lenke til lisensteksten: <https://data.norge.no/nlod/no/2.0>

NLOD krever ikke at krediteringen står på samme side som dataene - en «Om»-side holder -
men bunnteksten er enklere å ikke glemme, så den ligger der.

### Hvorfor `osm` utløser *begge* krediteringene

Overpass-spørringene avgrenses med vår egen kommunegeometri fra Geonorge, ikke med OSM sitt
administrative hierarki, og hvert treff verifiseres mot Kartverkets punkt-i-kommune-API. En
koordinat merket `osm` er derfor utledet ved hjelp av NLOD-data selv om selve punktet kommer
fra OpenStreetMap. Å kreditere bare OpenStreetMap ville underdrevet hva vi brukte, og det er
underkreditering som faktisk bryter en lisens.

### `manual` skylder ingen noe

En håndsatt koordinat er vår egen, og utløser ingen kreditering. Den står likevel
eksplisitt i `GEO_CREDITS`, slik at en manglende oppføring leses som en feil framfor som
«ingen kreditering nødvendig».

## Når du legger til en ny `geoSource`

1. Finn ut hvilken lisens kilden har, og hva den krever ordrett.
2. Skriv det inn her først.
3. Legg kilden inn i `GEO_CREDITS` i `src/lib/attribution.ts`.

`dataCredits()` logger en advarsel framfor å feile hvis en ukjent `geoSource` dukker opp -
den daglige deployen skal ikke stoppe - men advarselen sier eksplisitt at det kan være et
lisensbrudd. Ikke la den ligge.
