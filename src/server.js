import express from "express";
import cookieParser from "cookie-parser";

import config from "./config.js";
import * as discord from "./discord.js";
import * as scoutid from "./scoutid.js";
import * as storage from "./storage.js";
import * as roles from "./roles.js";
import * as eventlog from "./eventlog.js";
import { handlers } from "./commands.js";
import { updateMetadata, RELINK_PATH } from "./metadata.js";
import { getSuccessPageHTML, getIncompletePageHTML } from "./templates.js";

/**
 * The HTTP surface: three health routes, the three-legged OAuth flow, and
 * Discord's interactions endpoint.
 *
 * Exported as `app` and listens only as the process entrypoint, so tests can
 * bind their own port and drive the routes exactly as deployed.
 */

const app = express();
app.use(cookieParser(config.COOKIE_SECRET));

// --- Health checks ---
//
// The difference between the three is the point.
//
// `/` is the landing page a human might hit.
//
// `/healthz` is liveness and depends on nothing outside the process. Liveness
// restarts the pod, so hanging it on Table Storage would turn a storage blip
// into every replica restarting at once — a degraded service made into none.
//
// `/readyz` is readiness and does depend on storage, because a pod that cannot
// reach the table answers every interaction with an error, and taking it out of
// the endpoint list is exactly right. Two consequences: with `maxUnavailable: 0`
// a storage outage also blocks rollouts, which is the correct answer to "should
// we deploy into this?"; and `failureThreshold` is what keeps one slow request
// from evicting a healthy pod.

app.get("/", (req, res) => {
  res.send("👋");
});

app.get("/healthz", (req, res) => {
  res.type("text/plain").send("ok");
});

// The probe fires every 10s per pod. The result is cached for slightly less than
// that so a burst of probes cannot become a burst of storage requests, and the
// in-flight promise is shared so a *hung* table does not stack probes on top of
// each other until the pod runs out of sockets.
const READY_CACHE_MS = 5000;
const READY_TIMEOUT_MS = 3000;
let readyCache = { at: 0, ok: false, error: null };
let readyInFlight = null;

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} svarade inte inom ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    // Or the timer keeps the event loop alive for its full duration, which at
    // shutdown means the process lingers for no reason.
    clearTimeout(timer);
  }
}

async function isReady() {
  if (Date.now() - readyCache.at < READY_CACHE_MS) return readyCache;
  readyInFlight ??= (async () => {
    try {
      await withTimeout(storage.ping(), READY_TIMEOUT_MS, "Table Storage");
      readyCache = { at: Date.now(), ok: true, error: null };
    } catch (e) {
      readyCache = { at: Date.now(), ok: false, error: e.message };
    }
    return readyCache;
  })().finally(() => {
    readyInFlight = null;
  });
  return readyInFlight;
}

app.get("/readyz", async (req, res) => {
  const { ok, error } = await isReady();
  if (ok) {
    res.type("text/plain").send("ready");
    return;
  }
  // The reason goes to the log, not the body: the ingress routes `/` as a
  // prefix, so this route answers the public internet, and Azure's errors carry
  // endpoint names and request ids. A probe only needs the status code.
  console.error(`Readiness check failed: ${error}`);
  res.status(503).type("text/plain").send("storage unreachable");
});

// --- OAuth flow, step 1: redirect to Discord ---

app.get("/linked-role", async (req, res) => {
  const { url, state } = discord.getOAuthUrl();
  res.cookie("clientState", state, { maxAge: 1000 * 60 * 5, signed: true });
  res.redirect(url);
});

// --- OAuth flow, step 2: Discord callback → redirect to ScoutID ---

