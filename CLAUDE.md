# Discord ScoutID Linked Role Bot

## Dokumentationen är en del av ändringen

**Ändrar du beteende, ändra dokumentationen i samma commit.** CLAUDE.md, README
och `docs/` beskriver *varför* koden ser ut som den gör, och en beskrivning som
slutat stämma är sämre än ingen alls: den läses som sann och leder fel.

Det här är inte hypotetiskt. Ett infra-repo bredvid det här bar en regel om
kanalnamn medan kanalerna hette tvärtom, och det här repots configavsnitt stod
rubricerat "aktuell prod-config" med fyra av fem stickprovade nycklar fel.

Tre vanor som håller det sant:

- **Duplicera aldrig ett värde som kan ändras.** Beskriv formen och peka på
  källan. Varje kopia är en andra sanning, och den förlorar — det var precis så
  configavsnittet gick sönder. Går en kopia inte att undvika (som
  `SCOUTNET_DIVISION_NAMES`, som ofta måste finnas både i botens config och där
  Discord-servern byggs), skriv ut på båda ställena att den andra finns.
- **Sök efter det du just gjorde falskt.** Har du bytt ett namn, en flagga, ett
  suffix eller en regel — `grep -rn "<det gamla>" --include=*.md .` innan du
  committar. Det tar sekunder och är det enda som fångar en mening tre filer bort.
- **Låt orsaken stå kvar, inte bara resultatet.** Raderna här är skrivna för att
  beskriva vilket fel de finns för att förhindra. Byter du ut en, byt ut den mot
  något som förklarar lika mycket.

## Build & Deploy

**Det här repot bygger en image och inget annat.**
[.github/workflows/publish.yml](.github/workflows/publish.yml) kör lint, format
och testerna och pushar sedan `ghcr.io/scouterna/discord-scoutid-linked-role:<sha7>`.
Det deployar ingenting: en instans pinnar en tagg i sitt eget infra-repo och
sköter sina egna secrets, sin config och sin drift. Ingen CI här har
klusterbehörighet, och repot är publikt och generiskt — instansspecifika värden,
värdnamn och driftkommandon hör hemma i instansens repo, inte här.

[k8s/](k8s/) är ett **exempel**: en komplett uppsättning manifest (Deployment,
PDB, Service, Ingress, ConfigMap med påhittade värden, tre CronJobs och ett
restore-jobb) som visar vad en instans behöver. `publish.yml` bygger den med
`kustomize` så att den inte ruttnar, men applyar den aldrig. Taggen i
kustomizationen är en avsiktlig platshållare, så en applicering utan pinnad tagg
faller på `ImagePullBackOff` i stället för att skeppa något oavsiktligt.

**Pinna git-SHA:n, aldrig `latest`.** Skälet bytte med plattformen men regeln
stod kvar: på Container Apps höll en rörlig tagg tyst den gamla containern
igång; på Kubernetes gör den rollouts och rollbacks tvetydiga, eftersom två
olika images delar ett namn — och en GitOps-motor ser inte en rörlig tagg röra
sig.

**Registrera slash-kommandon** (sällan; definitionerna ändras sällan):

```bash
docker run --rm --env-file .env ghcr.io/scouterna/discord-scoutid-linked-role:<sha> node src/register.js
```

### Backup and restore

**Table Storage has no soft delete and no point-in-time restore** — unlike blobs.
An export is the only backup that exists, so
[k8s/backup-cronjob.yaml](k8s/backup-cronjob.yaml) runs daily at 03:15 UTC and
writes a JSON snapshot to a blob container on **a different storage account**
(`BACKUP_CONNECTION_STRING`), ideally in a different resource group and with
blob versioning and soft delete. A backup sitting beside the data does not
survive the case worth planning for — deletion of the account or its resource
group — and a delete lock on the data account may not be available to the
people running the bot. Expire old blobs with a lifecycle rule scoped to the
backup container's prefix: if the backup account holds anything else (Terraform
state, say), an unscoped rule deletes that too.

The `state` partition is excluded: OAuth state is ephemeral with a 10-minute
expiry. Everything else is kept — the `link` rows are the irreplaceable part,
since losing them means every user must re-verify, while tokens merely force a
re-auth.

Three properties worth preserving if this is ever edited: it paginates
explicitly (the service caps a page at 1000 entities and the CLI does not follow
the marker, so a single call silently truncates once enough people link), it
refuses to upload a snapshot containing zero `link` rows, and it hands the
marker back in the form the CLI takes it.

That last one is not obvious and cost twelve days of backups. `az storage entity
query` returns `nextMarker` as an object, `{nextpartitionkey, nextrowkey}`, but
`--marker` wants `nextpartitionkey=… nextrowkey=…` as separate words. The job
printed the object and passed that string back, which the CLI rejects — so the
pagination, written for the day the table passed 1000 entities, failed on that
very day, and every run after it. Nothing noticed: a failed Job notifies nobody
unless the cluster routes its failures somewhere. Test a change against a table
of more than 1000 entities, not an empty one.

**Restoring** — [k8s/backup-restore-job.yaml](k8s/backup-restore-job.yaml),
applied by hand, never part of the kustomization. It defaults to a scratch table
and refuses to touch the live table unless `ALLOW_PRODUCTION_RESTORE=yes`, so
running it unedited cannot overwrite production. **Under GitOps with self-heal,
never commit it where the sync picks it up**: after you delete the finished Job
the engine would recreate it and run the restore again.

Verified end to end in August 2026: every entity exported, restored into a
scratch table, and compared against the live table — byte-identical. Repeat
that comparison after changing either job; a backup that has never been restored
is not a backup.

### Why rollouts are safe

Four settings work together, and removing any one reintroduces dropped
requests. This was measured, not assumed — before the preStop hook a rollout
dropped 5 of 559 requests; after, 0 of 254.

- `maxUnavailable: 0` keeps a Ready pod throughout, so Discord's 3-second
  interaction ACK is always met. It does **not** stop traffic reaching a
  terminating pod — that is what the next item is for.
- A **PodDisruptionBudget** ([k8s/pdb.yaml](k8s/pdb.yaml)), `minAvailable: 1`,
  because `maxUnavailable: 0` only constrains what the Deployment controller
  does to its own ReplicaSets. A node drain is a different mechanism — a
  managed node image upgrade, an autoscaler scale-down, a `kubectl drain` by a cluster
  admin — and it evicts pods without consulting the rollout strategy at all.
  The anti-affinity is `preferred`, so both replicas may share a node and go
  together. A shared cluster is upgraded by someone who is not watching this
  app.
- A **10s `preStop` sleep**, because pod deletion and endpoint removal are
  concurrent: traefik keeps routing here briefly after termination begins.
- A **SIGTERM handler** in [src/server.js](src/server.js) that drains open
  connections *and* waits for background work. Slash commands ACK immediately
  and do the real work ~1s later, so that work outlives the HTTP response;
  without the wait a deploy kills it after the user was told it was accepted.
  This requires `CMD ["node", …]` (exec form) so node is PID 1 and receives the
  signal at all — under `npm start` it never arrives.

### Health-probarna svarar olika med flit

`/healthz` är liveness och beror **inte** på något utanför processen. `/readyz`
är readiness och gör en billig läsning mot Table Storage. `/` är oförändrad,
landningssidan.

Skillnaden är hela poängen. Liveness startar om podden, så en Table
Storage-hicka på en delad readiness-probe hade startat om varje replika
samtidigt — en degraderad tjänst gjord till ingen tjänst. Readiness *ska*
däremot bero på storage: en pod som inte når tabellen svarar fel på varje
interaktion, och att plocka den ur Service:n är precis rätt.

Två följder att känna till innan de ändras:

- **Ett storage-avbrott blockerar också rollouts**, eftersom `maxUnavailable: 0`
  väntar på en Ready-pod. Det är rätt svar på "ska vi deploya in i det här?",
  men överraskande i stunden. En hemlighetsrotation går ändå igenom: den nya
  podden har den nya connection stringen och blir Ready.
- `failureThreshold: 3` × 10 s är vad som hindrar en enstaka trög läsning från
  att vräka ut en frisk pod. Appen cachar dessutom svaret i 5 sekunder och delar
  ett pågående anrop, så en *hängande* tabell inte staplar prober på varandra.

Efter en release: polla `/readyz` över den publika värden, alltså hela vägen
från ingressen till datan. Faller det där medan poddarna är Ready är det routen
eller certifikatet, inte appen.

### Härdning i podspecen

Imagen släpper redan ner till `node` (uid 1000). `securityContext` i
[k8s/deployment.yaml](k8s/deployment.yaml) och
[k8s/memberscan-cronjob.yaml](k8s/memberscan-cronjob.yaml) gör det *upprätthållet*
i stället för avsett: `runAsNonRoot` vägrar starta en image som ändrats till att
köra som root, och resten är vad ett `restricted` Pod Security Standard kräver.
Ett namespace som upprätthåller `baseline` eller `restricted` släpper därför
igenom den oförändrad, också den dag nivån skärps.

`readOnlyRootFilesystem: true` kräver en skrivbar `/tmp` (emptyDir). Backup- och
restore-jobben är med flit utanför: de kör `azure-cli`-imagen, som skriver fritt.

## Architecture

- Node.js 24 + Express 5 + Azure Table Storage (ESM modules). Node 20 gick ur
  underhåll i april 2026 medan det fortfarande kördes här; 24 är LTS till april
  2028. Bumpen avslöjade direkt en inkompatibilitet: från Node 22 tolkas
  positionsargument till `node --test` som glob-mönster, så `node --test
  test/unit/` slutade hitta något och föll på `Cannot find module`. Skripten i
  `package.json` expanderar därför `test/unit/*.test.mjs` i skalet i stället,
  vilket fungerar på båda
- Built to run on Kubernetes behind an ingress with a TLS certificate (example
  in `k8s/`), images in GHCR. Storage is Azure Table Storage even when the
  compute is elsewhere — it is durable, costs öre, and when the bot left Azure
  Container Apps, keeping it meant no data migration and a free rollback
- **No Terraform and no deployment live in this repository.** The storage
  account, the DNS record, the Discord server's roles and the manifests an
  instance actually runs belong to that instance's own infrastructure repo.
  Infrastructure for one deployment should not live inside a generic app
