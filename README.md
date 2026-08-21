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
ScoutNet later can move themselves off the waiting role without admin help — and
a nightly CronJob runs the same sync across the whole server, so nobody has to
remember to. Before it existed, a participant who got a troop assigned sat on the
waiting role until an admin happened to run the command.

### Security boundary

The boundary takes **two independent proofs, either of which is enough**:

1. The `Scout` role — a Discord *managed* role, granted through Discord's own
   Link flow and revoked when the user disconnects the app. The bot can never
   grant it, which is what makes it trustworthy.
2. A live OAuth grant — if Discord still answers for the user's stored token, the
   app is still authorised. The same fact, seen from the other side.

The second exists because the first cannot be backfilled: Discord grants a
connection-gated role only when the user clicks Link, so a rebuilt role cannot be
restored to existing members by any API. Either proof missing is fine; both
missing means the next sync strips every bot-managed role and applies
`Overifierad`. The stored link is kept, so the user can re-verify without an admin
re-entering their member number. If a linked user loses it (they disconnected the
app, or left and rejoined the server), the next sync strips every bot-managed
role and applies `Overifierad`. The stored link is kept, so the user can
re-verify without an admin re-entering their member number.

## Roles

Four kinds of role are assigned, all named in config and looked up by name
(case-insensitive). A role that doesn't exist in the guild is silently skipped.

| Role                    | When                                            | Config                       |
| ----------------------- | ----------------------------------------------- | ---------------------------- |
| `scout`                 | ScoutID linked                                  | `SCOUTNET_SCOUT_ROLE`        |
| `WSJ-event`             | Registered (and not cancelled) in the event     | `SCOUTNET_EVENT_ROLE`        |
| Fee/division role       | From the participant's `fee_id`, see below      | `SCOUTNET_FEE_ROLES` + `SCOUTNET_DIVISION_ROLES` |
| Flat category role      | Alongside the division role, for whole-category targeting | `SCOUTNET_CATEGORY_ROLES` |

Each `fee_id` maps to a *category*. A category with a division config gets a
per-division role from a ScoutNet question, falling back to a waiting role when
the question is unanswered; a category without one gets a role named after the
category itself. Division numbers are zero-padded to at least 2 digits
(`3` → `03`, `100` → `100`).

The current production mapping (now [k8s/configmap.yaml](k8s/configmap.yaml)):

| Fee ID                     | Category         | Division question | With division       | Without division     | Flat role | Nickname suffix |
| -------------------------- | ---------------- | ----------------- | ------------------- | -------------------- | --------- | --------------- |
| 25694, 27561               | `deltagare`      | 88168             | `Deltagare-{div}`   | `Deltagare-Väntande` | —         | `(12)`          |
| 25696, 25702               | `ist`            | 88168             | `IST-Patrull-{div}` | `IST-Väntande`       | `IST`     | `(IST-05)`      |
| 33293, 34850, 27560, 25695 | `ledare`         | 107592            | `Ledare-{div}`      | `Ledare-Väntande`    | `Ledare`  | `(AL12)`        |
| 25697, 25693, 46628        | `cmt`            | —                 | `CMT`               | —                    | —         | `(CMT)`         |

The flat role column is `SCOUTNET_CATEGORY_ROLES`, granted *in addition to* the
division role: a leader in troop 12 carries both `Ledare-12` and `Ledare`. It
exists because Discord's AutoMod can only *exempt* roles, never target them, and
caps the exempt list at 20 — far below the 151 per-division roles that "everyone
except participants" would otherwise need. `deltagare` has no entry on purpose:
the missing marker is exactly what makes wsj27-infra's link filter apply to
participants and nobody else. `cmt` needs none either, since a category without a
division config already yields a flat role named after itself.

The flat roles are managed like every other assigned role, so an ex-leader loses
`Ledare` — and with it the exemption — on the next sync.

IST is split across two travel groups — the contingent tour and travelling on
your own — and both have patrols. They share one patrol numbering, so patrol 07
belongs to exactly one group and the role name carries no group. That is why
both fee ids map to the same `ist` category: the bot cannot tell the groups
apart and does not need to. The travel group decides only which category a
patrol's channel sits in, which is Terraform's business, not the bot's.

