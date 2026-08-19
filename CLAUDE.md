# Discord ScoutID Linked Role Bot

## Build & Deploy

**The bot runs on Kubernetes**, in namespace `wsj27` on Scouterna's shared AKS
cluster `webservices` — not on Azure Container Apps. Deploying is a push to
`main`: [.github/workflows/deploy.yml](.github/workflows/deploy.yml) builds the
image, pushes it to GHCR and applies `k8s/`. The `prod` environment gates it.

**Always tag images with the git SHA, never `latest`.** The reason changed with
the platform but the rule did not: on Container Apps a mutable tag silently kept
the old container running; on Kubernetes it makes rollouts and `rollout undo`
ambiguous, because two different images share one name.

```bash
export KUBECONFIG=~/.kube/wsj27.yaml   # ~/.kube/config is rancher-desktop

kubectl get pods -l app=discord-scoutid
kubectl logs -l app=discord-scoutid --tail=50 --prefix
kubectl rollout status deploy/discord-scoutid
kubectl rollout restart deploy/discord-scoutid      # zero-downtime, see below
kubectl rollout undo deploy/discord-scoutid         # previous ReplicaSet
```

**Break-glass manual deploy.** `kubectl apply -k k8s/` alone will *not* work:
the committed `newTag` is a deliberate placeholder that CI rewrites in its own
checkout, so applying it as-is gives `ImagePullBackOff`. Name the tag:

```bash
IMG=ghcr.io/scouterna/discord-scoutid-linked-role
(cd k8s && kustomize edit set image "$IMG=$IMG:<sha>") && kubectl apply -k k8s/
# then revert the edit — never commit a real tag
```

**Rotating secrets** — replaces `az containerapp secret set`:

```bash
kubectl create secret generic discord-scoutid-secrets \
  --from-env-file=.env.k8s --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart deploy/discord-scoutid
```

**Registering slash commands** (rarely needed; definitions change seldom):

```bash
docker run --rm --env-file .env ghcr.io/scouterna/discord-scoutid-linked-role:<sha> node src/register.js
```

### CI:s behörigheter — [k8s/rbac-github-deployer.yaml](k8s/rbac-github-deployer.yaml)

`github-deployer`-rollen ger breda verb (`get, list, watch, create`) per
resurs*typ*, men `update`/`patch` är **pinnade till namngivna objekt**. Lägger du
till en resurs i `k8s/` som CI ska kunna ändra måste dess namn in i rollen, annars
misslyckas varje deploy med `... is forbidden`.

Det syns inte förrän det smäller, eftersom `discord-scoutid-backup` aldrig råkade
ut för det: dess image är en pinnad `azure-cli`-version, så `kubectl apply`
rapporterade alltid `unchanged` och försökte aldrig patcha.
`discord-scoutid-memberscan` kör botens egen image, vars tag CI skriver om varje
gång — så patchen försöks varje deploy, och saknades namnet föll hela deployen.

**Rollen låg inte i något repo.** Den applyades för hand 2026-08-12, och dess
levande regler hade sedan driftat från sin egen `last-applied-configuration`:
`batch`-reglerna lades till med `kubectl edit`, så annoteringen beskrev
fortfarande en roll utan cronjob-åtkomst. Att applya originalfilen igen hade
tyst tagit bort möjligheten att patcha båda cronjobben. Filen i repot är den
saknade källan, och att applya den synkar även annoteringen.

Den ligger med flit **inte** i kustomizationen: deployern har inga rättigheter på
`roles`, och en deployer som kan bredda sin egen åtkomst är inte begränsad.
Applya för hand, med en kubeconfig som har RBAC-rättigheter:

```bash
kubectl apply -f k8s/rbac-github-deployer.yaml

# Namnge resursen i kontrollen. `can-i patch cronjobs` utan namn frågar om
# *vilket som helst* cronjob och svarar därför korrekt "no" även när grantet
# sitter — grantet är namn-scopat. Den frågan får en att tro att applyen inte tog.
SA=system:serviceaccount:wsj27:github-deployer
kubectl auth can-i patch cronjobs/discord-scoutid-memberscan --as=$SA -n wsj27   # yes
kubectl auth can-i --list --as=$SA -n wsj27 | grep cronjobs                      # ser resourceNames
```

### Backup and restore