- Docker build pulls from registry.npmjs.org unless a gitignored `.npmrc` overrides it (installed in a separate build stage, so it never lands in the image). On a network that TLS-intercepts npmjs, `npm ci` half-installs while still exiting 0 — so a local `.npmrc` pointing at a reachable mirror is required there. The Dockerfile verifies every dependency landed and fails the build otherwise
- **`package-lock.json` must record `registry.npmjs.org` in every `resolved`,
  never the mirror.** npm rewrites the registry host at install time, so an
  npmjs-pinned lockfile works on both networks — but running `npm install`
  behind the mirror writes *its* host into every entry, and GitHub's runners
  cannot resolve it. The symptom is `ENOTFOUND` on a random transitive
  dependency, a minute into `npm ci`, which reads like a runner glitch. Rewrite
  the host back before committing, and note that the host in the tarball URLs is
  **not** the one configured in `.npmrc` — the mirror answers from a different
  name, so grepping for the configured registry finds nothing:

  ```bash
  grep -o '"resolved": "https://[^/"]*' package-lock.json | sort -u   # what is in there
  sed -i 's|https://<mirror-host>/npm/|https://registry.npmjs.org/|g' package-lock.json
  ```

  [tests.yml](.github/workflows/tests.yml) checks this before `npm ci`, and the
  check asserts the property rather than blacklisting a hostname — the mirror's
  name does not belong in a public repository
- Local dev uses the Azurite storage emulator (see `docker-compose.yml`). The
  Table Storage SDK refuses a plain-http endpoint unless
  `allowInsecureConnection` is passed, so `storage.js` sets it — but only when
  the connection string itself says http, which the real account never does.
  Without that, every local run died on "Cannot connect to
  http://azurite:10002/... while allowInsecureConnection is false"

## Key design decisions

- Fee-to-role mapping is fully configurable via env vars, not hardcoded
- **Platta kategorimarkörer (`SCOUTNET_CATEGORY_ROLES`) delas ut utöver
  divisionsrollen** — en ledare i avdelning 12 får både `Ledare-12` och
  `Avdelningsledare`. De finns för AutoMod, som bara kan *undanta* roller och
  max 20 av dem: "alla utom deltagare" hade krävt en roll per avdelning, men
  blir en handfull med markörerna. En kategori kan med flit sakna markör —
  frånvaron *är* då det som gör att ett AutoMod-filter träffar just den. Ändras
  utdelningen av en markör som AutoMod läser måste ordningen hållas: botens
  config först, `/refresh-scoutid alla:true`, sedan AutoMod-ändringen. Omvänd
  ordning blockerar de undantagna i mellantiden. Vänta *inte* in den nattliga
  synken för mellansteget — den kommer, men "i mellantiden" är då upp till ett
  dygn långt

  **Att döpa om en markör är inte en sådan ändring**, och ordningen är fri där.
  En roll som döps om in-place behåller sitt id — AutoMods undantagslista pekar
  på id och märker ingenting, och ingen medlem tappar rollen. Det enda
  mellanrummet är att den halva som ännu har det gamla namnet i configen inte
  hittar rollen och tyst hoppar över *nya* utdelningar; nästa synk efter att
  båda sidor landat lagar det

- **En hoistad markör läses av medlemmar.** En hoistad roll visas som egen
  rubrik ovanför Online i medlemslistan, så dess namn i configen är medlemsvänd
  text på samma sätt som `SCOUTNET_SCOUT_ROLE` — stava ut det, även när
  per-divisionsrollerna bredvid står kvar som `Ledare-{nr}` och bara syns i
  rollinställningarna. Hoisting visar en medlems *högsta* hoistade roll, och
  markören delas ut oavsett division, så också den som står på väntande-rollen
  hamnar under rubriken
- Each fee category can have its own ScoutNet question ID for division assignment
- Division numbers are zero-padded to minimum 2 digits
- **Smeknamnet kortas i namnet, aldrig i suffixet** (`fitNickname` i
  [src/guild.js](src/guild.js)). Discord tar 32 tecken, och med avdelningsnamnet i
  suffixet räcker de inte åt alla: mätt mot ett verkligt event behövde runt en
  av tio med avdelning kortas. Tidigare gjorde koden `(base + suffix).substring(0, 32)`,
  alltså högg den av *suffixet* — och ett avhugget suffix saknar sin
  avslutande parentes, som `stripNickSuffix` behöver för att hitta det igen.
  Följden var permanent: varje senare synk byggde samma sträng, jämförde den
  med sig själv och rapporterade ingen ändring, så den som bytte avdelning
  visade den gamla för alltid. Namnet viker i stället, i den ordning en
  människa viker sitt: efternamnet till en bokstav, sedan ledet före, och
  först när inget återstår huggs resten. Förnamnet förkortas aldrig, och
  **inte heller ett led på högst tre tecken** — `af`, `van der`, `Dos`, `Lé`
  och `Gao` sparar en eller två tecken på att krympas och kostar ett helt
  namnled; i ett av de nio fallen är `Gao` hela efternamnet.

  Två följder: **auditens kategori 6 måste känna till regeln** — den jämför
  smeknamn mot ScoutNet-namn och hade annars rapporterat varenda förkortad som
  namnskillnad — och länkningsvägens `setNickname` tar namn och suffix *isär*,
  så den inte återinför samma bugg genom att slå ihop dem själv.
- The bot cannot modify users above it in Discord's role hierarchy (403 is expected for admins)
- `register.js` only needs Discord API, but imports storage.js which connects to Table Storage — storage errors during registration are harmless
- Interaction responses use a 1-second delay before processing to avoid race conditions with Discord's deferred response handling
- **Verifieringsgränsen har två bevis, och vartdera räcker** (`syncUserRoles`).
  Saknas båda strippas alla bot-hanterade roller och `Overifierad` sätts.
  Storage-länken behålls så användaren kan re-verifiera utan att admin behöver
  fråga efter scoutid igen.

  1. **Scout-rollen** — en connection-gated roll som Discord delar ut via sitt
     eget Link-flöde och återkallar när användaren kopplar bort appen. Starkast,
     och inget boten kan förfalska.
  2. **Ett levande OAuth-grant** — svarar Discord för användarens token är appen
     fortfarande auktoriserad. Samma faktum sett från andra sidan.

  Det andra beviset finns för att det första **inte går att backfilla**: Discord
  delar ut en connection-roll bara när användaren klickar Link, så när
  `Scout`-rollen byggdes om 2026-08-20 tappade alla 18 den och ingen kunde få den
  tillbaka via något API. `OR` och inte `AND` — under migrationen har de flesta
  ett levande grant men ingen roll, och `AND` hade strippat varje en av dem.

  Rollen kontrolleras först eftersom den är gratis; nätverksproben körs bara för
  den som saknar rollen. **`verifyConnection` har tre svar, inte två**: `accepted`,
  `rejected` (401 även efter förnyelse, eller `invalid_grant` — användaren har
  återkallat), och `unknown` (Discord svarade inte, eller svarade 403). På
  `unknown` ändras ingenting, av samma skäl som ett ScoutNet-fel kastar. **En 403
  är inget nej**: återkallelse dödar tokenet och ger 401, medan 403 är ett levande
  token som nekas av annat skäl, och det kan en förnyelse inte ändra. Läst som nej
  strippade den en medlem nio minuter efter att hon länkat, 2026-10-01.
  Ett *saknat* token räknas som `rejected`, med flit den mindre generösa läsningen
  — annars finns ingen väg därifrån till verifierad och `/link-scoutid` blir en
  permanent förbigång av gränsen.
- **Ett ScoutNet-fel får aldrig se ut som ett tomt svar.**
  `getDesiredRoles` **kastar** när ScoutNet inte går att nå. Tidigare svalde den
  felet och svarade `[scout]` — samma svar som "inte anmäld i eventet", och det
  svaret *betyder* ta bort event-, kategori- och divisionsrollerna. Ett
  ScoutNet-avbrott under `/refresh-scoutid alla:true` avrustade alltså alla den
  hann nå, och rapporterade lyckat medan det skedde. Samma tankefel som en
  trunkerad medlemssnapshot läst som en frånvarande: ett *okänt* får inte tillåtas
  se ut som ett känt nej.

  `syncUserRoles` avbryter därför **före första skrivningen**, men *under*
  verifieringsgrinden — att strippa någon som tappat Scout-rollen kräver ingen
  ScoutNet och måste fortsätta fungera under ett avbrott. `syncAllUserRoles`
  hämtar listan en gång i förväg och faller på en gång i stället för en gång per
  användare.

  `allowIncomplete: true` finns för det enda anropsställe som bara *lägger till*
  roller — länkningsflödet, där alternativet är att fälla en verifiering som
  annars gick igenom. Föreslår du att den flaggan sätts någon annanstans är svaret
  nej.
- **Discords** OAuth-tokens (`discord-token`) och länkar (`link`) lagras durabelt i
  Azure Table Storage (ingen TTL). OAuth-state (`state`) har ett `expiresAt`-fält
  (lazy expiry, 10 min) eftersom Table Storage saknar native TTL. Discords
  refresh-tokens är giltiga i månader, och persistent lagring är vad som låter
  `updateMetadata` köras i bakgrunden — och sedan 2026-08-21 vad grindens andra
  bevis läser.
- **ScoutIDs tokens sparas inte** (partitionen `scoutid-token` är avvecklad, gamla
  rader är inerta). Ingenting kunde använda dem: access-tokenet går ut inom en
  timme och ingenting förnyar det, så varje anrop med ett sparat token föll — 16
  av 16 när det mättes. Förnyelse hade inte hjälpt, för det enda de kunde hämta
  var namn och e-post, och **namnet som betyder något kommer från ScoutNet**: det
  är vad smeknamnet byggs av och vad auditen jämför mot. `name`/`email` låg
  dessutom utanför Linked Role-schemat, så inget krav läste dem. Fältet Discord
  faktiskt *visar* på kopplingskortet är `platform_username`, och det sätts nu —
  till **ScoutNet-namnet**, eftersom det redan syns i servern via smeknamnet och
  därmed inte exponerar något nytt. Med flit *inte* scoutid-numret: det är
  admin-vänt idag, och ett kopplingskort kan ses bredare än kanalerna. Hämtningen
  är inslagen i en try/catch och pushen sker ändå — ett ScoutNet-avbrott får inte
  kosta någon deras `verified`-flagga, av exakt samma skäl som ScoutID-anropet
  togs bort. Priset är att en push under ett avbrott tömmer det visade namnet till
  nästa lyckade push, eftersom `PUT` ersätter hela objektet.
  Kvar av ScoutID är det enda som behövdes: `getUserData` vid länkningen, med ett
  token som är sekunder gammalt, för att få personens scoutid.