app.get("/discord-oauth-callback", async (req, res) => {
  try {
    const { clientState } = req.signedCookies;
    if (clientState !== req.query["state"]) {
      console.error("State verification failed.");
      return res.sendStatus(403);
    }

    const tokens = await discord.getOAuthTokens(req.query["code"]);
    const userId = (await discord.getUserData(tokens)).user.id;

    await storage.storeDiscordTokens(userId, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
    });

    const { state, codeVerifier, url } = scoutid.getOidcAuthorizationUrl();
    res.cookie("clientState", state, { maxAge: 1000 * 60 * 5, signed: true });
    await storage.storeStateData(state, {
      discordUserId: userId,
      codeVerifier,
    });
    res.redirect(url);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

// --- OAuth flow, step 3: ScoutID callback → link, roles, nickname ---

app.get("/scoutid-oauth-callback", async (req, res) => {
  try {
    const state = req.query["state"];
    const { discordUserId, codeVerifier } = await storage.getStateData(state);

    const { clientState } = req.signedCookies;
    if (clientState !== state) {
      console.error("State verification failed.");
      return res.sendStatus(403);
    }

    // ScoutID's tokens are deliberately not stored: the access token expires
    // within the hour, nothing refreshes it, and the one thing this flow needs
    // from ScoutID — the scoutid itself — is read here from a token seconds old.
    const tokens = await scoutid.getOidcTokens({
      code: req.query["code"],
      codeVerifier,
    });
    const scoutIDUser = await scoutid.getUserData(tokens);
    console.log(
      `Linked ScoutID ${scoutIDUser.scoutid} to Discord user ${discordUserId}`,
    );

    await storage.setLinkedScoutIDUserId(discordUserId, scoutIDUser.scoutid);

    // The metadata push is caught, and everything below runs without it. What
    // must not happen is claiming success: with no `verified` stored, Discord
    // evaluates the Scout requirement as unmet and grants nothing, so the member
    // has to come back — which is what the incomplete page says.
    let metadataFailed = false;
    try {
      await updateMetadata(discordUserId);
    } catch (e) {
      metadataFailed = true;
      console.error(
        `Could not push metadata for ${discordUserId}, linking continues:`,
        e.message,
      );
    }

    // `allowIncomplete`: this path only adds roles, so a ScoutNet outage must
    // not fail a verification that otherwise succeeded. The member gets the
    // Scout marker now and the rest at the next sync.
    let assignedRoles = [];
    let grantProblem = null;
    try {
      const desiredRoles = await roles.getDesiredRoles(scoutIDUser.scoutid, {
        allowIncomplete: true,
      });
      if (desiredRoles.length > 0) {
        ({ granted: assignedRoles, problem: grantProblem } =
          await roles.grantRoles(discordUserId, desiredRoles));
      }
    } catch (e) {
      console.error(`Error assigning roles for ${discordUserId}:`, e.message);
    }

    if (scoutIDUser.name) {
      const suffix = await roles.getNicknameSuffix(scoutIDUser.scoutid, {
        allowIncomplete: true,
      });
      await roles.setNickname(discordUserId, scoutIDUser.name, suffix);
    }

    // Nothing granted — say why, in the line someone reads two hours later.
    // Two sources, in this order: ScoutNet explains a member there was nothing
    // to give, and `explainMissingRoles` returns null for a live, mapped one —
    // then the writes themselves explain it, from the statuses they saw.
    //
    // The old fallback asked "finns de i servern?" for every such case. On
    // 2026-09-21 that was answered fifteen times by someone whose roles all
    // existed and who was not herself in the server, on an account she had
    // linked from by mistake — the one question the line could not raise.
    const reason =
      assignedRoles.length === 0
        ? ((await roles.explainMissingRoles(scoutIDUser.scoutid)) ??
          grantProblem ??
          "rollerna kunde inte delas ut")
        : null;

    eventlog.logLinked({
      discordUserId,
      scoutId: scoutIDUser.scoutid,
      name: scoutIDUser.name,
      roles: assignedRoles,
      reason,
      metadataFailed,
    });

    res.send(
      metadataFailed
        ? getIncompletePageHTML({
            relinkPath: RELINK_PATH,
            scoutRole: config.SCOUTNET_SCOUT_ROLE,
          })
        : getSuccessPageHTML(),
    );
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

// --- Discord interactions ---

/**
 * Slash commands acknowledge within Discord's 3-second window and do the real
 * work a moment later. That work outlives the HTTP response, so it is tracked
 * here and awaited at shutdown — otherwise a rollout kills it after the user has
 * been told the command was accepted.
 */
const pendingWork = new Set();

function scheduleBackground(fn, delayMs = 1000) {
  const task = new Promise((resolve) => {
    setTimeout(() => {
      Promise.resolve().then(fn).catch(console.error).finally(resolve);
    }, delayMs);
  });
  pendingWork.add(task);
  task.finally(() => pendingWork.delete(task));
  return task;
}

app.post(
  "/interactions",
  // Raw, not parsed: the signature covers the exact bytes Discord sent, and
  // re-serialising a parsed body would change them.
  express.raw({ type: "application/json" }),
  (req, res) => {
    const rawBody = req.body.toString();
    const verified = discord.verifyInteraction(
      config.DISCORD_PUBLIC_KEY,
      req.headers["x-signature-ed25519"],
      req.headers["x-signature-timestamp"],
      rawBody,
    );
    if (!verified) return res.sendStatus(401);

    const interaction = JSON.parse(rawBody);
    if (interaction.type === 1) return res.json({ type: 1 }); // PING

    const handler =
      interaction.type === 2 ? handlers[interaction.data.name] : null;
    if (!handler) return res.sendStatus(400);

    // Type 5 is "thinking", flag 64 is ephemeral — an audit report must not land
    // in the channel it was run from.
    res.json({ type: 5, data: { flags: 64 } });
    scheduleBackground(() => handler(interaction));
  },
);

export { app };

// --- Entrypoint and graceful shutdown ---
//
// Everything below only happens under `node src/server.js`, which is what the
// Dockerfile's exec-form CMD runs. Importing this module binds no port and
// installs no signal handler.
//
// Kubernetes sends SIGTERM, then SIGKILLs after terminationGracePeriodSeconds
// (60). The preStop hook spends the first 10 of those keeping the pod in service
// while its endpoint removal propagates, so the budget here is ~50s. Node
// installs no default SIGTERM handler and as PID 1 would otherwise ignore the
// signal entirely — this handler is what makes the grace period mean anything.

const isEntrypoint = process.argv[1]?.endsWith("server.js");
const SHUTDOWN_TIMEOUT_MS = 40_000;

let server = null;
if (isEntrypoint) {
  const port = process.env.PORT || 3000;
  server = app.listen(port, () => console.log(`App listening on port ${port}`));
}

let shuttingDown = false;

async function drain() {
  // Stop accepting new connections. Idle keep-alives are closed explicitly —
  // server.close() alone waits for them and would stall the whole drain.
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeIdleConnections();
  await closed;

  if (pendingWork.size > 0) {
    console.log(`waiting for ${pendingWork.size} background task(s)`);
  }
  await Promise.allSettled([...pendingWork]);

  // Event-log lines are buffered for a few seconds, so they are flushed *after*
  // the background work that produces them — flushing first would miss whatever
  // a slash command logs on its way out.
  await eventlog.flushEventLog().catch(() => {});
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, draining`);

  // Backstop: never let a wedged request hold the pod open past the grace
  // period, where it would be SIGKILLed mid-write instead.
  const forceExit = setTimeout(() => {
    console.error(
      `Drain exceeded ${SHUTDOWN_TIMEOUT_MS}ms, exiting with work outstanding`,
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  drain().then(
    () => {
      console.log("drain complete, exiting");
      process.exit(0);
    },
    (e) => {
      console.error("error while draining:", e);
      process.exit(1);
    },
  );
}

if (isEntrypoint) {
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