**Table Storage has no soft delete and no point-in-time restore** — unlike blobs.
An export is the only backup that exists, so
[k8s/backup-cronjob.yaml](k8s/backup-cronjob.yaml) runs daily at 03:15 UTC and
writes a JSON snapshot to the `scoutid-backups` container on
**`stwsj27tfstatesec`** — a different storage account, in a different resource
group, with blob versioning and 30-day soft delete. The data account has
neither, and no `CanNotDelete` lock can be created without subscription Owner,
so a backup sitting beside the data would not survive the case worth planning
for. Blobs expire after 90 days via a lifecycle rule scoped to that container
prefix (the same account holds Terraform state — never write an unscoped rule
there).

The `state` partition is excluded: OAuth state is ephemeral with a 10-minute
expiry. Everything else is kept — the 9 `link` rows are the irreplaceable part,
since losing them means every user must re-verify, while tokens merely force a
re-auth.

Two properties worth preserving if this is ever edited: it paginates explicitly
(the service caps a page at 1000 entities and the CLI does not follow the
marker, so a single call silently truncates once enough people link), and it
refuses to upload a snapshot containing zero `link` rows.

```bash
kubectl get cronjob discord-scoutid-backup
kubectl create job manual-backup --from=cronjob/discord-scoutid-backup   # run now
kubectl logs job/manual-backup
```

**Restoring** — [k8s/backup-restore-job.yaml](k8s/backup-restore-job.yaml),
applied by hand, never part of the kustomization. It defaults to a scratch table
and refuses to touch `scoutidlinks` unless `ALLOW_PRODUCTION_RESTORE=yes`, so
running it unedited cannot overwrite production.

```bash
kubectl apply -f k8s/backup-restore-job.yaml   # edit BACKUP_BLOB / RESTORE_TABLE first
kubectl logs -f job/discord-scoutid-restore
kubectl delete job discord-scoutid-restore
```

Verified end to end on 2026-08-13: 27 entities exported, restored into a scratch
table, and compared against the live table — every entity byte-identical. Repeat
that comparison after changing either job; a backup that has never been restored
is not a backup.

### Why rollouts are safe

Three settings work together, and removing any one reintroduces dropped
requests. This was measured, not assumed — before the preStop hook a rollout
dropped 5 of 559 requests; after, 0 of 254.

- `maxUnavailable: 0` keeps a Ready pod throughout, so Discord's 3-second
  interaction ACK is always met. It does **not** stop traffic reaching a
  terminating pod — that is what the next item is for.
- A **10s `preStop` sleep**, because pod deletion and endpoint removal are
  concurrent: traefik keeps routing here briefly after termination begins.
- A **SIGTERM handler** in [src/server.js](src/server.js) that drains open
  connections *and* waits for background work. Slash commands ACK immediately
  and do the real work ~1s later, so that work outlives the HTTP response;
  without the wait a deploy kills it after the user was told it was accepted.
  This requires `CMD ["node", …]` (exec form) so node is PID 1 and receives the
  signal at all — under `npm start` it never arrives.

## Azure CLI: use the Scouterna config dir

This project lives in the Scouterna tenant, which is **not** the tenant the
default `az` login uses. Keep the two apart with a repo-local config dir
(gitignored) so that `az login` here never changes the active subscription of
the everyday session:

```bash
export AZURE_CONFIG_DIR="$PWD/.azure-scouterna"
az login --tenant 317a47ba-fd32-41b8-8ebe-310a1adc9863
az account set --subscription d4887907-2e73-4465-9fe3-44c82ed016d6
```

Every `az` command for this project needs that variable set, or it silently
targets the wrong tenant. `.claude/settings.local.json` sets it for Claude Code
sessions.

The same directory is what `Scouterna/wsj27-infra` authenticates through: the
azurerm provider and the state backend both go via the CLI, so Terraform there
needs `AZURE_CONFIG_DIR` pointing at a Scouterna-tenant config dir too.

## Architecture

- Node.js 20 + Express 5 + Azure Table Storage (ESM modules)
- Runs on Kubernetes: namespace `wsj27` on Scouterna's shared AKS cluster
  `webservices`, behind traefik with a cert-manager certificate. Manifests in
  `k8s/`, images in GHCR. Storage stayed in Azure — Table Storage is durable,
  costs öre, and keeping it meant no data migration and a free rollback
- **No Terraform lives in this repository.** What is left in Azure — the storage
  account holding the links, and the DNS record — is managed from the `azure/`
  root module in `Scouterna/wsj27-infra`, alongside the Discord server config.
  Infrastructure shared between projects should not live inside one of them.
  Nothing applies it automatically: CI there validates but does not plan or
  apply, so applying is a deliberate manual act