- ScoutNet-deltagarlistan cachas i processminnet (10 min), inte i Table Storage — hela listan överskrider gränsen på 64 KB per property. Cache-miss efter omstart kostar bara en extra ScoutNet-hämtning.
- **Varför inte Redis:** Azure Redis Basic-tier saknar persistens och tappar ALL data vid varje nod-omstart/underhåll. 2026-05-26 wipeades alla länkar+tokens av en sådan omstart. Table Storage (LRS) är durabelt och billigare för detta access-mönster (bara läs/skriv vid länkning + audit).

## ScoutNet API

- Participants endpoint: `https://scoutnet.se/api/project/get/participants?id={EVENT_ID}&key={API_KEY}`
- Response has `participants` object keyed by member_no
- Each participant has: `fee_id`, `cancelled`, `cancelled_date`, `questions`
  (object of questionId → answer)
- **Avbokning har två fält, och boolean:en är det bredare.** I ett verkligt
  events data hade fler poster `cancelled: true` än ett `cancelled_date` — och
  ingen hade datum utan flagga. Ett datum implicerar alltså flaggan, aldrig omvänt. Läs därför
  `scoutnet.isCancelled()` och aldrig fälten direkt; predikatet finns för att de
  sex läsställena inte ska kunna drifta isär igen. De i mellanrummet var
  obekräftade och obetalda anmälningar (`fee_id: null`, `confirmed: false`) som
  avbokats administrativt utan datum. Ingen av dem var länkad och ingen hade
  avgift, så inget blev av det — men en person med flaggan *och* en avgift hade
  behållit sin divisionsroll och sina kanaler, och varken synken eller auditens
  kategori 5 hade sett det
- Participant data is cached in process memory for 10 minutes (see `src/storage.js`)

## Discord Developer Portal

- **General Information** → Linked Roles Verification URL: `https://<host>/linked-role`
- **General Information** → Interactions Endpoint URL: `https://<host>/interactions`
- **OAuth2** → Redirect: `https://<host>/discord-oauth-callback`
- ScoutIDs klientregistrering: redirect `https://<host>/scoutid-oauth-callback`

`<host>` är instansens publika värd; `DISCORD_REDIRECT_URI`,
`DISCORD_VALIDATION_URL` och `SCOUTID_REDIRECT_URI` i configen måste matcha
exakt.

### `verified`, och varför ordningen mot Server Settings är tvingande

Schemat i [src/register.js](src/register.js) deklarerar **en** nyckel: `verified`
(boolean_eq). Den är vad kravet på `Scout`-rollen läser, och `updateMetadata`
måste pusha den. Att ett konstant `true` inte bär någon information är hela
poängen — **frånvaron** gör jobbet: Discord raderar metadatan när användaren
kopplar bort appen, och det är precis den återtagning `Scout` finns för att
representera.

Fram till 2026-08-20 pushade ingenting `verified`. Discord höll alltså inget
värde, kravet kunde aldrig uppfyllas, och kravet stod därför **avstängt** i
Server Settings → Roles → `Scout` → Links. Konsekvensen var tyst men allvarlig:
med kravet av utvärderar Discord ingenting, så `Scout` slutar vara en gräns och
blir en frusen ögonblicksbild av vilka som kvalificerade sig senast kravet var
på. Nya länkningar fick rollen aldrig — de fick åtkomst vid länkningen och
tappade den vid nästa `syncUserRoles`.

**Slå aldrig på kravet före koden.** Med kravet på och `verified` opushad
utvärderar Discord det som ouppfyllt för varje användare vars metadata pushas om,
tar `Scout` ifrån dem, och den nattliga synken strippar dem enligt
verifieringsgrinden. `/link-scoutid` pushar om i bakgrunden, så det behövs ingen
massåtgärd för att det ska börja rulla.

#### Låset, och vägen runt det

Kravet går **inte** att slå på i efterhand: Discord vägrar lägga ett krav på en
roll som medlemmar redan har. Och rollen går inte att tömma först, eftersom den är
connection-managed — varken boten eller en admin kan ta bort den. Hönan och ägget.

Utvägen är en roll som *börjar* tom, och det avgörande skälet att föredra den är
att **ingenting tas ifrån någon förrän ersättaren är bevisat fungerande**:

1. Deploya koden som pushar `verified: true`
2. `node src/metadata.js --dry-run`, sedan utan flaggan. Metadatan hänger på
   *applikationen*, inte på rollen, så det här går före den nya rollen finns.
   **Läs `utan Discord-token`-listan** — de kan inte lagas härifrån och tappar
   rollen när kravet slås på (auditens kategori 3)
3. Skapa en ny roll i Discord med noll medlemmar och sätt kravet
   `Verifierad = true` på den
4. Se den fyllas. Antalet ska matcha de pushade. **Sanningens ögonblick** — går
   det inte har ingens åtkomst rörts
5. Pausa nattjobbet (`suspend: true` på `discord-scoutid-refresh`, under
   GitOps via en commit — en hand-patch återställs)
6. Peka `SCOUTNET_SCOUT_ROLE` på det nya namnet i configmappen och deploya
7. `/refresh-scoutid alla:true dryrun:true` → **måste visa noll strippningar.**
   Annars: backa configmappen, ingenting är skrivet
8. Avpausa nattjobbet. Gamla `Scout` kan tas bort först när ingenting namnger den

**Landminan i steg 6:** finns inte rollen som `SCOUTNET_SCOUT_ROLE` pekar på blir
`isVerified` falskt för *alla*, och synken strippar hela servern. Det är därför
nattjobbet pausas över bytet och därför dry-runen står mellan deployen och att
jobbet släpps lös igen.

Ett alternativ som *inte* rekommenderas: radera kravet helt från `Scout` (inte
bara stänga av det), varvid rollen troligen slutar vara connection-managed och
kan tas bort från alla — och lägg sedan tillbaka kravet på en tom roll. Det
slipper en ny roll, men mellan "borttagen från alla" och "Discord har delat ut
igen" ser grinden ingen som verifierad, och återutdelar Discord inte automatiskt
finns ingen väg tillbaka.

**Att öppna verifierings-URL:en räcker inte för att få rollen.** `Scout` är
connection-gated, så Discord delar ut den *bara* när användaren klickar Länka på
rollen inifrån Discord — bevisat genom uteslutning 2026-08-20: varken en
API-push eller ett direktbesök på URL:en gav rollen, men Länka-knappen gjorde
det. URL:en är ändå inte meningslös: den förnyar metadatan och tokenet, vilket
är precis vad grindens andra bevis läser. Användartexterna säger därför
`Kanaler och roller → Scout → Länka` och inte "kör `/linked-role`", som beskrev
en HTTP-route som ett slash-kommando — formuleringen finns numera på ett ställe,
`RELINK_INSTRUCTION` i [src/metadata.js](src/metadata.js), eftersom fem kopior
hade drivit isär till att alla vara fel på samma sätt.

**Länkningsvägen kan inte tillämpa verifieringsgrinden**, och det är inte en
brist som går att laga: Discord delar ut Linked Role-rollen efter att användaren
avslutat på *sin* sida, alltså efter att vår callback kört och success-sidan
renderats. En kontroll där hade fallit för varje förstagångslänkning. Vad som
däremot är lagat är att rapporten inte längre påstår motsatsen —
`roles.grantRoles` hoppar över managed roller och returnerar `{ granted,
problem }`, alltså vad som *faktiskt* delades ut, så händelseloggens rad visar
`participant, cmt` utan att hävda `scout`. Saknas `scout` i raden gick Discords
halva av flödet inte i mål. Den skipade `scout` är med flit **inget `problem`**:
att flagga den hade lagt en varning på varje frisk länkning.

##### Ett tomt rollresultat säger vilken sida som saknas

`problem` läses av **statuskoderna skrivningarna just fick**, aldrig genom att
fråga Discord igen efteråt — svaret går bara att veta medan de sker, och ett
andra varv hade varit en andra sanning om samma fråga. En 404 betyder att
*kontot* inte är med i servern, en 403 att skrivningen nekades, och en roll som
inte fanns i guilden namnges.

Fallbacken frågade tidigare `finns de i servern?` om varje sådant fall. Den
frågan besvarades 15 gånger 2026-09-21 av en ledare vars fyra roller alla fanns:
hon hade länkat från ett andra Discord-konto, skapat sju minuter före första
försöket, som aldrig gått med i servern — medan hon själv satt i servern på sitt
vanliga konto utan en enda roll. Vilket konto som länkat var precis det raden
inte kunde ställa. Samma dag blandade podloggen ihop det åt andra hållet:
`(bot role may be too low in hierarchy)` satt på *varje* misslyckad
rollskrivning, så tre 404:or lästes som ett hierarkiproblem och pekade på Server
Settings. `discord.memberWriteHint` äger numera den tolkningen, och hierarkin
nämns bara på den 403 som faktiskt betyder det.

Smeknamnsskrivningen svalde dessutom sitt fel helt (`catch { return false }`),
och båda anroparna läser `false` som "inget att rapportera" — så ett
misslyckat namnbyte lämnade *ingen* rad alls, bara frånvaron av den lyckade.

#### En misslyckad metadata-push river inte längre hela länkningen

`await updateMetadata(...)` låg oskyddat i callbacken, så ett *tillfälligt* fel
på det enda anropet nådde yttre catchen och svarade en medlem vars länk redan
var sparad med ett naket `500`: inga roller, inget smeknamn, ingen rad i
händelseloggen, och ingenting som sa vad hon skulle göra. Hon gjorde det enda
sidan tillät och körde om — tre gånger på tio sekunder 2026-08-24, varav två gick
igenom, vilket är varför loggkanalen fick samma rad två gånger.

Pushen fångas nu, och allt som inte beror på den körs ändå. Vad som med flit
*inte* händer är att påstå att det gick bra: utan `verified` hos Discord
utvärderas `Scout`-kravet som ouppfyllt och rollen delas inte ut, så medlemmen
måste tillbaka. Därför en egen sida
([src/templates/linked-incomplete.html](src/templates/linked-incomplete.html))
som säger just det, och en `⚠️`-rad i händelseloggen i stället för `✅`.

