# Discord ScoutID Linked Role

A Discord bot that links Discord accounts to [ScoutID](https://scoutid.se) and
assigns roles and nicknames from [ScoutNet](https://scoutnet.se) event
registrations.

Built for the Swedish contingent to World Scout Jamboree 2027, but the
fee-to-role mapping is entirely config-driven — nothing about the event is
hardcoded.

## How it works

1. **Link** — a user clicks a Discord [Linked Role](https://discord.com/developers/docs/tutorials/configuring-app-metadata-for-linked-roles)
   button and authenticates with ScoutID (OIDC + PKCE). The bot stores the
   Discord ↔ ScoutNet member mapping.
2. **Look up** — the bot fetches the ScoutNet participant record for that member
   number: fee category, cancellation status, and answers to configured
   questions (e.g. which troop they belong to).
3. **Sync** — it assigns the matching Discord roles and rewrites the nickname to
   the user's real name plus a category suffix, e.g. `Ida Sandholdt (12)`.

Roles are re-synced by `/refresh-scoutid`, so a user who gets a troop assigned in
ScoutNet later can move themselves off the waiting role without admin help.

### Security boundary

The `Scout` role — a Discord *managed* role granted by the Linked Role
verification — is the boundary. If a linked user loses it (they disconnected the
app, or left and rejoined the server), the next sync strips every bot-managed
role and applies `Overifierad`. The stored link is kept, so the user can
re-verify without an admin re-entering their member number.

## Roles

Three kinds of role are assigned, all named in config and looked up by name
(case-insensitive). A role that doesn't exist in the guild is silently skipped.

| Role                    | When                                            | Config                       |
| ----------------------- | ----------------------------------------------- | ---------------------------- |
| `scout`                 | ScoutID linked                                  | `SCOUTNET_SCOUT_ROLE`        |
| `WSJ-event`             | Registered (and not cancelled) in the event     | `SCOUTNET_EVENT_ROLE`        |
| Fee/division role       | From the participant's `fee_id`, see below      | `SCOUTNET_FEE_ROLES` + `SCOUTNET_DIVISION_ROLES` |

Each `fee_id` maps to a *category*. A category with a division config gets a
per-division role from a ScoutNet question, falling back to a waiting role when
the question is unanswered; a category without one gets a role named after the
category itself. Division numbers are zero-padded to at least 2 digits
(`3` → `03`, `100` → `100`).

The current production mapping ([terraform/terraform.tfvars](terraform/terraform.tfvars)):

| Fee ID                     | Category         | Division question | With division       | Without division     | Nickname suffix |
| -------------------------- | ---------------- | ----------------- | ------------------- | -------------------- | --------------- |
| 25694, 27561               | `deltagare`      | 88168             | `Deltagare-{div}`   | `Deltagare-Väntande` | `(12)`          |
| 25696                      | `ist`            | 88168             | `IST-Patrull-{div}` | `IST-Väntande`       | `(IST-05)`      |
| 33293, 34850, 27560, 25695 | `ledare`         | 107592            | `Ledare-{div}`      | `Ledare-Väntande`    | `(AL12)`        |
| 25702                      | `ist-direktresa` | —                 | `IST-Direktresa`    | —                    | `(IST)`         |
| 25697, 25693               | `cmt`            | —                 | `CMT`               | —                    | `(CMT)`         |

The roles themselves are owned by a separate Terraform repo,
[discord-wsj27-infra](https://github.com/wsj27se/discord-wsj27-infra). Its troop
and IST-patrol counts must cover every value ScoutNet can return for the
division questions.

**Note:** Discord forbids a bot from modifying members ranked above it, so
syncing a server admin returns 403. That is expected, and `/audit-scoutid`
reports it.

## Slash commands

| Command                             | Who      | What                                                     |
| ----------------------------------- | -------- | -------------------------------------------------------- |
| `/refresh-scoutid`                  | Everyone | Re-sync your own roles and nickname                       |
| `/refresh-scoutid person:@user`     | Admin    | Re-sync one user                                          |
| `/refresh-scoutid alla:true`        | Admin    | Re-sync every linked user                                 |
| `/status-scoutid`                   | Admin    | Server summary: members, links, participants, open issues |
| `/status-scoutid person:@user`      | Admin    | Everything the bot knows about one user                   |
| `/audit-scoutid`                    | Admin    | Full consistency report across Discord, storage, ScoutNet |
| `/link-scoutid person:@user scoutid:12345` | Admin | Link a user manually, bypassing ScoutID                |

`/audit-scoutid` checks for missing roles, orphaned links, cancelled
registrations, nickname drift, unmapped `fee_id`s, duplicate division roles, and
bot permission or hierarchy problems. The report is attached as a file when it
exceeds Discord's 2000-character limit.

## Configuration

All configuration is environment variables — see [.env.example](.env.example)
for the full list with formats. The role mapping variables use compact
delimited strings:

```bash
# fee_id:category
SCOUTNET_FEE_ROLES=25694:deltagare,25696:ist,25697:cmt

# category:questionId:roleWithDiv:roleWithoutDiv
SCOUTNET_DIVISION_ROLES=deltagare:88168:Deltagare-{div}:Deltagare-Väntande

# category:suffixWithDiv:suffixWithoutDiv (empty = no suffix)
SCOUTNET_NICKNAME_SUFFIXES=deltagare:{div}:,cmt::CMT
```

## Running locally

```bash
cp .env.example .env    # fill in your Discord + ScoutID credentials
docker compose up -d    # app + Azurite (Table Storage emulator) + ngrok
```

Discord must reach the bot over HTTPS, so the compose file includes ngrok. Set
`NGROK_AUTHTOKEN` and `NGROK_URL`, then point the Discord Developer Portal URLs
at your tunnel (http://localhost:4040 shows it).

Register the linked-role metadata and slash commands once per app:

```bash
docker compose run --rm discord-scoutid-linked-role node src/register.js
```

## Deploying

Infrastructure lives in [terraform/](terraform/) — Azure Container Apps, Table
Storage, Container Registry, DNS. See [terraform/README.md](terraform/README.md).

Pushing to `main` builds, pushes and applies automatically — see
[.github/workflows/deploy.yml](.github/workflows/deploy.yml). Terraform owns the
image tag, so the deployed revision and the state stay in agreement.

The commands below are the break-glass path. **Always tag images with the git
SHA**: Azure Container Apps only creates a new revision when the image *string*
changes, so pushing over `:latest` silently keeps the old container running.
Deploying this way also leaves Terraform unaware of the change — update
`docker_image_tag` in [terraform/terraform.tfvars](terraform/terraform.tfvars) to
match, or the next apply rolls production back.

Dependencies install from registry.npmjs.org. To build behind an npm proxy, drop
a `.npmrc` in the repo root — it is gitignored, and the Dockerfile installs with
it in a separate stage so it never becomes a layer in the image.

```bash
TAG=$(git rev-parse --short HEAD)
ACR=acrwsj27prodsec.azurecr.io/discord-scoutid-linked-role

docker build -t $ACR:$TAG . && docker push $ACR:$TAG

az containerapp update \
  --name app-discord-scoutid-prod-sec \
  --resource-group rg-discord-scoutid-prod-sec \
  --image $ACR:$TAG

az containerapp logs show \
  --name app-discord-scoutid-prod-sec \
  --resource-group rg-discord-scoutid-prod-sec --follow
```

## Discord Developer Portal setup

The app needs the `bot` scope and **Manage Roles** + **Manage Nicknames**
permissions, and its role must sit above every role it assigns. Three URLs point
back at the deployment (`terraform output` prints them):

| Portal setting                                       | Path                       |
| ---------------------------------------------------- | -------------------------- |
| General Information → Linked Roles Verification URL   | `/linked-role`             |
| General Information → Interactions Endpoint URL       | `/interactions`            |
| OAuth2 → Redirects                                    | `/discord-oauth-callback`  |

ScoutID's client registration needs `/scoutid-oauth-callback` as its redirect.

## Project layout

```
src/
├── server.js      Express app: OAuth callbacks + Discord interactions endpoint
├── config.js      Environment parsing (fee/division/suffix mini-formats)
├── discord.js     Discord API: OAuth, roles, nicknames, command registration
├── scoutid.js     ScoutID OIDC (PKCE)
├── scoutnet.js    ScoutNet participants API
├── roles.js       Role/nickname determination and sync
├── audit.js       Consistency checks behind /audit-scoutid and /status-scoutid
├── storage.js     Azure Table Storage (links, tokens, OAuth state)
├── register.js    One-time metadata + slash command registration
└── templates/     Success page served after linking
```

Links and OAuth tokens are stored durably in Table Storage. OAuth state expires
after 10 minutes via an `expiresAt` field (Table Storage has no native TTL); the
ScoutNet participant list is cached in process memory for 10 minutes because it
exceeds Table Storage's 64 KB property limit.

## Troubleshooting

- **403 when assigning roles** — the target member or the role outranks the bot.
  Check role ordering in Server Settings → Roles.
- **"Applikationen svarade inte"** — Discord requires an ACK within 3 seconds.
  Verify the Interactions Endpoint URL, and keep `min_replicas = 1` so no
  interaction hits a cold start.
- **Storage errors from `register.js`** — harmless. It only calls the Discord
  API but imports `config`/`storage` transitively.
- **`npm error Exit handler never called!` during `docker build`** — npm could
  not reach the registry (commonly a TLS-intercepting proxy) and exits 0 anyway
  with a partial `node_modules`. The Dockerfile's post-install check turns that
  into a real build failure; point a local `.npmrc` at a reachable registry.

## License

MIT — see [LICENSE](LICENSE).