The roles themselves are owned by a separate Terraform repo,
[Scouterna/wsj27-infra](https://github.com/Scouterna/wsj27-infra) (`discord/`). Its troop
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
| `/status-scoutid person:@user`      | Admin    | Everything the bot knows about one user                   |
| `/adoption-scoutid`                 | Admin    | How many registered participants have linked, per group    |
| `/audit-scoutid`                    | Admin    | Full consistency report across Discord, storage, ScoutNet |
| `/link-scoutid person:@user scoutid:12345` | Admin | Link a user manually, bypassing ScoutID                |
| `/scan-scoutid`                     | Admin    | Run the member scan now; `dryrun:true` for a dry run      |
| `/refresh-scoutid dryrun:true`      | —        | Show what would change without changing it                |

`/audit-scoutid` checks for missing roles, orphaned links, links with no stored
OAuth tokens, cancelled registrations, nickname drift, unmapped `fee_id`s,
duplicate division roles, and bot permission or hierarchy problems. The report is
attached as a file when it exceeds Discord's 2000-character limit.

The token check is the least obvious one. A link is enough to assign roles and
set a nickname, but pushing Linked Role metadata needs the user's own Discord
token — so a link without one works right up until Discord drops the `Scout`
role, at which point neither an admin nor `/link-scoutid` can repair it and the
person has to re-link the role themselves — and note that opening the
verification URL is not enough: `Scout` is connection-gated, so only clicking
**Link** on the role inside Discord grants it.

## Event log

With `LOG_CHANNEL_ID` set, the bot writes what it did — and when — to
`#server-logg`, a moderator-only channel owned by
[wsj27-infra](https://github.com/Scouterna/wsj27-infra). Unset means the log is
off and everything else is unchanged.

```
09:14 ✅ Anna Andersson (@anna) länkade ScoutID `12345` → WSJ-event, Ledare-12, Ledare
09:20 🔗 @moderator länkade @erik till scoutid `777` (ersatte `666`) — + Deltagare-05
09:31 🔒 @kim saknar Scout-rollen — roller strippade, Overifierad satt
      (måste länka om Scout-rollen i Discord: Kanaler och roller → Scout → Länka)
10:02 🔁 @moderator körde /refresh-scoutid alla:true — 143 användare, 7 ändrade, 0 fel
```

Until now this existed only in `kubectl logs`, which means it existed for as
long as the pod did: every deploy discarded the record of who linked, what they
got, and who lost the `Scout` role. `/audit-scoutid` answers the *state*
question. Nothing answered the history one, because nothing kept history.

### Member events

Joins and leaves land in the same channel, from `src/memberscan.js` — a CronJob
that fetches the member list every 10 minutes and diffs it against the previous
run, with the snapshot in Table Storage.

A poll rather than live events, because this bot speaks HTTP interactions and has
no gateway connection to receive `guildMemberAdd` on. The trade is a reporting
delay of up to one interval. What it avoids is a second bot, a privileged gateway
intent, and the failure mode where a process that was down for an hour has lost
that hour permanently. This one just reports the change on its next run.

Kicks and bans are told apart from a voluntary leave using the audit log, so a
departure reads `kickad av @X — anledning: …` rather than just "gone". With no
audit entry the departure is genuinely unknown, which covers both a voluntary
leave and an unreadable audit log, so the line says `är inte längre medlem` and
asserts nothing. A ban outranks a kick for the same person.

It is a CronJob and not a timer in the server because the Deployment runs
`replicas: 2` — an interval inside it would report every join twice.

`LOG_MEMBER_EVENTS` picks what it reports: any of `join`, `leave`, `nickname`,
`roles`; `off` or empty disables the scan entirely.

`roles` reports only changes made by **someone other than the bot**, read from
the Discord audit log — the one source that knows who did it. The bot already
logs its own role changes as it makes them, so this adds exactly what is
otherwise invisible: a moderator editing roles in the Discord UI, named.

It needs **View Audit Log** on the bot's role (+128 → `402653312`), set by hand
in Server Settings → Roles since the role is a managed integration role Terraform
does not own. Without the bit the scan warns and skips role changes; nothing else
is affected. That is why it is off by default.

```bash
node src/memberscan.js --dry-run   # print what it would report, save nothing
```

`/scan-scoutid` runs the same code from Discord for anyone who does not want to
wait for the schedule. `dryrun:true` returns the lines in the reply instead of
posting them, and leaves the snapshot where it is.

The snapshot is saved only after the report is written. A failed write leaves it
untouched so the next run reports the same diff — in an audit trail a duplicate
on retry is cheaper than a hole. The first run ever seeds a baseline silently
rather than announcing every existing member as a new arrival.

Writes are buffered for a few seconds and packed into as few messages as
Discord's 2000-character limit allows, so a 143-user resync cannot outrun the
channel's five-messages-per-five-seconds rate limit. A failed write is logged
and dropped; it never surfaces to the user whose link just succeeded.

## Tests

```bash
npm test                  # pure logic — no container, no network, no credentials
docker compose up -d azurite
npm run test:integration  # the real scan against real Table Storage
npm run test:all

npm run lint              # eslint
npm run format            # prettier --write .
npm run format:check      # what CI runs
```

Lint and formatting run in CI before the tests, so they gate the deploy too.
Prettier does not touch markdown — see `.prettierignore` for why.

The split is deliberate: a suite that cannot run without setup is a suite that
stops being run, so the majority of the value sits in `npm test`. The integration
suite needs the emulator because the Discord-to-ScoutID link lives in Table
Storage and half the logic branches on whether one exists.

What is covered:

- **`unit/config`** — the env-var parsers. They turn hand-typed ConfigMap strings
  into role assignments, so the tests pin down malformed input too.
- **`unit/roles`** — `getDesiredRoles` and `getNicknameSuffix`: fee to category to
  division role, zero-padding, flat markers, cancelled registrations.
- **`unit/discord`** — pagination past the 1000-member page limit, 429 retries,
  errors carrying their HTTP status, mentions always suppressed.
- **`unit/eventlog`** — never throws, never delays, never loses the buffer, and
  splits below Discord's 2000-character limit.
- **`unit/server`** — the interactions endpoint, driven over a real socket with a
  real ed25519 keypair: forged signatures rejected, PING answered, every command
  acknowledged within Discord's 3-second window, and the admin gate enforced.
  Plus the two health routes, which exist to answer differently: liveness must
  say 200 with no storage in reach, readiness must say 503.
- **`integration/roles`** — `syncUserRoles`: the verification gate, prefix-based
  removal of stale division roles, a 403 from the role hierarchy, the 32-character
  nickname limit, and that a ScoutNet outage changes nothing at all.
- **`integration/metadata`** — that the Linked Role push carries `verified: true`,
  that a dead ScoutID token costs the user only the display fields and never that
  flag, and that "no stored token" is reported apart from "failed" — they need
  different remedies and only one of them has one.
- **`integration/syncall`** — `syncAllUserRoles`: that guild state is fetched
  *once* per run rather than once per user, that an unchanged server writes
  nothing, and that a dry run writes nothing at all. Cost properties rather than
  correctness ones, because they are what decide whether it can run on a
  schedule.
- **`integration/health`** — `/readyz` against a real table, which is the only
  way to test the answer that matters: 200 when storage genuinely works.
- **`integration/audit`** — all 13 categories, and that the audit never writes.
- **`integration/memberscan`** — the whole flow in sequence.

Two of those are worth understanding before changing them. **A clean guild must
report zero issues**, which surfaces a false positive in any of the 13 audit
categories at once — a noisy audit is one nobody reads. And **the audit must not
write**: the stub refuses every non-GET and the test asserts none happened, which
is what makes it safe to run against production credentials.

Each integration case exists because it caught something real, and they are
labelled with what. Between them they found silent UTF-8 corruption in the
snapshot chunking, `process.exit` used as control flow mid-function, a field-name
mismatch that rendered `<@undefined>`, a zero reported for a switched-off
category, a dry run that still wrote to the channel, and the first kick in a guild
being swallowed by cursor seeding.

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

The bot runs on Kubernetes — namespace `wsj27` on Scouterna's shared AKS
cluster — with manifests in [k8s/](k8s/) and images in GHCR. What remains in
Azure is the Table Storage account holding the links, and the DNS record; see
the `azure/` module in `Scouterna/wsj27-infra`.

Pushing to `main` builds the image and applies the manifests — see
[.github/workflows/deploy.yml](.github/workflows/deploy.yml). The `prod`
environment gates it. Terraform is **not** part of deployment any more.

**Always tag images with the git SHA, never `latest`.** On Container Apps a
mutable tag silently kept the old container running; on Kubernetes it makes
rollouts and `rollout undo` ambiguous, because two different images share one
name. CI tags with the SHA automatically.

Dependencies install from registry.npmjs.org. To build behind an npm proxy, drop
a `.npmrc` in the repo root — it is gitignored, and the Dockerfile installs with
it in a separate stage so it never becomes a layer in the image.

Break-glass manual deploy. `kubectl apply -k k8s/` on its own gives
`ImagePullBackOff`: the committed tag is a placeholder that CI rewrites in its
own checkout, so the tag must be named explicitly.

```bash
export KUBECONFIG=~/.kube/wsj27.yaml
IMG=ghcr.io/scouterna/discord-scoutid-linked-role

(cd k8s && kustomize edit set image "$IMG=$IMG:$(git rev-parse --short HEAD)")
kubectl apply -k k8s/
kubectl rollout status deploy/discord-scoutid
# then revert the kustomization edit — never commit a real tag

kubectl logs -l app=discord-scoutid --follow --prefix
```

## Discord Developer Portal setup

The app needs the `bot` scope and **Manage Roles** + **Manage Nicknames**
permissions, and its role must sit above every role it assigns. Three URLs point
back at the deployment, all on `https://discord-scoutid.wsj27.scouterna.net`:

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
├── eventlog.js    Buffered event log → #server-logg
├── memberscan.js  Scheduled member diff (joins, leaves, renames, kicks, bans)
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
  Verify the Interactions Endpoint URL, and keep at least one replica Ready so
  no interaction hits a cold start. The Deployment runs two, with
  `maxUnavailable: 0` on rollouts.
- **Storage errors from `register.js`** — harmless. It only calls the Discord
  API but imports `config`/`storage` transitively.
- **`npm error Exit handler never called!` during `docker build`** — npm could
  not reach the registry (commonly a TLS-intercepting proxy) and exits 0 anyway
  with a partial `node_modules`. The Dockerfile's post-install check turns that
  into a real build failure; point a local `.npmrc` at a reachable registry.

## License

MIT — see [LICENSE](LICENSE).