#### Sidan och loggraden väljs av samma utfall

Sidan valdes tidigare av `metadataFailed` ensam, så varje länkning där pushen
gick igenom fick lyckad-sidan — också när rollerna aldrig delades ut. Loggraden
skrev `inga roller — kontot är inte med i servern`, under en `✅`, medan
medlemmen fick höra att allt gått bra. En deltagare länkade fem gånger
2026-09-26 från ett konto som inte var med i servern och fick samma besked
varje gång. Testet för "inte anmäld i eventet" krävde dessutom lyckad-sidan,
alltså var felet inskrivet som specifikation.

`outcomeOf` i [src/server.js](src/server.js) väljer nu sidan, och loggradens
ikon följer samma fakta: `✅` bara för det medlemmen fick lyckad-sidan för.
Utfallen, i den ordning det första som stämmer vinner:

| Utfall | När | Sida |
| --- | --- | --- |
| `not-in-server` | skrivningarna fick 404 — se nedan, numera nästan bara ett mellanfall | *Fel Discord-konto*, med kontots namn |
| `no-roles` | inget delades ut, av annat skäl | *Inga roller*, eller *Rollerna kommer senare* vid ScoutNet-avbrott |
| `incomplete` | roller ja, men `verified` saknas | *Nästan klart* |
| `linked` | allt | lyckad-sidan |

`not-in-server` går före `incomplete` eftersom ingenting annat spelar roll
förrän rätt konto länkar. **Kontonamnet är vad som gör sidan användbar**: båda
gångerna det hänt satt personen i servern på ett annat konto, och frågan
"vilket konto använde jag?" var den enda ingen sida besvarade. Namnet hämtas i
Discord-callbacken och följer med i OAuth-state; det är text någon annan valt,
så det escapas. Avbrottsvarianten känns igen på `roles.SCOUTNET_UNREACHABLE`
och inte på formuleringen.

#### Ett konto utanför servern stoppas innan något sparas

`not-in-server` sparade tidigare länken ändå, "den halva som fungerade". Men en
länk för ett konto som inte är med i servern kan inte ge någonting, och varje
synk rapporterade dess 404 — tolv av 1 051 länkar 2026-10-06, de flesta andra
konton som länkat av misstag. `discord.isGuildMember` frågas därför två gånger:
i Discord-callbacken, innan tokens sparas och innan medlemmen skickas till
ScoutID, och i ScoutID-callbacken innan länken sparas. Svarar den `false`
visas *Fel Discord-konto* direkt och raden i händelseloggen blir `⛔ … ingenting
sparat`. Den andra frågan finns för den som lämnar mellan stegen.

**Bara Discords egen 404 stoppar.** Ett fel eller uteblivet svar är `null`, och
då fortsätter länkningen — ett Discord-avbrott får inte stänga ute någon som är
med, av samma skäl som `verifyConnection` skiljer `unknown` från `rejected`.
Kvar av det gamla är fallet där kontot lämnar *efter* frågan: skrivningarnas 404
ger då samma sida via `outcomeOf`, och länken står kvar.

Länkar som redan finns för konton utanför servern tas bort med
[src/prune.js](src/prune.js), för hand och aldrig schemalagt: den som lämnar och
kommer tillbaka måste länka om när länken är borta, så borttagningen är ett
beslut. Två bevis krävs, eftersom en saknad medlem aldrig får läsas ur en lista
som bara kom tillbaka kort — samma misstag som en trunkerad snapshot läst som
frånvaro. Medlemslistan måste ha minst hälften så många medlemmar som det finns
länkar, annars avbryts körningen, och varje kandidat tas bort först på en egen
404. Länken och kontots Discord-tokens försvinner tillsammans, och
händelseloggen får scoutid:t för varje, så ett misstag kan återställas med
`/link-scoutid`.

```bash
node src/prune.js --dry-run
```

Samma genomgång tog bort två nakna svar till: ett utgånget state gav `500`
(`getStateData` returnerar `null` efter tio minuter, och destruktureringen
kastade — sex gånger på fyra dygn), och en cookie från ett annat flöde gav
`403`. Båda, liksom de yttre catcharna och Discord-callbackens
state-kontroll, svarar nu med *Länkningen gick inte igenom*
och vägen tillbaka. Alla problemsidor delar
[src/templates/linked-problem.html](src/templates/linked-problem.html).

**Rollnamnet i medlemsvänd text kommer ur configen.** Sidan och varje mening om
rollen läser `SCOUTNET_SCOUT_ROLE` i stället för att stava "Scout" själva — en
HTML-fil är det lättaste stället för en sådan kopia att gömma sig, eftersom
ingenting som importerar den någonsin skulle falla. Följden är att värdet i
configmappen numera är *läst av medlemmar*: det står `Scout` och inte `scout`
därför, medan uppslagningen mot guilden fortsätter vara skiftlägesokänslig.

#### Retryn respekterar Discords `retry_after`

`retryWithBackoff` väntade `2^attempt * 1000` blint, alltså gissade på svaret
till exakt den fråga Discord redan besvarat — och gissade lågt, så varje
omförsök kom före fönstret öppnat. Mätt 2026-08-24: pushen fick vänta-beskedet
3,584 s och kördes om efter 1 s, sedan 2,402 s och kördes om efter 2 s, och gav
upp. Tre anrop, alla nekade, på något som hade lyckats en gång.

Sedan refaktoreringen 2026-08-25 går varje Discord-anrop genom `request` i
[src/http.js](src/http.js), som sätter `retryAfterMs` på felet — inget
anropsställe kan glömma den, för det finns bara ett — och `retryDelayMs` låter
Discords siffra vinna, klämd mellan 250 ms (aldrig en hot loop) och 10 s (två
omförsök i taket plus 10 s preStop ryms i podens 60 s
`terminationGracePeriodSeconds`, så ett rate limit kan inte hålla upp en
rollout).

## Config format reference

**Värdena står i instansens egen config, och bara där** — för exemplet i
[k8s/configmap.yaml](k8s/configmap.yaml), med påhittade värden. Det här avsnittet
beskriver *formen*; instansens fil bär värdena och motiveringen bakom varje
enskilt val.

Listan var tidigare en kopia av en prod-config, rubricerad "aktuell". Den höll
inte: vid ett stickprov hade fyra av fem nycklar driftat — ett dubblerat
`fee_id`, ett rollnamn med fel skiftläge mot guilden, och två som aldrig
uppdaterades när avdelningsnamnen rullades ut samma dag. En kopia av ett värde
som ändras är en andra sanning, och den förlorar alltid.

| Nyckel | Form |
| --- | --- |
| `LOG_CHANNEL_ID` | kanal-id; tomt = händelseloggen av, allt annat oförändrat |
| `LOG_MEMBER_EVENTS` | `join,leave,nickname,roles` — `off` eller tomt stänger scannern |
| `SCOUTNET_SCOUT_ROLE` | rollnamn. **Läses av medlemmar**, så guildens skiftläge |
| `SCOUTNET_EVENT_ROLE` | rollnamn |
| `SCOUTNET_FEE_ROLES` | `feeId:kategori,…` |
| `SCOUTNET_DIVISION_ROLES` | `kategori:frågeId:rollMedDiv:rollUtanDiv,…` |
| `SCOUTNET_CATEGORY_ROLES` | `kategori:rollnamn,…` — platt markör *utöver* divisionsrollen |
| `SCOUTNET_ADOPTION_SCOPE` | `kategori:kategori+kategori,…` — vilka kategorier den förstas medlemmar ser i `/adoption-scoutid`, i sin *egen* avdelning. Tomt = bara admins |
| `SCOUTNET_NICKNAME_SUFFIXES` | `kategori:suffixMedDiv:suffixUtanDiv,…`; `{div}` och `{divnamn}` fylls i |
| `SCOUTNET_DIVISION_NAMES` | `nummer:namn,…` — vad `{divnamn}` slår upp. Ofta en **andra kopia** av namn som också bygger serverns kanaler; inget upptäcker driften, så skriv ut på båda ställena att den andra finns |

Parsrarna ligger i [src/config.js](src/config.js) och pinnas av `unit/config`,
inklusive vad som händer med trasig indata. Roll-konfigurationen låg tidigare i
`terraform.tfvars`, men de variablerna togs bort när Container App avvecklades:
Terraform hanterar inte längre något som boten läser.

Läs ett värde ur en körande instans när du behöver det exakta:

```bash
kubectl -n <namespace> get cm discord-scoutid-config -o jsonpath='{.data.SCOUTNET_NICKNAME_SUFFIXES}'
```

## Nattlig rollsynk — [src/refresh.js](src/refresh.js)

Ett CronJob ([k8s/refresh-cronjob.yaml](k8s/refresh-cronjob.yaml), 04:10 UTC)
kör `syncAllUserRoles` mot hela servern och rapporterar till loggkanalen.

**Varför den finns:** ingenting propagerade ScoutNet-ändringar av sig självt. En
deltagare som fick avdelning tilldelad satt kvar på `Deltagare-Väntande` tills en
admin råkade skriva `/refresh-scoutid alla:true` — och ju närmare eventet, desto
mer rör sig indelningen. Arbetet var redan skrivet; det som saknades var något
som körde det utan att bli tillsagt.

**CronJob och inte en timer i servern**, av samma skäl som medlemsscannern:
Deployment kör `replicas: 2`, så ett intervall inne i den hade synkat allt två
gånger.

```bash
node src/refresh.js --dry-run          # visa vad den skulle ändra
kubectl -n <namespace> get cronjob discord-scoutid-refresh
```

Från Discord gör `/refresh-scoutid alla:true` samma sak, utan att behöva
klusterbehörighet.

Tre egenskaper som måste hålla om det här ändras:

- **Guild-tillståndet hämtas en gång per körning, inte en gång per användare.**
  `syncUserRoles` hämtade tidigare hela rollistan själv, så en körning över 2 500
  länkade personer bad om ett par hundra roller 2 500 gånger för att komma fram till att
  ingenting ändrats. Nu tar den emot `roleMap` och `member` från anroparen, och
  `syncAllUserRoles` hämtar båda en gång. Pinnat i `integration/syncall`.
- **Pausen mellan skrivningar tas bara när något faktiskt skrevs.** 200 ms per
  användare oavsett är åtta minuters sömn vid 2 500 personer för att rapportera
  att inget hänt. Det riktiga rate limit-skyddet är 429-retryn i `http.js`.
