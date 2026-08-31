# quizkveld

Finn din neste pubquiz - oversikt over quizkvelder i hele Norge.

Data hentet fra [Norges Quizforbund](https://www.norgesquizforbund.no/arrangementer/finn-din-pubquiz/).

> **Status:** fase 2b - datapipeline, nettsted og geokoding. Kart og «nær meg» står igjen.

## Kom i gang

Krever Node >= 22.12 (Astro 7-kravet) og pnpm.

```bash
pnpm install
pnpm test        # pipeline + nettsted
pnpm dev         # nettstedet på http://localhost:4321/quizkveld/
pnpm build       # statisk bygg til dist/ + lenkesjekk
pnpm preview     # serverer dist/ med riktig base-sti
pnpm pipeline all
```

`pnpm typecheck` kjører begge halvdelene: `tsc` mot `tsconfig.pipeline.json` for
pipelinen, og `astro check` for `src/`.

## Nettstedet

Astro-prosjektet ligger i `src/` og er helt adskilt fra `pipeline/`. Den eneste koblingen
går én vei: `src/` importerer `pipeline/schema.ts`, `pipeline/slug.ts` og
`pipeline/paths.ts`. Ingenting i pipelinen vet at nettstedet finnes.

| Fil | Rolle |
| --- | --- |
| `src/content.config.ts` | Content Layer: leser `data/quizzes.json` og validerer med `QuizDataSchema` |
| `src/lib/date.ts` | Sivil dato og ukedag i **Europe/Oslo** |
| `src/lib/occurrence.ts` | Om en quiz treffer en gitt dato, og hvor sikkert |
| `src/lib/place.ts` | Slugger for sted og fylke, med deterministisk kollisjonsløsning |
| `src/lib/model.ts` | Kobler quiz til sted, sorterer, grupperer, teller, skiller ut stale rader |
| `src/lib/format.ts` | All norsk visningstekst ett sted |
| `src/lib/attribution.ts` | Utleder hvilke datakilder som må krediteres, fra `geoSource` |
| `src/scripts/filters.ts` | Klientfilter som skjuler kort som allerede er sendt ut |

Sider: `/` (i kveld), `/i-morgen/`, `/denne-uka/`, `/steder/`, `/sted/<sted>/`,
`/fylke/<fylke>/`, `/pub/<sted-id>/`, `/om/`. ~447 statiske sider totalt.

### Fylkene er dagens, ikke kildens

Kildens `fylke` er fra før 2020 og sier fortsatt Hordaland, Sør-Trøndelag, Hedmark,
Vest-Agder, Aust-Agder, Oppland, Nord-Trøndelag og Sogn og Fjordane. Alle åtte ble lagt ned
i 2020, og de dekker **78 av 322 steder**. Navigerer man på dem, må den som leter etter quiz
i Bergen vite at hun skal trykke «Hordaland» — og «Vestland» finnes ikke i det hele tatt.

`fylkeOf()` i `place.ts` bruker `fylkeNow`, som pipelinen slår opp mot Kartverket **per
sted**. At det ikke er en navnetabell er hele grunnen til at det er trygt: Jevnaker gikk
Oppland → Viken → Akershus, og enhver håndskrevet aliastabell ville sendt den til Innlandet
sammen med resten av Oppland.

Ett sted (Sandnesseter) mangler `fylkeNow` fordi Kartverket ikke kjenner stedet, og faller
tilbake på kildens fylke framfor å forsvinne ut av navigasjonen. En test teller at antall
steder i navigasjonen er like høyt som antall steder totalt, slik at et stille bortfall
fanges av seg selv neste gang Kartverket ikke kjenner et sted. Svalbard trenger ingen
spesialhåndtering — det beholdt navnet sitt, så gammelt og nytt er samme streng.

**Vi overskriver ikke kildens ord.** Fylkessida sier hvilke av kildens fylker den dekker
(«Tidligere Hordaland og Sogn og Fjordane»), og pubsida sier det for stedet den gjelder. Det
hjelper den som kjenner det gamle navnet, og det er ærlig om at inndelingen er vår avledning
og ikke noe kilden har sagt. `formerFylker()` utleder linja fra dataene, så den forsvinner av
seg selv den dagen kilden skriver moderne navn.

**Men to ulike ting ser like ut her, og må ikke formuleres likt.** Vestland *var* Hordaland
og Sogn og Fjordane: kilden skriver aldri «Vestland», så alle stedene der bærer et gammelt
navn. Akershus ble derimot aldri omdøpt — det finnes fortsatt under sitt eget navn, og 26 av
28 steder er ført under Akershus hos kilden. Det som skjedde er at én kommune, Jevnaker,
flyttet inn da Oppland ble delt. «Tidligere Oppland» på den sida ville vært en påstand som
er usann om nesten hele fylket. Sida skriver «Jevnaker lå tidligere i Oppland» i stedet.

De to skilles på om kilden bruker fylkets eget navn i det hele tatt. Å droppe linja fra
Akershus ville strandet nettopp den leseren som kjenner det gamle navnet: Opplands seks
andre steder ligger i Innlandet, så ingen side ville nevnt Jevnaker.

Det er bevisst ingen omdirigeringssider fra de gamle URL-ene. Avgjørende var Oppland, det
eneste fylket som ble delt: en omdirigering må velge én destinasjon og blir dermed stille gal
for de andre, mens en setning kan si sant om en splitt. Oppland står navngitt på både
Innlandet og Akershus.

Kildens egen skrivemåte står også i rettings-e-posten: den skal hjelpe en frivillig å finne
raden i *deres* tabell, og deres tabell sier Hordaland.

### Vi er et speil, aldri en kilde

quizkveld eier ingen opplysninger om quizer. Vi er en visning av Norges Quizforbunds
liste. Alt vi legger til skal være **avledet**: slugger, kategorier, RRULE-er, og senere
koordinater. Avledede data kan regnes ut på nytt fra kilden og reparerer seg selv når
kilden endrer seg. Håndplukkede påstander («denne er egentlig første mandag, jeg sjekket»)
holder vi ikke — de råtner stille, og ingen forteller oss det.

Praktiske konsekvenser i UI-et:

- `certain` / `likely` / `undated` og «sjekk selv»-merket er **policy**, ikke pynt. Det er
  mekanismen som gjør at vi aldri påstår mer enn kilden faktisk vet. Samme for
  «Uregelmessige quizer», som gjengir `recurrence.raw` ordrett.
- Attribusjon, kildens `sourceUpdatedAt` (ikke vår `generatedAt`) og «sjekk med
  arrangøren» står i bunnteksten på **hver** side, ikke bare på `/om/`.
- Rettelser går oppstrøms via `mailto:` til `admin@norgesquizforbund.no` — generelt i
  bunnteksten, og med stedet forhåndsutfylt på hver pub-side (`reportUrl()` i
  `src/lib/source.ts`).
- **Vi samler ikke inn brukerkorreksjoner selv.** Ingen skjemaer, forslagsbokser eller
  kommentarer. Det ser ut som det fordeler arbeidet, men gir i praksis moderering, spam og
  motstridende rapporter vi må ta stilling til uten å ha grunnlag for det.
- `venue.url` presenteres nøytralt som «Nettside», aldri «offisiell side». Kilden merker
  døde lenker `broken_link` og vi lagrer dem uansett, så en del av de 229 virker ikke.

### Datakreditering

Bunnteksten har plass til flere datakilder enn Norges Quizforbund, fordi geokodingen i
fase 2b henter koordinater fra kilder med lisensvilkår som *krever* kreditering i det
publiserte produktet: OpenStreetMap er ODbL, Kartverket/Geonorge er NLOD.

Krediteringen er **avledet, ikke hardkodet**. `dataCredits()` i `src/lib/attribution.ts`
ser på hvilke `geoSource`-verdier som faktisk står på et sted *som har koordinater*, og
viser bare de kildene. Bruker vi ingen OSM-koordinater, krediterer vi ikke OSM — å påstå
at vi bruker en kilde vi ikke bruker er samme slags overdrivelse som å påstå at en quiz
går en kveld kilden aldri lovet. Etter geokodingen i fase 2b har 245 av 322 steder
koordinat, så både OpenStreetMap og Kartverket krediteres.

`address` og `centroid` regnes som Kartverket-produkter (Adresse-API-et og kommunegeometri
fra Geonorge) og utløser samme NLOD-kreditering — bekreftet mot planen fase 2b jobber etter,
ikke gjettet. `manual` skylder ingen noe.

`osm` utløser **begge** krediteringene, som er den ene oppføringen som ikke er åpenbar. Fase
2b avgrenser Overpass-spørringene med vår egen kommunegeometri fra Geonorge, ikke med OSM
sitt admin-hierarki, så en koordinat merket `osm` er likevel utledet med NLOD-data. Å
kreditere bare OpenStreetMap ville underdrevet hva vi faktisk brukte — og det er
underkreditering som bryter en lisens, mens det å nevne en kilde vi lente oss på indirekte i
verste fall er upresist.

Dukker det opp en `geoSource` som ikke står i tabellen, logger vi en advarsel framfor å
feile — den daglige deployen skal ikke stoppe — men advarselen sier eksplisitt at det kan
være et lisensbrudd. **Den nøyaktige ordlyden hver lisens krever eies av fase 2b og står i
`DATA.md`.** Oppdater konstantene i `attribution.ts` derfra, ikke fra hukommelsen.

### Tidssone

«I kveld» regnes alltid i Europe/Oslo med `Intl`, aldri med `new Date().getDay()`. CI
bygger i UTC, så en naiv dato ville vist feil kveld etter kl. 22 norsk tid om sommeren.
Datoene er `YYYY-MM-DD`-strenger og all aritmetikk går via UTC-midnatt, som ikke har
sommertid å snuble i.

### Hvor sikkert vises en quiz

| `recurrence.kind` | Visning |
| --- | --- |
| `weekly`, `monthly-nth`, `last-of-month` | Datofestet |
| `biweekly` | Datofestet, men merket «annenhver uke - sjekk selv». RRULE-en har ingen DTSTART, så vi vet ukedagen, ikke hvilken uke i syklusen |
| `irregular` | Aldri datofestet. Egen seksjon nederst med `recurrence.raw` ordrett |

I tillegg degraderes en quiz fra sikker til «sjekk selv» hvis kildeteksten tar et forbehold
RRULE-en ikke kan uttrykke. En regel kan si «siste fredag hver måned», men ikke «unntatt
desember». Syv rader er slik i dag - `Fredag (unntatt sommer)`, `Torsdag (sent i måneden)`,
`Torsdag (vanligvis)`, `Sporadiske søndager` og tre til - og kortet siterer kildens egen
formulering framfor å oppsummere den. `hasCaveat()` i `src/lib/occurrence.ts` matcher på
ord, ikke id-er, så nye forbehold fanges den dagen kilden skriver dem. Lista er bevisst
kort: et merke som dukker opp overalt er et merke ingen leser, og det finnes en test som
feiler hvis den treffer mer enn en tiendedel av datasettet.

**Forbeholdet ligger ikke alltid i gjentakelseskolonnen.** Kilden er et regneark fylt ut av
frivillige, og frivillige skriver ting der det passer. Tre rader beskriver *når* quizen går
inne i sjangerfeltet, og én av dem motsier sin egen gjentakelse rett ut:

```
raw "Lørdag" (weekly)  +  category "Musikkquiz (én gang i måneden)"
```

Den ble vist som helt sikker hver eneste lørdag. Tre av fire lørdager er det feil. Fase 1
kunne ikke fanget det - den leser ukedagskolonnen for gjentakelse og sjangerkolonnen for
sjanger, og her lå planen i feil kolonne.

`hasCategoryCaveat()` er derfor en **egen, snevrere regel** enn `hasCaveat()`, ikke samme
regel gjenbrukt. Sjangerfeltet er fritekst med et helt annet ordforråd, og `\bikke\b` alene
ville umiddelbart slått ut på `Allmenn (ikke seriespill)`, som ikke sier noe om planen. Den
ser bare etter ord som motsier hvor *ofte* quizen går. To rader som ser ut som plan og ikke
er det, og som må fortsette å ikke treffe:

| Kategori | Hvorfor den er sikker |
| --- | --- |
| `Annenhver allmennquiz og musikkbingo` | Annenhver *sjanger*, ikke annenhver uke |
| `Friends (1. lørdag); Seinfeld (2. lørdag); …` | Temarotasjon på en quiz som faktisk går hver lørdag |

Begge ville blitt fanget av en regel som lette etter «annenhver» eller «1. lørdag», og begge
går nøyaktig så ofte som gjentakelsen sier. `caveatOf()` returnerer hvilket felt kilden tok
forbeholdet i, så kortet kan si «Kilden skriver i sjangerfeltet: …» - ellers ser sitatet ut
som en sjanger.

#### Rekkverket som ikke er en ordliste

Begge feilene som har sluppet gjennom her har vært *et nytt ord for «uregelmessig»*, ikke en
ny type feil - først `unntatt sommer`, så `sporadisk`. En svarteliste mangler per definisjon
det neste ordet, og begge ble bare funnet fordi noen tilfeldigvis leste rader.

Så snus spørsmålet. En `weekly`-quiz påstår `certain` på grunnlag av ingenting annet enn
ukedagen, og **248 av de 332 datofestede radene har en `raw` som er nøyaktig et ukedagsnavn**
- bevis på at det ikke er noe der som kan overraske oss. Bare resten kan skjule noe, og for
`weekly` er det seks rader.

Testen `leaves no weekly row unexplained` feiler hvis en `weekly`-rad har tekst utover
ukedagen som ingen regel fanger. Den har ikke noe ordforråd, så den virker fortsatt den dagen
kilden finner på et ord vi aldri har sett. Rader som er lest og bevisst godkjent står i
`REVIEWED` med begrunnelse, og en egen test fjerner et unntak som har overlevd raden det ble
skrevet for.

To av unntakene er **parserfeil i pipelinen, ikke her**:

| `raw` | Hva som er galt |
| --- | --- |
| `Tirsdag (Oddetalsuker)` | Parseren ser etter `oddetallsuker`, kilden skrev én `l` |
| `Fredag (annen hver)` | Parseren ser etter `annenhver`, kilden skrev det med mellomrom |

Begge er annenhver-quizer lagret som `FREQ=WEEKLY`, så de vises hver uke. De er **med vilje
ikke lagt inn i `CAVEAT`**: det ville vært en omvei rundt en parserfeil, og ville latt feil
data ligge mens det så fikset ut. De eies oppstrøms, og når parseren kjenner dem igjen blir
de `biweekly` og treffer «annenhver uke»-stien som allerede finnes - hvorpå unntaket i
`REVIEWED` feiler og må ryddes bort.

De 20 uregelmessige quizene (5 uten ukedag) forsvinner aldri stille - det finnes en test
som holder på det. `time: null` (16 quizer) vises som «tidspunkt ikke oppgitt» og sorteres
sist innenfor dagen, aldri som 00:00.

`categoryNorm` er en array, så kategorifilteret matcher **inneholder**, ikke likhet.
Sjangertellingene summerer derfor til mer enn antall quizer, og UI-et sier det rett ut.

### Når kilden fjerner noe

Pipelinen sletter ikke rader, den merker dem `stale: true` og beholder gammel `lastSeen`.
Nettstedet holder dem ute av alle datofestede visninger - «i kveld» som peker på en pub
som har lagt ned er det verste denne sida kan gjøre - men `/pub/<id>/` og `/sted/<sted>/`
genereres fortsatt, og radene vises der i et eget merket avsnitt. Ellers ville lenker folk
allerede har delt blitt 404 den dagen kilden rydder.

Ingen rader er stale i dag, så oppførselen er testet med syntetiske rader framfor ekte.

### En dårlig rad skal ikke ta ned hele sida

Bygget kjører daglig på data ingen her kontrollerer, så en feil i én rad må ikke stoppe
publiseringen. `QuizDataSchema` har ingen kryssjekk av `venueId`, så en quiz kan i prinsippet
peke på et sted som ikke finnes; den raden droppes med en tydelig `console.warn` framfor å
kaste. Det samme gjelder sluggkollisjoner, som løses deterministisk framfor å feile.

Manglende `generatedAt`/`sourceUpdatedAt` kaster fortsatt. Det er ikke en rad som er feil,
det er fila som ikke er det vi tror.

### Filtrering uten rammeverk

Serveren rendrer hvert kort; `src/scripts/filters.ts` skrur bare `hidden` av og på og
speiler valget i query-strengen (`?sted=Asker&ukedag=fredag&kategori=musikk`). Uten
JavaScript får man hele lista, som fortsatt er brukbar.

Grensen er satt med vilje: **filterskriptet skal aldri bli en tilstandsmaskin.** Kartet i
fase 2b (MapLibre, ~200 KB) blir en isolert øy på egen side som laster sitt eget JS.
`filters.ts` skal ikke lære om kart, og kartet skal ikke lære om filtre. Blir skriptet
større enn ~150 linjer, eller begynner filterlogikk å bli duplisert mellom server og
klient, er det signalet om å stoppe og tenke framfor å presse videre.

## Hosting

Nettstedet ligger på GitHub Pages: <https://verdensherredomme.github.io/quizkveld>.

`astro.config.mjs` har `site` og `base` som to navngitte konstanter. Bytte til eget domene
er én endring hver pluss en CNAME-fil:

```js
const SITE = "https://quizkveld.no";
const BASE = "/";
```

...og `public/CNAME` med innholdet `quizkveld.no`.

Alle interne lenker går gjennom `href()` i `src/lib/url.ts`, som prefikser
`import.meta.env.BASE_URL`. `scripts/check-base.mjs` kjører etter hvert bygg og feiler
hvis en lenke i `dist/` har glemt base-stien - det er den klassiske prosjekt-Pages-fella.

`compressHTML: true` er satt med vilje: Astro 7 bruker JSX-regler for mellomrom som
standard, og de spiser mellomrommet mellom et ord og en lenke på neste linje.

### Deploy

`.github/workflows/deploy.yml` bygger og deployer. Den trigges av push til `main`,
manuelt, **og** av at «Oppdater quizdata» blir ferdig. Det siste er ikke pynt: pushes
gjort med `GITHUB_TOKEN` trigger ikke nye `push`-workflows, så uten `workflow_run` ville
ferske data aldri blitt publisert. Workflowen deklarerer `permissions:` eksplisitt, siden
organisasjonen står på read-only som standard.

### CI på pull requests

`.github/workflows/ci.yml` kjører `pnpm test`, `pnpm typecheck` og `pnpm build` på hver
pull request. Det overlapper med deploy-jobben med vilje: den kjører de samme sjekkene,
men først på `main`, altså etter at endringen allerede er inne.

Poenget er ikke redundansen, det er uavhengigheten. Uten denne jobben er «PR-en er grønn»
utelukkende en påstand fra den som skrev koden. En sjekk som kjører uansett hvem som
rapporterer, er det eneste som skiller *grønt* fra *noen sa grønt*.

Jobben **rører verken kilden eller nettet**. Den bygger fra `data/quizzes.json` slik den
ligger i repoet. En PR-sjekk er ingen grunn til å sende trafikk mot Norges Quizforbund.
Bygget kjøres likevel, fordi flere av feilene i dette prosjektet har vært usynlige i kilden
og bare synlige i utdataene - `compressHTML`-fella og manglende base-sti er begge av den
typen.

## Pipeline

Pipelinen ligger i `pipeline/` og er helt adskilt fra sidebygget. Hvert steg
kan kjøres for seg:

| Kommando | Hva den gjør |
| --- | --- |
| `pnpm pipeline scrape` | Henter kildesiden med undici og skriver den til `raw/latest.html` |
| `pnpm pipeline parse` | Leser `raw/latest.html` med cheerio og oppsummerer radene |
| `pnpm pipeline normalize` | Normaliserer radene og viser fordelinger |
| `pnpm pipeline kommuner` | Bygger `data/kommune-alias.json` fra kildens stedsnavn |
| `pnpm pipeline geocode` | Kjører geokodingsstigen mot Kartverket og Overpass |
| `pnpm pipeline build` | Bygger `data/quizzes.json` med overstyringer og sikkerhetssjekker |
| `pnpm pipeline all` | `scrape` → `build` → `geocode` |

Flagg: `--force`, `--min-rows=N`, `--max-id-churn=0.1`, `--skip-scrape`,
`--only-new` (geokod bare steder som mangler i cachen), `--limit=N`,
`--refresh-register` (hent kommuneregisteret fra Kartverket på nytt).

### Filer

| Fil | Rolle |
| --- | --- |
| `raw/latest.html` | Rå kildeside. Committes med vilje - git-diffen er slik vi oppdager endringer hos kilden |
| `data/quizzes.json` | Generert utdata: `{ generatedAt, sourceUpdatedAt, venues, quizzes }` |
| `data/overrides.json` | Håndkorrigeringer nøklet på id. Vinner alltid over det som er skrapet |
| `data/geocache.json` | Append-only geocache nøklet på sted-id |
| `data/kommuner.json` | Offisielt kommuneregister fra Kartverket. Committet, ikke hentet ved hver kjøring |
| `data/kommune-alias.json` | Kildens stedsnavn → offisielt kommunenummer |
| `pipeline/schema.ts` | Zod-skjemaene. Gjenbrukes av nettstedet via Content Layer |
| `raw/osm/` | Lokal cache av Overpass-svar. Ikke committet - `data/geocache.json` er fasiten |

### Stabile id-er

Alt henger på at id-ene overlever ny skraping, siden både `overrides.json` og
`geocache.json` er nøklet på dem.

- Sted: `slug(kommune + navn)`
- Quiz: `slug(kommune + navn + ukedag + klokkeslett)`

Slugen transliterer æ/ø/å deterministisk (`boelgen-kro`, `tromsoe`). Id-en bruker den
**normaliserte** ukedagen, ikke den rå teksten - ellers ville
`Onsdager (annenhver – høstsesong 2024 fra 28/8 til 4/12)` endret id-en hver gang kilden
retter på en sesong. Kolliderer to quizer likevel, skilles de på gjentakelsestype
(`...-last-of-month`) framfor et posisjonsnummer, slik at rekkefølgen i kildetabellen ikke
har noe å si.

### Kategori

`categoryNorm` er en **array**, ikke én verdi. 23 av 352 rader navngir mer enn én sjanger
(`Allmenn/film/musikk`, `Musikk og film`, `Live musikk/Allmenn quiz`), og å kollapse dem
til én skjulte 23 ekte musikkquizer for et musikkfilter. Rekkefølgen er fast
(allmenn → musikk → sport → film → annet), ikke rekkefølgen sjangrene står i teksten, så
outputen er deterministisk. Originalteksten ligger alltid i `category`.

Gjenkjenningen kjører mot hele strengen, ikke mot separator-delte biter. Skilletegnene er
ikke til å stole på: `Allmenn – med påfølgende musikkquiz` og `Allmenn med musikk` navngir
to sjangre uten noe skilletegn i det hele tatt.

`seriespill` er en seriespill-form for allmennquiz og skal **ikke** trigge `film` - det er
en felle det finnes egen test for.

### Gjentakelse

Den norske fritekst-ukedagen tolkes til `{ kind, rrule?, raw }` der `kind` er
`weekly`, `biweekly`, `monthly-nth`, `last-of-month` eller `irregular`. RRULE-strengene
bygges med `rrule`-biblioteket, og originalteksten ligger alltid i `raw`.

Regelen er at vi **aldri gjetter**. Tvetydige formuleringer blir `irregular`:

- `Hver fjerde søndag` kan bety hver fjerde uke *eller* den fjerde søndagen i måneden.
  Det er to forskjellige datoer, så vi velger ingen av dem.
- `Torsdag (eller fredag)` og `Mandag (og fredag)` har ingen entydig ukedag.
- `Fredag (månedlig)` er månedlig, men sier ikke hvilken fredag.

En feil RRULE er verre enn ingen: den sender folk på pub på feil kveld.

**Hva vi gjør med de irregulære: rapporterer dem oppstrøms.** 12 av de 20 har ukedag, men
sier ikke hvilken uke i måneden (`Fredag (månedlig)`, `Mandag (én gang per måned)`, …).
Vi *kunne* funnet svaret og lagt det i `overrides.json` - men da eier vi et faktum ingen
andre har, og som råtner stille når puben legger om. Kilden ber selv om rettelser på
`admin@norgesquizforbund.no`. Retter de det, fanger neste skraping det opp av seg selv.
Et ferdig e-postutkast med alle oppføringene ligger i `_note.utboks` i
`data/overrides.json`.

**Annenhver uke: `weekParity`.** `INTERVAL=2` sier at quizen går annenhver uke, men ikke
*hvilken*, så alene kan den ikke svare på «går den i kveld?». 16 av de 48 annenhver-radene
sier det selv (`oddetallsuker`, `partallsuker`, `ulik uke`), og det havner i
`recurrence.weekParity` som `odd` eller `even`. De øvrige 32 står uten, og skal vises som
«annenhver uke - sjekk selv».

Merk at paritet er valgt framfor en `DTSTART`-ankerdato med vilje. Ukenummer er en
egenskap ved kalenderen og utløper aldri, mens en ankerdato er et faktum om én sesong -
den eneste datoen i kilden er `høstsesong 2024 fra 28/8 til 4/12`, som gikk ut for lenge
siden. Et utløpt anker gir feil uke annenhver gang, med full selvtillit.

Fella er at `ulike uker` (oddetall) og `like uker` (partall) skiller seg med én bokstav og
betyr det motsatte. Det finnes egen test for den.

### Døde lenker

Kilden kjører en lenkesjekker og streker over døde lenker med `class="broken_link"`. Det
er en vurdering de allerede har gjort, så den bæres videre som `urlBroken` på stedet.

Med ett unntak: **alle 103 Facebook-lenkene er markert døde**. En feilrate på 100 % er
sjekkeren som blir blokkert, ikke 103 nedlagte sider - Instagram-lenkene på samme side er
ikke markert, som er det som peker på Facebook spesifikt. Å sende flagget rått videre ville
strøket ut nettopp de lenkene som er best vedlikeholdt, siden en pub sin Facebook-side
gjerne er den kanalen de faktisk oppdaterer. Hoster i `CHECKER_BLIND_HOSTS` flagges derfor
aldri. Etter det står 49 av 229 lenker som døde.

### Sikkerhetssjekker

Byggingen stopper med exit-kode 2 hvis

- antall quizer faller under `--min-rows` (standard **250**), eller
- mer enn 10 % av id-ene har endret seg siden forrige `data/quizzes.json`.

Begge tyder normalt på at kilden har lagt om HTML-en. `--force` overstyrer dem for reelle
store endringer. Skjemavalidering kan **ikke** overstyres.

Grensen på 250 er satt ut fra at kilden faktisk har ~350 quizer. Den opprinnelige
antakelsen om 600-900 rader stemte ikke.

### Kommune- og fylkesnormalisering

Kilden har ingen kommuner. `city`-kolonna er «sted slik en frivillig skrev det» - Greåker
ligger i Sarpsborg - og fylkene er fra før 2020 (Sør-Trøndelag, Hedmark, Vest-Agder …).

`pnpm pipeline kommuner` løser dette mot Kartverkets åpne API-er:

1. Kommuneregisteret hentes én gang og **committes** som `data/kommuner.json`. Det slås
   ikke opp under bygging.
2. Hvert stedsnavn forsøkes matchet eksakt mot et kommunenavn, deretter normalisert
   (æøå, store/små bokstaver, mellomrom), og til slutt via Kartverkets stedsnavnsøk.
3. Resultatet lagres i `data/kommune-alias.json` med `method`-felt, så det er synlig
   hvordan hver rad ble løst.

Kildens stedsnavn **overskrives aldri** - det er det folk søker på. Stedene får i stedet
tre nye, valgfrie felt: `kommuneNr`, `kommuneName` (offisiell) og `fylkeNow` (dagens
fylke, etter oppsplittingen i 2024).

To feller det er verdt å kjenne til, begge funnet ved å gå gjennom resultatet manuelt:

- **Gårdsnavn.** Kartverket kjenner «Rygge» både som sokn i Moss og som gard i Indre
  Østfold. Norge er dekket av garder som deler navn med tettsteder, så gardsnavn rangeres
  bevisst *under* ukjente navnetyper i `placeTypeRank`.
- **Stripping av etterledd.** «Bø i Telemark» ble til «Bø» og traff Bø i Nordland, 900 km
  unna. Et enkelttreff godtas derfor uten fylkessjekk bare når det *ustrippede* navnet
  matcher eksakt.

### Geokoding

Kilden har verken adresser eller koordinater, og bare 3 av 322 steder har en adresse
gjemt i navnet. Geokodingen hviler derfor nesten helt på å matche *stedsnavn innenfor en
kommune*. Stigen i `pipeline/geocode.ts`:

| Trinn | Kilde | Når det treffer |
| --- | --- | --- |
| 1 | Kartverket Adresse | Stedet har `addressHint`. Svarer umiddelbart nei ellers, så det koster ingenting å ha først |
| 2 | Overpass / OpenStreetMap | Hovedkilden. Ett kall per kommune, ikke per sted |
| 3 | Kartverket Stedsnavn | Navnefallback for det OSM ikke kjenner |
| 4 | Kommunesentrum | Siste utvei, alltid `geoConfidence: 'low'`, og bare i kommuner med høyst 3 steder |

Sentroiden er ikke der puben er - den er der kommunen er. I en liten kommune er det et
grovt, men ærlig svar. I Oslo stabler den 30 puber på ett punkt flere kilometer fra dem
alle, og det er verre enn et tomt felt: en «nærmeste quiz»-liste ville sortert på den
nålen og rangert feil steder først med full selvtillit. Over grensen
(`MAX_VENUES_FOR_CENTROID`) blir stedet heller stående uten koordinat.

Hvert treff verifiseres mot Kartverkets punkt-i-kommune-API før det godtas. Et treff på
«Samfundet» i feil by er verre enn ingen treff, fordi det ser riktig ut i kartet.

Navnematchingen i `pipeline/venuematch.ts` er med vilje asymmetrisk. Ekstra ord på
*kildesida* er nesten alltid stedsangivelse fra en frivillig («Lincoln Pub, Torshov») og
kan trygt ignoreres. Ekstra ord på *OSM-sida* endrer derimot hvilken bedrift det er snakk
om, og godtas bare når de er generiske («Glasset» / «Glasset Vinbar») eller er stedsnavnet
selv («Skatten» / «Skatten Oslo»). Første ekte kjøring godtok «Bølgen Kro» som «Bølgen &
Moi» og «Hinna Bistro» som «Dolly Dimples Hinna» - begge deler ett ord og er ulike steder.
Begge ligger nå som regresjonstester.

Geokoding kjører **ikke** i den daglige jobben som standard. Overpass er en dugnadstjeneste
som går ned uten forvarsel, og gårsdagens koordinater er fortsatt gode. Jobben kjører
`--only-new` og er `continue-on-error`, så et Overpass-utfall verken velter oppdateringen
eller blokkerer en deploy.

Etter første fulle kjøring har 245 av 322 steder koordinat: 182 fra OSM, 60
kommunesentrum, 2 fra adresse og 1 fra stedsnavn. De 77 uten koordinat er stort sett
steder i store kommuner som OSM ikke kjenner; de står heller uten enn på en sentroide de
deler med 30 andre. Nettstedet kan derfor vise kart, men bør skille tydelig på
`geoConfidence` - `low` betyr «et sted i denne kommunen», ikke «her er puben».

### Automatisk oppdatering

`.github/workflows/update-data.yml` kjører daglig (04:00 UTC, altså 06:00 i Oslo om
sommeren) og kan startes manuelt. Små endringer committes rett til `main`; slår en
sikkerhetssjekk ut, bygges det på nytt med `--force` og resultatet havner i en pull
request for gjennomgang. Når den committer, trigger den deploy-workflowen via
`workflow_run`.

## Kjente svakheter i kildedata

- **`kommune` er egentlig «sted slik en frivillig skrev det».** Kilden har bare en
  by-kolonne, og «Greåker» er et sted i Sarpsborg kommune. Stedsnavnet beholdes som det er,
  men stedene har nå også `kommuneNr`/`kommuneName` fra Kartverket - se
  «Kommune- og fylkesnormalisering».
- **Fylkene er de gamle (før 2020):** Sør-Trøndelag, Hedmark, Oppland, Vest-Agder og
  Sogn og Fjordane står fortsatt oppført. `fylkeNow` gir dagens fylke.
- **Ingen stabile id-er hos kilden**, derfor konstruerer vi våre egne.
- **Noen rader beskriver to quizer** i samme `<tr>` via parallelle `<p>`-blokker i
  klokkeslett- og kategoricellen. De splittes til to quizer.
- Ukedags- og kategoricellene er av og til lenker til Facebook-arrangementer. Lenken
  forkastes; bare lenken i stedscellen brukes som `url`.