- Docker build pulls from registry.npmjs.org unless a gitignored `.npmrc` overrides it (installed in a separate build stage, so it never lands in the image). On a network that TLS-intercepts npmjs, `npm ci` half-installs while still exiting 0 — so a local `.npmrc` pointing at a reachable mirror is required there. The Dockerfile verifies every dependency landed and fails the build otherwise
- Local dev uses the Azurite storage emulator (see `docker-compose.yml`). The
  Table Storage SDK refuses a plain-http endpoint unless
  `allowInsecureConnection` is passed, so `storage.js` sets it — but only when
  the connection string itself says http, which the real account never does.
  Without that, every local run died on "Cannot connect to
  http://azurite:10002/... while allowInsecureConnection is false"

## Key design decisions

- Fee-to-role mapping is fully configurable via env vars, not hardcoded
- **Platta kategorimarkörer (`SCOUTNET_CATEGORY_ROLES`) delas ut utöver
  divisionsrollen** — en ledare i avdelning 12 får både `Ledare-12` och `Ledare`.
  De finns för AutoMod i wsj27-infra, som bara kan *undanta* roller och max 20 av
  dem: "alla utom deltagare" hade krävt 158 per-avdelning roller, men blir sex med
  markörerna. `deltagare` har med flit ingen markör — frånvaron *är* det som gör
  att länkfiltret träffar dem. Ändras utdelningen måste ordningen hållas: bot
  först, `/refresh-scoutid alla:true`, sedan `terraform apply` i infra-repot.
  Omvänd ordning länkblockerar alla ledare och IST i mellantiden
- Each fee category can have its own ScoutNet question ID for division assignment
- Division numbers are zero-padded to minimum 2 digits
- The bot cannot modify users above it in Discord's role hierarchy (403 is expected for admins)
- `register.js` only needs Discord API, but imports storage.js which connects to Table Storage — storage errors during registration are harmless
- Interaction responses use a 1-second delay before processing to avoid race conditions with Discord's deferred response handling
- **Scout-rollen är säkerhetsgränsen.** Saknar en länkad användare Scout-rollen i Discord (managed Linked Role) så strippas alla bot-hanterade roller och `Overifierad` sätts vid nästa `syncUserRoles`. Storage-länken behålls så användaren kan re-verifiera utan att admin behöver fråga efter scoutid igen.
- OAuth-tokens (`discord-token`, `scoutid-token`) och länkar (`link`) lagras durabelt i Azure Table Storage (ingen TTL). OAuth-state (`state`) har ett `expiresAt`-fält (lazy expiry, 10 min) eftersom Table Storage saknar native TTL. Refresh-tokens från Discord är giltiga i månader, och persistent lagring låter `/link-scoutid` re-pusha Linked Role-metadata i bakgrunden.
- ScoutNet-deltagarlistan cachas i processminnet (10 min), inte i Table Storage — hela listan överskrider gränsen på 64 KB per property. Cache-miss efter omstart kostar bara en extra ScoutNet-hämtning.
- **Varför inte Redis:** Azure Redis Basic-tier saknar persistens och tappar ALL data vid varje nod-omstart/underhåll. 2026-05-26 wipeades alla länkar+tokens av en sådan omstart. Table Storage (LRS) är durabelt och billigare för detta access-mönster (bara läs/skriv vid länkning + audit).

## ScoutNet API

- Participants endpoint: `https://scoutnet.se/api/project/get/participants?id={EVENT_ID}&key={API_KEY}`
- Response has `participants` object keyed by member_no
- Each participant has: `fee_id`, `cancelled_date`, `questions` (object of questionId → answer)
- Participant data is cached in process memory for 10 minutes (see `src/storage.js`)

## Discord Developer Portal

- **General Information** → Linked Roles Verification URL: `https://discord-scoutid.wsj27.scouterna.net/linked-role`
- **General Information** → Interactions Endpoint URL: `https://discord-scoutid.wsj27.scouterna.net/interactions`
- **OAuth2** → Redirect: `https://discord-scoutid.wsj27.scouterna.net/discord-oauth-callback`

## Config format reference

Aktuell prod-config — [k8s/configmap.yaml](k8s/configmap.yaml) är enda källan.
Roll-konfigurationen låg tidigare i `terraform.tfvars`, men de variablerna togs
bort när Container App avvecklades: Terraform hanterar inte längre något som
boten läser.