- **Nattjobbet är tyst när ingenting ändrades.** Det skrev tidigare en
  sammanfattning varje natt, med argumentet att ett schemalagt jobb som inte
  loggar något inte går att skilja från ett som slutat köra. Sant — men priset var
  365 rader om året som säger att inget hände, och en kanal som mest säger det är
  en kanal folk slutar läsa. Tystnad är alltså normaltillståndet; en rad betyder
  att något rörde sig.

  Vad som ersätter pulsen: ett dött CronJob syns som en gammal `LAST SCHEDULE` i
  `kubectl get cronjob`, och misslyckanden ligger kvar via `failedJobsHistoryLimit`.
  Räcker inte det återställer en *veckopuls* signalen till en hundradel av bruset,
  och den behöver inget tillstånd — bara en veckodagskontroll.

**Tre formatterare beskriver ett synkresultat, och de måste säga samma sak.**
`describeChanges` i eventlog.js, `formatRefreshSummary` i refresh.js och
`formatChanges` i commands.js. Den sista glömde smeknamnet medan `changedAnything`
räknade det — och en suffixändring flyttar *varje* medlem utan att röra en enda
roll, så dry-runen inför avdelningsnamnen 2026-09-21 rapporterade "240 med
ändringar" och skrev sedan "Inga ändringar" 240 gånger. Enda körningen vars hela
syfte var att visa vad som skulle hända visade alltså ingenting. `unit/commands`
pinnar numera att rendering och räkning följs åt.

**Bilagan bär sin egen dry run-markering.** Över 2 000 tecken blir rapporten en
fil, och filen är hälften som sparas och vidarebefordras — men `dryRunPrefix` satt
bara på meddelandet. En dry-run-fil gick därför inte att skilja från en skarp, och
frågan den lämnade öppen — döptes 240 personer om nyss? — gick inte att besvara ur
rapporten alls. `dryRunPlain` är samma markering utan markup, av samma skäl som
`formatAuditText` finns.

`/refresh-scoutid dryrun:true` kör samma sak från Discord utan att skriva.
`dryRun` är en **parameter, aldrig en modulflagga**: servern hanterar
förfrågningar samtidigt, så en processglobal flagga hade tystat en riktig
länkning som råkade köra samtidigt. En dry-run skriver heller aldrig i
händelseloggen — den kanalen är protokollet över vad boten *gjorde*, och
"hade gjort"-rader gör den opålitlig för den enda fråga den finns för.

## Händelselogg till Discord

[src/eventlog.js](src/eventlog.js) skriver vad boten *gjorde*, när det hände,
till en kanal — bäst en moderator-only kanal, eftersom raderna bär namn och
scoutid:n. `LOG_CHANNEL_ID` styr den; tomt värde betyder att loggen är av och allt annat
beter sig identiskt.

**Varför den finns:** informationen fanns bara i `kubectl logs`, alltså bara så
länge poden. Varje deploy kastade bort vem som länkat sig, vilka roller de fick,
och vem som tappat Scout-rollen och blivit strippad — precis de frågor som
ställs efteråt, när någon inte ser en kanal och ingen minns om personen ens
verifierat sig. `/audit-scoutid` svarar på *tillstånds*frågan, aldrig på
historiken, för ingenting sparade historik.

Loggas: lyckad `/linked-role`-länkning (med tilldelade roller), `/link-scoutid`
med vem som länkade vem, rollsynk per användare, och `/refresh-scoutid
alla:true` som en sammanfattningsrad plus en rad per *ändrad* användare.
`Overifierad` satt får en egen tydligare rad, eftersom det är det enda felet en
admin inte kan laga för användaren.

**Händelseloggen skriver namn, aldrig mentions.** En `<@id>` renderas som
`@okänd-användare` för varje klient som inte råkar ha medlemmen cachad — i en
guild av den här storleken de flesta, för det mesta. Orsaken är tystningen:
`allowed_mentions: { parse: [] }` lämnar också användarobjekten utanför det
postade meddelandet, så klienten har bara det nakna id:t. En sådan mention går
inte att klicka på heller, alltså kostade den raden dess namn och gav inget
tillbaka. Tystningen står kvar av ett annat skäl: raderna byggs av Discord-nick
och ScoutNet-namn, text andra har valt, och ett `@everyone` däri hade adresserat
hela servern från boten.

`who()` i [src/eventlog.js](src/eventlog.js) är formen: `**Namn**`, och **rått id
i kodstil** när namnet saknas — det går att klistra i `/status-scoutid personid:`,
vilket placeholdern aldrig gjorde. Därför returnerar medlemsscannerns
`displayName` numera `null` i stället för `"okänd"`: en platshållare hade både
namngett ingen och gömt id:t bakom sig.

Namnkällorna: medlemsscannern löser dem ur snapshoten (audit-loggen ger bara
id:n) och slår i `previous` för den som hunnit lämna. Synk- och refresh-raderna
får sitt ur resultatet — `syncUserRoles` och `stripUnlinkedMember` returnerar
`name` från medlemmen de redan hämtat, och `syncAllUserRoles` fyller i det även i
sina catch-grenar, som aldrig når den returen. Anroparens namn kommer ur
`interaction.member` i `handler`. Smeknamnsraden använder med flit *konto*namnet:
nicket är det som ändras och står redan två gånger i raden.

Formen delas numera av `/refresh-scoutid alla:true`, och `reportName` /
`reportNamePlain` i [src/guild.js](src/guild.js) är enda hemmet för den — den låg
tidigare bara i eventlog.js, och rapporten skrev råa id:n i bilagan och `<@id>` i
meddelandet. Bilagans variant bär **inget markup men behåller id:t bredvid
namnet**: en fil renderar ingenting, och filen är den långa listan en admin läser
igenom och går till när hen behöver ett id att klistra i `personid:`. Rapporten
sorteras dessutom på namn — 240 rader i lagringsordning är inte läsbara ens med
namn.

`/audit-scoutid` är **inte** omlagd och skriver fortfarande `<@id> (nick)`, med
samma platshållare i meddelandeversionen. Dess `affectedUsers` räknar dessutom
personer genom att plocka `<@id>` ur itemtexten, så en övergång där rör tretton
kategorier och den räkningen.

**En länkning som inte gav några roller säger varför.** Raden slutade tidigare
på `→ inga roller`, vilket är samma text för "inte anmäld i eventet", "avbokad
anmälan" och "rollerna finns inte i servern" — den loggade alltså att något var
fel utan att logga vad, och svaret går inte att rekonstruera efteråt eftersom
det är ett tillstånd i ScoutNet som sedan hunnit ändras. Det kostade en person
en kväll 2026-08-24: hon länkade sig, fick bara `Scout`, och varken loggen eller
`/refresh-scoutid person:` ("Inga ändringar") nämnde att hon inte fanns i
deltagarlistan.

Förklaringen kommer från `roles.explainMissingRoles`, och två egenskaper är hela
poängen med att den finns:

- **Ett ScoutNet-avbrott rapporteras som ett avbrott, aldrig som frånvaro.**
  Länkningsvägen frågar med `allowIncomplete`, så "inte anmäld" och "kunde inte
  fråga" kommer båda tillbaka som `[scout]` — det här är enda stället som
  fortfarande kan skilja dem. Att skriva ut det okända som ett känt nej hade
  bara flyttat `getDesiredRoles`' ursprungliga bugg in i loggen.
- **Den kastar aldrig**, och den bär aldrig med `e.message` från ScoutNet:
  strängen hamnar i en Discord-kanal, och API-nyckeln ligger i query-strängen på
  anropet som just misslyckades. Detaljen hör i podloggen.

`syncUserRoles` returnerar samma förklaring som `note`, och `/refresh-scoutid
person:` lägger den efter "Inga ändringar" — som är sant både för den som redan
har allt och för den som aldrig kunde få något, alltså det minst användbara sanna
svar som finns. Den frågas bara när önskelistan är den nakna markören, så den som
har sina roller får ingen not.

### Medlemshändelser — [src/memberscan.js](src/memberscan.js)

Joins och leaves i samma kanal, från ett CronJob som hämtar medlemslistan var
tionde minut och jämför mot förra körningen. Snapshoten ligger i Table Storage.

**Pollning, inte events**, eftersom boten pratar HTTP-interactions och inte har
någon gateway att ta emot `guildMemberAdd` på. Priset är upp till ett intervalls
fördröjning och att kick inte går att skilja från frivilligt utträde — det kräver
audit-loggen. Vinsten är att det inte behövs en andra bot, ingen privilegierad
gateway-intent, och ingen process som måste ha varit ansluten i rätt sekund: en
gateway-bot som legat nere en timme har tappat den timmen för alltid, den här
rapporterar ändringen vid nästa körning.

**CronJob och inte en timer i servern** eftersom Deployment kör `replicas: 2` —
ett intervall inne i den skulle rapportera varje join dubbelt. Det är också
därför snapshoten måste ligga i Table Storage och inte i processminnet.

`LOG_MEMBER_EVENTS` väljer vad som rapporteras: `join`, `leave`, `nickname`,
`roles`; `off` eller tomt stänger av scannern helt.

**`roles` rapporterar bara rolländringar som någon *annan än boten* gjort**, läst
ur Discords audit-logg och filtrerad på botens eget user-id. Boten loggar redan
sina egna ändringar i samma stund de sker, så en diff-baserad rapport hade mest
upprepat sig själv — en `/refresh-scoutid alla:true` skulle blivit en rad per
användare, två gånger. Kvar blir det enda händelseloggen aldrig kan se: en
moderator som ändrar roller i Discords gränssnitt, med namn på vem.

Audit-loggen är också enda källan som *vet* vem som gjorde något, och det kräver
**View Audit Log** på botens roll (+128 → `402653312`). Rollen är en managed
integrationsroll, så biten sätts för hand i Server Settings → Roles; Terraform
äger den inte. Saknas den loggar scannern en varning och hoppar över kategorin —
inget annat påverkas. Den ligger av som default just därför.

