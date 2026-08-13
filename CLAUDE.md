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
- Local dev uses the Azurite storage emulator (see `docker-compose.yml`)

## Key design decisions

- Fee-to-role mapping is fully configurable via env vars, not hardcoded
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
# Marker-roller (alla länkade / alla event-anmälda)
SCOUTNET_SCOUT_ROLE=scout
SCOUTNET_EVENT_ROLE=wsj-event

# fee_id:category
SCOUTNET_FEE_ROLES=25694:deltagare,27561:deltagare,25696:ist,25702:ist-direktresa,33293:ledare,34850:ledare,27560:ledare,25695:ledare,25697:cmt,25693:cmt

# category:questionId:roleWithDiv:roleWithoutDiv
SCOUTNET_DIVISION_ROLES=deltagare:88168:Deltagare-{div}:Deltagare-Väntande,ist:88168:IST-Patrull-{div}:IST-Väntande,ledare:107592:Ledare-{div}:Ledare-Väntande

# category:suffixWithDiv:suffixWithoutDiv (empty = no suffix)
SCOUTNET_NICKNAME_SUFFIXES=deltagare:{div}:,ledare:AL{div}:AL,ist:IST-{div}:IST,ist-direktresa::IST,cmt::CMT
```

## Audit och konsistenskontroll

Audit-logiken ligger i [src/audit.js](src/audit.js) och körs antingen via slash-kommando eller schemalagt.

### Kategorier som kontrolleras

1. **Scout-roll utan storage-länk** — användare med Scout-rollen men ingen ScoutID-länkning i Table Storage
2. **Länkade utan Scout-rollen** — Discord Linked Role har fallit bort (frånkopplad app, lämnad/återansluten server). Användaren måste re-verifiera via `/linked-role` själv eftersom Scout är en managed roll
3. **Storage-länk utan guild-medlem** — gamla länkningar för användare som lämnat servern
4. **Avbokade i ScoutNet** — länkade användare med `cancelled_date` satt
5. **Namnskillnader** — Discord-smeknamn matchar inte ScoutNet-namn
6. **Saknade statiska roller** — roller boten skulle tilldela som inte finns i guilden
7. **Saknade division-roller** — `Deltagare-{nr}` etc. som ScoutNet refererar till men som inte finns
8. **Okända fee_id** — `fee_id` i ScoutNet utan mappning i `SCOUTNET_FEE_ROLES`
9. **Bot-hierarki/permissions** — roller över botens position, eller saknade `MANAGE_ROLES`/`MANAGE_NICKNAMES`
10. **Roll-drift** — per användare: vilka roller saknas / vilka borde inte finnas (dry-run sync)
11. **Multipla division-roller** — användare som har t.ex. `Deltagare-05` och `Deltagare-07` samtidigt
12. **Fel nickname-suffix** — användare där `(X)` i nicket inte matchar förväntat värde

### Kommandon

- `/audit-scoutid` — full rapport (admin). Filattachment om >2000 tecken.
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
| `IST-Direktresa` | `discord_role.ist_direct_travel` |
| `CMT` | `discord_role.cmt` |

Antal avdelningar (`var.troops`) och IST-patruller (`var.ist_patrols`) i infra-repot måste täcka alla värden ScoutNet kan returnera för division-frågorna 88168 (deltagare/IST) och 107592 (ledare).