```
# Kanal för händelseloggen (#server-logg). Tomt = loggning av.
LOG_CHANNEL_ID=
# Vad medlemsscannern rapporterar. join,leave,nickname,roles — "off" = av.
# roles kräver View Audit Log på botens roll och rapporterar bara andras ändringar.
LOG_MEMBER_EVENTS=join,leave,nickname

# Marker-roller (alla länkade / alla event-anmälda)
SCOUTNET_SCOUT_ROLE=scout
SCOUTNET_EVENT_ROLE=wsj-event

# fee_id:category
SCOUTNET_FEE_ROLES=25694:deltagare,27561:deltagare,25696:ist,25702:ist,33293:ledare,34850:ledare,27560:ledare,25695:ledare,25697:cmt,25693:cmt,46628:cmt,46628:cmt

# category:questionId:roleWithDiv:roleWithoutDiv
SCOUTNET_DIVISION_ROLES=deltagare:88168:Deltagare-{div}:Deltagare-Väntande,ist:88168:IST-Patrull-{div}:IST-Väntande,ledare:107592:Ledare-{div}:Ledare-Väntande

# category:roleName — platt markör *utöver* divisionsrollen (Ledare-12 + Ledare)
SCOUTNET_CATEGORY_ROLES=ledare:Ledare,ist:IST

# category:suffixWithDiv:suffixWithoutDiv (empty = no suffix)
SCOUTNET_NICKNAME_SUFFIXES=deltagare:{div}:,ledare:AL{div}:AL,ist:IST-{div}:IST,cmt::CMT
```

## Händelselogg till Discord