**Kick och ban skiljs från frivilligt utträde** med samma behörighet. Saknas en
audit-post är avgången genuint okänd — det täcker både frivilligt utträde och en
oläsbar audit-logg — så raden säger `är inte längre medlem` och påstår ingenting.
Med en post blir det `kickad av @X — anledning: …` eller `bannad av @X`. Ban slår
kick när båda finns för samma person; att rapportera "kickad" för någon som
slutade bannad underdriver vad som hände. Kategorierna degraderar **olika** utan
behörigheten, med flit: rolländringar *hoppas över* (fallback till diffen hade gett
botens eget eko), medan avgångar rapporteras ändå, bara utan uppdelningen.

**En markör per action-typ**, inte en delad över hela loggen. En delad hade låtit
en skur av en typ tränga ut en annan: `/refresh-scoutid alla:true` skriver en post
per ändrad användare, och en kick i samma fönster hade legat under taket och
hoppats över för alltid när markören flyttades förbi. Per typ kan varje hämtning
dessutom filtrera på serversidan, så en pratig typ kostar en tyst ingenting.

**En tom logg seedar till början, inte till "nu".** Kickar och bannar är sällsynta,
så en guild som aldrig haft någon returnerar `null` — och att seeda `null` lämnar
markören `null`, vilket gör att nästa körning seedar igen på den allra första
kicken som händer och sväljer den. Finns ingen historik finns inget att hoppa över.

**Markören är ett audit-logg-id, inte en tidsstämpel**, och den sparas i samma
entity som snapshoten. Två entities hade kunnat hamna i otakt efter ett halvt
misslyckande, och otakten hade antingen dubblerat eller tappat poster.
Pagineringen går *bakåt* med `before`: Discord returnerar nyast först, så
`?after=X&limit=100` ger de 100 nyaste posterna över X — hade 150 hunnit samlas
saknas de 50 närmast X, och att flytta markören förbi dem hoppar över dem för
alltid. En `/refresh-scoutid alla:true` skriver en post per ändrad användare, så
att fylla ett 100-fönster är en vanlig tisdag här.

Två egenskaper som måste hålla:

- **Snapshoten sparas först efter att rapporten är skriven.** Misslyckas
  skrivningen lämnas den orörd, så nästa körning rapporterar samma diff igen. I
  en granskningslogg är en dubblett vid omförsök billigare än ett hål. Därför
  kastar koden ett fel i stället för att `process.exit(1)` mitt i funktionen —
  sparningen är nästa sats, och kontrollflöde som förlitar sig på att exit
  avbryter är en refaktorering från att skriva ändå.
- **Första körningen seedar en baslinje tyst.** Att annonsera varje befintlig
  medlem som nyanländ skulle begrava kanalen och lära alla att ignorera den.

`/scan-scoutid` kör samma `runMemberScan` som CronJobbet, direkt, för den som
inte vill vänta på schemat. `dryrun:true` visar vad den skulle rapportera utan
att posta eller flytta snapshoten — raderna kommer tillbaka i svaret i stället.

**Dry-run samlar rader i en sink, inte via en global flagga.** Formatterarna
returnerar strängar (`formatMemberJoined` osv.) i stället för att logga själva.
Tidigare loggade de internt, så `dryrun:true` köade raderna och flush-timern
postade dem några sekunder senare — en dry-run som inte var torr. En
processglobal dry-run-flagga hade varit fel lösning: servern hanterar
förfrågningar samtidigt, så den hade tystat en länkning som råkade logga just då. En manuell körning kan överlappa CronJobbet;
värsta fallet är att samma ändring rapporteras två gånger, vilket är den
avvägning hela loggen gör med flit.

```bash
node src/memberscan.js --dry-run      # skriv ut vad den skulle rapportera
kubectl -n <namespace> get cronjob discord-scoutid-memberscan
```

**Snapshoten är chunkad över properties och kontrollsummeras på längd.** En
Table Storage-property tar 32K UTF-16-*tecken*, inte 64K byte som det ofta
skrivs. Exakt 32768 tecken avvisas med `PropertyValueTooLarge`; vid 16384 tecken
returnerade Azurite datan *tyst korrumperad* (ett `ä` kom tillbaka som två
ersättningstecken), medan 8192 rundgick 2500 medlemmar identiskt. Därför 8192,
och därför sparas `chars`: en snapshot som inte har rätt längd behandlas som
frånvarande, så scannern seedar en ny baslinje i stället för att rapportera en
diff full av medlemmar som aldrig gått med och aldrig lämnat.

Tre egenskaper som måste hålla om filen ändras:

- **Kastar aldrig vidare till anroparen.** En misslyckad loggskrivning får inte
  förvandla en lyckad länkning till ett fel för användaren.
- **Fördröjer aldrig anroparen.** `logEvent` buffrar och returnerar; skrivningen
  sker på en timer, så ett trögt Discord-API kan inte bromsa
  `/refresh-scoutid`.
- **Buffern töms vid avstängning.** `flushEventLog()` awaitas i SIGTERM-kedjan i
  [src/server.js](src/server.js), *efter* `pendingWork` — flushar man före
  missas det ett slash-kommando loggar på vägen ut.

Botens roll behöver bara Manage Roles + Manage Nicknames (`402653184`, plus
View Audit Log för medlemsscannern), alltså varken View Channels eller Send
Messages globalt. Då kan den skriva i loggkanalen enbart tack vare en channel
overwrite där. **En 403 här betyder att overwriten saknas, inte att token är
fel.**

## Verktyg i devcontainern

`actionlint` granskar `.github/workflows/` statiskt — odefinierade `needs`,
felstavade `${{ secrets.* }}`, ogiltiga `runs-on`-etiketter — och kör
`shellcheck` på varje `run`-block. **Kör den innan du pushar en
workflow-ändring.** Den lades till efter att en sådan ändring fick valideras
genom att pushas till en gren och se vad som hände, vilket är ett långsamt sätt
att hitta ett stavfel. Samma binär körs numera också som första steg i CI, för en
linter som bara finns lokalt blir överhoppad.

```bash
actionlint                 # hela .github/workflows/
yq '.spec.template.spec.containers[0].image' k8s/deployment.yaml
```

**`chmod +x` når inte en commit här.** Workspacet är en bind-mount från Windows
och git står på `core.filemode=false`, så filläget ignoreras helt — ett skript
som fungerar lokalt landar som `100644` och faller i CI med "Permission denied".
Det tog en misslyckad deploy att upptäcka. Spela in läget explicit, och anropa
skript via `bash` i workflows så de inte beror på att biten överlevde:

```bash
git update-index --chmod=+x scripts/nytt-skript.sh
```

`yq` finns för k8s-manifesten och kustomize-utdata. `python3-yaml` finns som
fallback — imagen har inget `pip`, så apt är enda vägen till en YAML-parser.

### ESLint och Prettier

```bash
npm run lint            # eslint .
npm run format          # prettier --write .
npm run format:check    # vad CI kör
```

Båda fäller CI, före testerna, och alltså även imagen. Att de fäller i stället
för att varna är avsiktligt: det de rapporterar orsakas av just den commit som
byggs och fixas genom att redigera den. Drift som ingen kodändring orsakat är
fallet för att bara varna, det här är inte det.

**ESLint-extensionen var installerad långt innan konfigurationen fanns.** Den
följer med `javascript-node`-basimagen, tillsammans med ett globalt `eslint`, och
ESLint 9+ kräver en flat config — så den kastade `Could not find config file` för
varje fil den tittade på: 175 fel i en enda sessions logg, inget av dem om koden.
[eslint.config.js](eslint.config.js) är filen som saknades.

Den ligger nära `recommended` och innehåller **ingenting stilistiskt** — Prettier
äger formatering, så det finns ingen konflikt att skilja på och därför inget
behov av `eslint-config-prettier`. Tre tillägg säger något om avsikt i stället
för layout: `eqeqeq` med `null: "ignore"` (`!= null` är idiomet här — en
`cancelled_date` är antingen en datumsträng eller frånvarande), `no-var` och
`prefer-const`.

[prettier.config.mjs](prettier.config.mjs) är tom på overrides, för att alla
defaults redan stämde: koden var handskriven på ~80 kolumner med dubbla
citattecken och semikolon. Att skriva ut dem hade bara skapat något att drifta
från. **Markdown är undantaget** i [.prettierignore](.prettierignore), och det är
enda egentliga bedömningen där: CLAUDE.md och README.md *är* dokumentationen,
handbrutna på 80 kolumner, och Prettier skulle skriva om `*så*` till `_så_` och
rada om varje tabell — 153 rader utan att en mening blir tydligare. Prosans
formatering är författarens, kodens är Prettiers.

Prettier är en workspace-side extension, så en som är installerad på
Windows-värden **kör inte i containern**. Därför ligger `esbenp.prettier-vscode`
i `devcontainer.json`, och därför pekas `editor.defaultFormatter` ut explicit
i stället för att bero på vad värden råkat synka: utan det lämnade en synkad
inställning som pekade på Prettier format-on-save tyst overksam, vilket läste
som att Prettier var trasig.

## Tester

```bash
npm test                  # ren logik, ingen uppsättning
docker compose up -d azurite
npm run test:integration  # hela flödet mot riktig Table Storage
npm run test:all
```

Uppdelningen är avsiktlig. `npm test` behöver ingen container, inget nätverk och
inga credentials, så den blir körd — en svit som inte går att köra utan
uppsättning slutar köras. `test/integration/` behöver Azurite, eftersom länken
mellan Discord och ScoutID ligger i Table Storage och halva logiken grenar på om
den finns.

| Fil | Täcker |
| --- | --- |
| `unit/config` | Env-parsrarna. De avgör vilken roll varje medlem får, från strängar skrivna för hand i en ConfigMap, så testerna pinnar även vad som händer med trasig indata |
| `unit/commands` | Vem ett kommando agerar på (`person` vs `personid`, och att båda satta är ett fel), plus hela `/refresh-scoutid alla:true`-rapporten som ren funktion: att renderingen *matchar* ändringsräkningen — ett resultat som bara byter smeknamn måste synas som en ändring och inte som "Inga ändringar" — att ingen halva använder mentions, att listan sorteras på namn med den namnlösa sist, och att bilagans dry run-markering bär ingen markup |
| `unit/nickname` | `fitNickname` — att suffixet aldrig är det som huggs av, att efternamnet kortas från höger, och att resultatet går att strippa och suffixa om så ett avdelningsbyte landar. Plus `{divnamn}`, och att en namnlös avdelning tappar platshållaren *och* separatorn |
| `unit/roles` | `getDesiredRoles` och `getNicknameSuffix` — fee → kategori → divisionsroll, zero-padding, plattmarkörer, avbokade. Plus att ett ScoutNet-fel *kastar* i stället för att se ut som ett tomt svar, att `explainMissingRoles` håller ett avbrott skilt från en frånvaro, och att `grantRoles` skiljer ett konto utanför servern (404) från en nekad skrivning (403) från en roll som inte finns |
| `unit/discord` | Paginering förbi 1000-gränsen, 429-retry — inklusive att Discords `retry_after` vinner över backoff-trappan — att fel bär sin HTTP-status, att mentions alltid tystas, och att `memberWriteHint` läser 404 som medlemmen och 403 som behörigheten — och gissar inte på något annat |
| `unit/eventlog` | De tre reglerna: kastar aldrig, fördröjer aldrig, tappar aldrig buffern. Plus batchning under 2000 tecken, och att en länkning utan roller bär sin förklaring medan en med roller inte gör det |
| `unit/memberscan` | Sammanfattningen och audit-pagineringen bakåt |
| `unit/adoption` | Att grupperingen följer configen och inget annat: att ge en kategori en divisionsconfig delar upp den, att ta bort den slår den samman, utan kodändring. Plus avdelningsvyn: att en ledares scope kommer ur ScoutNet, att varje person hamnar i steget där vägen bröts, och att den som länkat från två konton räknas på det som kom längst |
| `unit/server` | Interactions-endpointen över en riktig socket med ett riktigt ed25519-nyckelpar: förfalskade signaturer avvisas, PING besvaras, varje kommando ACK:as inom Discords 3-sekundersfönster, och admin-grinden hålls. Plus att de två health-routerna svarar *olika*: liveness 200 utan storage inom räckhåll, readiness 503 |
| `integration/roles` | `syncUserRoles` — verifieringsgrinden, prefixborttagning av gamla divisionsroller, 403 i hierarkin, 32-teckensgränsen, att ett ScoutNet-avbrott inte ändrar någonting, och att `note` skiljer "redan rätt" från "aldrig anmäld" |
| `integration/metadata` | Att pushen bär `verified: true` utan att kontakta ScoutID, att ett ScoutNet-avbrott bara kostar det visade namnet, att `utan token` skiljs från `fel` — och `verifyConnection`s tre svar: ett onåbart Discord är aldrig ett nej, men ett dött refresh-token (`invalid_grant`) är det |
| `integration/syncall` | `syncAllUserRoles` — att guild-tillståndet hämtas *en* gång, att en oförändrad server inte skriver något, och att en dry-run inte skriver alls |
| `integration/health` | `/readyz` mot en riktig tabell — enda sättet att testa svaret som betyder något: 200 när storage faktiskt fungerar |
| `integration/audit` | Alla 13 kategorierna, och att auditen aldrig skriver |
| `integration/linking` | `/scoutid-oauth-callback` över en riktig socket: att en misslyckad metadata-push ändå länkar, delar ut roller och sätter smeknamn — och svarar med sidan som säger vad som saknas i stället för ett `500`. Att ett konto utanför servern stoppas innan något sparas, i båda callbackarna, och får *Fel Discord-konto* med sitt namn escapat — men att en obesvarad medlemsfråga inte stoppar någon. Att sidan och loggraden följs åt: en länkning utan roller får aldrig lyckad-sidan eller `✅`, och ett ScoutNet-avbrott säger att rollerna kommer i stället för att de saknas. Plus att ett utgånget state och en främmande cookie svarar med en sida och inte ett naket `400`/`403` |
| `integration/memberscan` | Hela flödet i sekvens: vad som sparas när, och vad som inte får sparas |
| `integration/prune` | Att en länk utanför servern tas bort med sina tokens, och de två sätten det kunde gå fel: en kort medlemslista läst som frånvaro, och ett fel läst som en 404. Båda behåller länken |

**`server.js` exporterar nu `app` och lyssnar bara som entrypoint.** Importerad
binder den ingen port och installerar ingen signalhanterare, så testerna kan
starta den på en egen efemär port och köra rutterna precis som de deployas —
utan att lägga till en HTTP-klient som beroende. Skulle grinden någon gång bli
fel märks det direkt: podden skulle avslutas utan att lyssna, `rollout status`
falla, och `maxUnavailable: 0` hålla de gamla poddarna kvar i trafik.

Tre egenskaper är värda att förstå innan man ändrar i dem.

**En ren guild måste ge noll fynd** (`integration/audit`). Varje falskt positivt i
någon av de 13 kategorierna dyker upp direkt, och en brusig audit är en ingen
läser. Det är ett starkare test än det ser ut.

**Signaturkontrollen testas från båda hållen.** Testet genererar ett riktigt
ed25519-nyckelpar och signerar som Discord gör, så både den giltiga och den
förfalskade vägen körs. Ett av fallen signerar en kropp och skickar en annan —
det är den kontrollen som står mellan `/interactions` och vem som helst på
internet som postar ett påhittat admin-kommando.

**Auditen får inte skriva.** Stubben vägrar varje icke-GET och testet påstår att
listan är tom, så egenskapen upprätthålls i stället för att antas — det är den
som gör det säkert att köra auditen lokalt mot prod-credentials.

Varje integrationsfall finns för att det fångat något riktigt, och de är märkta
med vad. Buggar de hittade: tyst UTF-8-korruption i chunkningen, `process.exit`
som kontrollflöde mitt i en funktion, ett namnfel som gav `<@undefined>`, en nolla
rapporterad för en avstängd kategori, dry-run som ändå skrev till kanalen, och
första kicken i en guild som svaldes av markör-seedningen. Låt etiketterna stå —
de beskriver felen, inte bara koden.

Azurite hittas av [test/helpers/azurite.mjs](test/helpers/azurite.mjs), som provar
fyra adresser i tur och ordning och avslutar med instruktioner om ingen svarar.
`AZURITE_TABLE_HOST` går före allt.

Den fjärde är den som gör `docker compose up -d azurite` användbart **inifrån
devcontainern**, och den är inte självklar: compose lägger Azurite på sitt eget
nätverk, som den här containern inte är med i, och publicerar porten på
Docker-*värden*. Alltså når varken `azurite` eller `127.0.0.1` den — utan
default-gatewayen gör det. Hjälparen läser den ur `/proc/net/route` (och provar
`host.docker.internal` först, för Docker Desktop). Att byta ut `globalThis.fetch` stör inte lagringen:
Table Storage-SDK:n går via nodes `http`-modul, inte via global fetch.

## Audit och konsistenskontroll

Audit-logiken ligger i [src/audit.js](src/audit.js) och körs antingen via slash-kommando eller schemalagt.

### Kategorier som kontrolleras

1. **Scout-roll utan storage-länk** — användare med Scout-rollen men ingen ScoutID-länkning i Table Storage
2. **Saknar Scout-rollen *och* har ingen giltig Discord-koppling** — Discord Linked Role har fallit bort (frånkopplad app, lämnad/återansluten server). Användaren måste re-verifiera via `/linked-role` själv eftersom Scout är en managed roll
3. **Länkade utan sparade Discord-tokens** — länken räcker för roller och smeknamn men inte för att prata med Discord i användarens namn, så `updateMetadata` kan inte pusha Linked Role-metadata. Felet är tyst: allt fungerar till Scout-rollen faller bort, och då kan varken admin eller bot laga det — personen måste själv köra om `/linked-role`. **`/link-scoutid` lagar inte det här**, den skapar bara länken. Exakt vad Redis-wipen 2026-05-26 lämnade efter sig, eftersom länkar och tokens försvann tillsammans
4. **Storage-länk utan guild-medlem** — gamla länkningar för användare som lämnat servern. Rensas med `node src/prune.js`; nya kan inte uppstå från länkningsflödet, bara av att någon lämnar
5. **Avbokade i ScoutNet** — länkade användare med `cancelled_date` satt
6. **Namnskillnader** — Discord-smeknamn matchar inte ScoutNet-namn
7. **Saknade statiska roller** — roller boten skulle tilldela som inte finns i guilden
8. **Saknade division-roller** — `Deltagare-{nr}` etc. som ScoutNet refererar till men som inte finns
9. **Okända fee_id** — `fee_id` i ScoutNet utan mappning i `SCOUTNET_FEE_ROLES`
10. **Bot-hierarki/permissions** — roller över botens position, eller saknade `MANAGE_ROLES`/`MANAGE_NICKNAMES`
11. **Roll-drift** — per användare: vilka roller saknas / vilka borde inte finnas, ur samma `planRoles` som synken skriver efter
12. **Multipla division-roller** — användare som har t.ex. `Deltagare-05` och `Deltagare-07` samtidigt
13. **Fel nickname-suffix** — användare där `(X)` i nicket inte matchar förväntat värde

Auditen är helt läsande — inga `addRole`/`removeRole`/nickname-anrop — så den går
att köra lokalt mot prod-credentials när slash-kommandot inte räcker. Sedan
grinden fick två bevis **frågar kategori 2 båda**: en medlem utan Scout-rollen men
med levande OAuth-grant är inget fynd, utan en rad i kategorins `note`. Innan dess
listade den 17 personer som inte var i någon fara alls, med identiska råd ingen av
dem behövde — och en audit som skriker lika högt om ett icke-problem som om ett
problem är en ingen läser. Proben är en `GET`, så auditen är fortfarande läsande.

**Två format, för Discord renderar inte bilagor.** `formatAuditMarkdown` är för
meddelandet: `**fetstil**` och `<@id>` blir namn. Över 2 000 tecken blir rapporten
en `.txt`, och där renderas ingenting — den kom fram som literala `__…__` och råa
sifferid:n, oläslig precis när den är lång nog att behöva läsas. `formatAuditText`
löser upp namnen ur `audit.names`, strippar markup och stryker under rubrikerna.

**Rubriken räknar personer, inte bara fynd.** En person kan förekomma i fyra
kategorier, så "23 avvikelser" lästes som en nödsituation när sanningen var två
medlemmar som behövde göra något. `totals.affectedUsers` plockas ur
omnämnandena i itemtexten — mentionformatet är fast, och alternativet är att
bygga om tretton kategorier för ett tal.

### Kommandon

**Ett kommando per fråga.** De växte ihop, och två av dem svarade på samma sak:
`/status-scoutid` utan argument körde `runAudit()` och skrev dess sammanfattning —
samma beräkning över samma data som `/audit-scoutid`, bara kortare. En person
måste därför anges sedan 2026-08-21.