[src/eventlog.js](src/eventlog.js) skriver vad boten *gjorde*, när det hände,
till `#server-logg` — en moderator-only kanal som ägs av
[wsj27-infra](https://github.com/Scouterna/wsj27-infra) (`discord/main.tf`).
`LOG_CHANNEL_ID` styr den; tomt värde betyder att loggen är av och allt annat
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
inte vill vänta på schemat. `torrkor:true` visar vad den skulle rapportera utan
att posta eller flytta snapshoten — raderna kommer tillbaka i svaret i stället.

**Dry-run samlar rader i en sink, inte via en global flagga.** Formatterarna
returnerar strängar (`formatMemberJoined` osv.) i stället för att logga själva.
Tidigare loggade de internt, så `torrkor:true` köade raderna och flush-timern
postade dem några sekunder senare — en dry-run som inte var torr. En
processglobal dry-run-flagga hade varit fel lösning: servern hanterar
förfrågningar samtidigt, så den hade tystat en länkning som råkade logga just då. En manuell körning kan överlappa CronJobbet;
värsta fallet är att samma ändring rapporteras två gånger, vilket är den
avvägning hela loggen gör med flit.

```bash
node src/memberscan.js --dry-run      # skriv ut vad den skulle rapportera
kubectl get cronjob discord-scoutid-memberscan
kubectl create job manual-scan --from=cronjob/discord-scoutid-memberscan
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

Boten kan skriva i kanalen enbart tack vare en channel overwrite i infra-repot:
dess roll har `402653184`, alltså Manage Roles + Manage Nicknames och varken
View Channels eller Send Messages. **En 403 här betyder att overwriten saknas,
inte att token är fel.**

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

`yq` finns för k8s-manifesten och kustomize-utdata. `python3-yaml` finns som
fallback — imagen har inget `pip`, så apt är enda vägen till en YAML-parser.

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
| `unit/roles` | `getDesiredRoles` och `getNicknameSuffix` — fee → kategori → divisionsroll, zero-padding, plattmarkörer, avbokade |
| `unit/discord` | Paginering förbi 1000-gränsen, 429-retry, att fel bär sin HTTP-status, att mentions alltid tystas |
| `unit/eventlog` | De tre reglerna: kastar aldrig, fördröjer aldrig, tappar aldrig buffern. Plus batchning under 2000 tecken |
| `unit/memberscan` | Sammanfattningen och audit-pagineringen bakåt |
| `unit/server` | Interactions-endpointen över en riktig socket med ett riktigt ed25519-nyckelpar: förfalskade signaturer avvisas, PING besvaras, varje kommando ACK:as inom Discords 3-sekundersfönster, och admin-grinden hålls |
| `integration/roles` | `syncUserRoles` — verifieringsgrinden, prefixborttagning av gamla divisionsroller, 403 i hierarkin, 32-teckensgränsen |
| `integration/audit` | Alla 13 kategorierna, och att auditen aldrig skriver |
| `integration/memberscan` | Hela flödet i sekvens: vad som sparas när, och vad som inte får sparas |

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
`azurite:10002` (compose-nätverket, inifrån devcontainern) och `127.0.0.1:10002`
(publicerad port, från värden) och avslutar med instruktioner om ingen svarar.
`AZURITE_TABLE_HOST` går före. Att byta ut `globalThis.fetch` stör inte lagringen:
Table Storage-SDK:n går via nodes `http`-modul, inte via global fetch.

## Audit och konsistenskontroll

Audit-logiken ligger i [src/audit.js](src/audit.js) och körs antingen via slash-kommando eller schemalagt.

### Kategorier som kontrolleras

1. **Scout-roll utan storage-länk** — användare med Scout-rollen men ingen ScoutID-länkning i Table Storage
2. **Länkade utan Scout-rollen** — Discord Linked Role har fallit bort (frånkopplad app, lämnad/återansluten server). Användaren måste re-verifiera via `/linked-role` själv eftersom Scout är en managed roll
3. **Länkade utan sparade Discord-tokens** — länken räcker för roller och smeknamn men inte för att prata med Discord i användarens namn, så `updateMetadata` kan inte pusha Linked Role-metadata. Felet är tyst: allt fungerar till Scout-rollen faller bort, och då kan varken admin eller bot laga det — personen måste själv köra om `/linked-role`. **`/link-scoutid` lagar inte det här**, den skapar bara länken. Exakt vad Redis-wipen 2026-05-26 lämnade efter sig, eftersom länkar och tokens försvann tillsammans
4. **Storage-länk utan guild-medlem** — gamla länkningar för användare som lämnat servern
5. **Avbokade i ScoutNet** — länkade användare med `cancelled_date` satt
6. **Namnskillnader** — Discord-smeknamn matchar inte ScoutNet-namn
7. **Saknade statiska roller** — roller boten skulle tilldela som inte finns i guilden
8. **Saknade division-roller** — `Deltagare-{nr}` etc. som ScoutNet refererar till men som inte finns
9. **Okända fee_id** — `fee_id` i ScoutNet utan mappning i `SCOUTNET_FEE_ROLES`
10. **Bot-hierarki/permissions** — roller över botens position, eller saknade `MANAGE_ROLES`/`MANAGE_NICKNAMES`
11. **Roll-drift** — per användare: vilka roller saknas / vilka borde inte finnas (dry-run sync)
12. **Multipla division-roller** — användare som har t.ex. `Deltagare-05` och `Deltagare-07` samtidigt
13. **Fel nickname-suffix** — användare där `(X)` i nicket inte matchar förväntat värde

Auditen är helt läsande — inga `addRole`/`removeRole`/nickname-anrop — så den går att köra lokalt mot prod-credentials när slash-kommandot inte räcker.

### Kommandon

- `/audit-scoutid` — full rapport (admin). Filattachment om >2000 tecken.
- `/scan-scoutid` — kör medlemsscannern nu (admin). `torrkor:true` = visa utan att posta.
- `/status-scoutid` — utan argument: server-sammanfattning. Med `person`: detaljerad status för en användare.

## Krav på Discord-servern

Discord-rollerna ägs av [Scouterna/wsj27-infra](https://github.com/Scouterna/wsj27-infra) (`discord/`) (Terraform). Boten letar upp roller efter namn (case-insensitive) — om en roll inte finns hoppas tilldelningen tyst över. Roller som måste finnas:

| Bot tilldelar | Källa i infra-repot |
|---|---|
| `scout` | Extern `Scout`-roll (ScoutID-bot, ej Terraform) |
| `wsj-event` | `discord_role.wsj_event` |
| `Deltagare-{nr}` / `Deltagare-Väntande` | `discord_role.participant[*]` / `discord_role.participant_pending` |
| `Ledare-{nr}` / `Ledare-Väntande` | `discord_role.leader[*]` / `discord_role.leader_pending` |
| `IST-Patrull-{nr}` / `IST-Väntande` | `discord_role.ist_patrol[*]` / `discord_role.ist_pending` |
| `CMT` | `discord_role.cmt` |
| `Ledare` / `IST` (platta markörer) | `discord_role.leader_flat` / `discord_role.ist_flat` |

Antal avdelningar (`var.troops`) och IST-patruller (`var.ist_patrols`) i
infra-repot måste täcka alla värden ScoutNet kan returnera för
division-frågorna 88168 (deltagare/IST) och 107592 (ledare).

**IST är delat på två resegrupper som båda har patruller** — rundresa och egen
resa — men patrullerna delar en numrering, så patrull 07 hör till exakt en av
grupperna. Därför ser boten ingen skillnad på dem: både `fee_id` 25696 och
25702 mappas till kategorin `ist` och ger `IST-Patrull-{div}` från fråga 88168.
Resegruppen finns bara i infra-repot, som avgör vilken kategori patrullens
kanal ligger i och vilka gruppkanaler den når.