| Kommando | Verb | Frågan det svarar på |
| --- | --- | --- |
| `/refresh-scoutid` | **ändrar** | vad rollerna ska vara, och sätter dem (`dryrun:true` visar utan att ändra) |
| `/audit-scoutid` | granskar | vad som är inkonsekvent, just nu |
| `/adoption-scoutid` | granskar | hur många av de anmälda som har länkat sig, per grupp — för en ledare: var varje person i avdelningen står |
| `/status-scoutid person:` | granskar | allt boten vet om en person |
| `/scan-scoutid` | **ändrar** | vad som hänt sedan förra körningen (medlemshändelser) |

#### `personid:` — vägen förbi personväljaren

`/refresh-scoutid`, `/status-scoutid` och `/link-scoutid` tar **`personid:`**
(ett rått Discord user-id) vid sidan av `person:`. Skälet är att väljaren inte
når alla: servern har regelgrind (`MEMBER_VERIFICATION_GATE_ENABLED`), och en
medlem som inte accepterat reglerna står som `pending` — Discord gömmer den ur
varje personväljare och ur mention-autocomplete. Hen finns i guilden, kan bära
länk, roller och smeknamn, och är alltså precis den admin oftast behöver laga.
I en server med regelgrind kan en betydande andel av medlemmarna vara pending —
mätt en gång till drygt en femtedel — och en felaktig länkning gick inte att
rätta eftersom personen inte gick att välja.

Tre egenskaper att hålla:

- **Både `person:` och `personid:` satta är ett fel, inte ett val.** De kan peka
  på olika personer, och att låta den ena vinna hade ändrat fel användare
  ungefär varannan gång.
- **`scoutid:` står först i `/link-scoutid`.** Discord avvisar ett obligatoriskt
  argument placerat efter ett valfritt, och ingen av de två person-varianterna
  kan vara obligatorisk när endera duger.
- **Svaren nämner regelgrinden när den är satt.** En pending medlem tar emot
  roller och smeknamn precis som alla andra och ser ändå ingen kanal, så en
  lyckad synk och en verkningslös synk ser likadana ut utifrån. `pendingNote`
  är vad som skiljer dem, och den kastar aldrig — den kommenterar ett svar som
  är korrekt utan den.

Definitionerna ligger i [src/discord.js](src/discord.js), så **en ändring här
kräver att kommandona registreras om** — koden ensam räcker inte:

```bash
docker run --rm --env-file .env ghcr.io/scouterna/discord-scoutid-linked-role:<sha> node src/register.js
```

**Auditens rolldrift och synken räknar med samma funktion**, `roles.planRoles`.
Kategori 11 återimplementerade tidigare uträkningen, och de två sa olika saker:
auditen räknade inte `Overifierad` som felaktigt hållen, synken tog bort den. Den
anropar med flit *inte* hela dry-run-synken — den kör verifieringsproben, som kan
förnya och spara ett token och alltså skriva, och den räknar smeknamn som
kategori 6 och 13 redan granskar. Det som skilde var rolluträkningen, och den
finns nu på ett ställe. Kvar som avsiktlig skillnad: auditen hoppar över
medlemmar boten inte kan ändra, eftersom deras drift är ett fynd ingen kan åtgärda.

- `/audit-scoutid` — full rapport (admin). Filattachment om >2000 tecken.
- `/scan-scoutid` — kör medlemsscannern nu (admin). `dryrun:true` = visa utan att posta.
- `/refresh-scoutid` — synka roller. `person:` en användare, `alla:true` hela
  servern (admin), `dryrun:true` visar utan att ändra. Slash-kommandonas flaggor
  heter **`dryrun`**, inte `torrkör` — namnet är ett gränssnitt admins skriver.
- `/status-scoutid person:` — detaljerad status för en användare. Antingen
  `person:` eller `personid:` krävs.
- `/adoption-scoutid` — hur många av de anmälda som länkat sig, per grupp (admin), eller för en ledare den egna avdelningen. `avdelning:12` visar en avdelning som ledarna ser den (admin).
  `saknas:true` listar namnen.

  **Grupperingen kommer helt ur configen** — [src/adoption.js](src/adoption.js)
  nämner ingen kategori vid namn. `SCOUTNET_FEE_ROLES` ger kategorin,
  `SCOUTNET_DIVISION_ROLES` avgör om den delas upp och på vilken fråga, och
  `SCOUTNET_CATEGORY_ROLES` ger rubriknamnet. En kategori utan divisionsconfig är
  *en* grupp; får den en rad i `SCOUTNET_DIVISION_ROLES` delas den upp utan
  kodändring. Det är exakt vad som behövs den dag en kategoris uppdelning finns
  i en ScoutNet-fråga — innan dess går den inte att dela upp, och flera
  `fee_id` som pekar på samma kategori säger ingenting om vem som gör vad.

  Rubriken speglar configen: en kategori utan flat roll etiketteras med sin nyckel,
  så `1003:cmt` ger "cmt" och `1003:CMT` ger "CMT". Rolluppslagningen är
  skiftlägesokänslig, så det är fritt att välja.

  **Den som inte hamnar i någon grupp räknas under "Utanför grupperna", med skäl.**
  Grupperna ensamma svarar på "hur många har länkat sig" och utelämnar tyst var och
  en som grupperingen inte kunde placera — alltså precis dem något är fel för. Fyra
  skäl, med fyra olika ägare, och de hålls isär därför:

  | Skäl | Vad det betyder |
  | --- | --- |
  | Avbokade i ScoutNet | Utanför `total` också — de är inte någon vi väntar på, så att räkna dem hade tryckt ned täckningssiffran med folk som inte saknas. Listas bara om de ändå är länkade: de behåller sina roller tills synken körs |
  | Utan `fee_id` | Obekräftad och obetald anmälan. ScoutNets sida, och kan lösa sig själv |
  | `fee_id` utan mappning | Vår sida: raden saknas i `SCOUTNET_FEE_ROLES`. De två ser likadana ut i datan, och skiljs åt här eller ingenstans |
  | Länkade utan anmälan | Har en länk men finns inte i deltagarlistan. Bär sitt discord-id, eftersom det är vad `/status-scoutid personid:` tar |

  **Ledare ser sin egen avdelning.** Kommandot är därför inte längre dolt för
  icke-admins (`default_member_permissions` saknas), och grinden sitter i
  handlern: admin utan argument får hela rapporten, admin med `avdelning:` en
  avdelning, och den vars kategori har en rad i `SCOUTNET_ADOPTION_SCOPE` sin
  egen. Alla andra nekas. Vill man dölja kommandot i väljaren för deltagarna görs
  det i Server Settings → Integrations; grinden i koden gäller oavsett.

  Avdelningen läses ur **ScoutNet via ledarens egen länk**, inte ur rollerna —
  rollerna härleds ur samma svar men kan ligga en natt efter. En ledare som inte
  länkat sig kan alltså inte köra den, vilket är rätt: utan länk vet boten inte
  vem hen är.

  Vyn listar var varje person *fastnat*, i den ordning vägen går, eftersom varje
  steg har en annan nästa åtgärd: inte länkad · länkad men inte i servern ·
  inte accepterat reglerna · `Overifierad` · inne. **Alla namnges, också de som
  är inne**, en per rad: första versionen räknade bara de inne och skrev de
  andra som ett stycke separerat med komman, och en ledare kunde varken se vilka
  som kommit in eller hitta ett namn bland 34. Förklaringarna står i Discords
  småtext (`-#`) så namnen bär vikten. Två begränsningar är med flit:

  - **"Inte länkad" kan inte delas upp** i "i servern men inte länkad" och
    "aldrig gått med". Utan länk finns inget som binder ett Discord-konto till
    ett scoutid, och att gissa på smeknamn hade gett säkra svar som är fel.
    Sidan säger det rakt ut.
  - **`Overifierad` läses ur rollen, inte ur OAuth-proben.** Proben kan förnya
    och spara ett token, alltså skriva, och rapporten ska vara läsande. Priset
    är upp till ett dygns eftersläpning — synkens egen takt.

  Två saker att hålla om filen ändras: **en tom kategori skriver inga rader**
  (fyra tomma rubriker lär folk skumma förbi den dagen en av dem inte är tom), och
  **ingen markup i bilagan** — Discord renderar ingenting i en fil, så en backtick
  kommer fram som en backtick. Samma sak som `formatAuditText` finns för.

## Krav på Discord-servern

**Boten skapar inga roller.** Rollerna måste finnas i servern med de namn
configen anger — `SCOUTNET_SCOUT_ROLE`, `SCOUTNET_EVENT_ROLE`, varje
`rollMedDiv`/`rollUtanDiv` i `SCOUTNET_DIVISION_ROLES` för varje division
ScoutNet kan svara med, varje roll i `SCOUTNET_CATEGORY_ROLES`, och en roll per
kategori utan divisionsconfig, döpt efter kategorin. Boten letar upp dem efter
namn (skiftlägesokänsligt) och hoppar **tyst** över en som inte finns, så en roll
som döpts om på ena sidan slutar bara delas ut — auditens kategori 7 och 8 är
det som ser det. Vem som äger rollerna (handpåläggning eller Terraform) är
instansens sak; skriv i det repot vilken configrad varje roll motsvarar.

`SCOUTNET_SCOUT_ROLE` är speciell: en **managed Linked Role**, skapad i
Discords gränssnitt mot `verified`-metadatan — aldrig av boten och inte av
Terraform. Se avsnittet om Developer Portal för varför kravet inte får slås på
före koden.

**Två kategorier kan dela divisionsmönster** — t.ex. två resegrupper vars
patruller har gemensam numrering, båda `IST-Patrull-{div}`, med var sin platt
markör som också är kategorins väntande-roll (`+` i `SCOUTNET_CATEGORY_ROLES`).
Markören delas då ut direkt och ligger kvar när divisionen kommer. Två saker
följer: `divisionPrefixes` returnerar varje prefix en gång, annars togs en gammal
divisionsroll bort två gånger; och `getDesiredRoles` deduplicerar, eftersom
markören efterfrågas både som markör och som väntande-roll. Båda pinnas i
`integration/roles`.

**Att radera en roll som boten delat ut kräver ordning**: ändra configen och
synka först, radera sedan. En raderad roll försvinner från alla på en gång, och
gör den det medan boten fortfarande hanterar den syns det inte i någon logg.
