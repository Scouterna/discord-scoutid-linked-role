import crypto from "crypto";
import config from "./config.js";

/**
 * ScoutID OIDC client — the identity half of the linking flow.
 *
 * Discovery: https://scoutid.se/simplesaml/module.php/oidc/openid-configuration.php
 *
 * The only thing this flow needs from ScoutID is the person's scoutid, read from
 * a token seconds old. ScoutID's tokens are deliberately not stored: the access
 * token expires within the hour and nothing refreshes it.
 */

const OIDC = "https://scoutid.se/simplesaml/module.php/oidc";

/** The URL the user is sent to in order to approve the app and see the scopes. */
export function getOidcAuthorizationUrl() {
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const codeVerifier = crypto.randomBytes(64).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  const url = new URL(`${OIDC}/authorize.php`);
  url.searchParams.set("client_id", config.SCOUTID_CLIENT_ID);
  url.searchParams.set("redirect_uri", config.SCOUTID_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "scope",
    config.SCOUTID_SCOPES || "openid profile email",
  );
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  return { state, nonce, codeVerifier, url: url.toString() };
}

/** Exchange an authorization code for tokens, completing the PKCE handshake. */
export async function getOidcTokens({ code, codeVerifier }) {
  if (!code) throw new Error("Missing authorization code");
  if (!codeVerifier) throw new Error("Missing PKCE code_verifier");

  const response = await fetch(`${OIDC}/access_token.php`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.SCOUTID_CLIENT_ID,
      client_secret: config.SCOUTID_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: config.SCOUTID_REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Error fetching ScoutID OIDC tokens: [${response.status}] ${response.statusText} - ${await response.text()}`,
    );
  }
  return await response.json();
}

/**
 * The user's profile — `{ name, scoutid, email }`, where `scoutid` is the
 * ScoutNet member number everything else keys off.
 *
 * Not `response.json()` straight off: SimpleSAMLphp answers a token it no longer
 * accepts with **HTTP 200 and an HTML page**, so `ok` is true and the parse
 * throws `Unexpected token '<'` — an error that says nothing about the cause.
 * This is the path that has to work, so when it fails it should say why.
 */
export async function getUserData(tokens) {
  const response = await fetch(`${OIDC}/userinfo.php`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!response.ok) {
    throw new Error(
      `Error fetching ScoutID user data: [${response.status}] ${response.statusText} - ${await response.text()}`,
    );
  }

  const body = await response.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    const peek = body.slice(0, 60).replace(/\s+/g, " ");
    throw new Error(
      `ScoutID svarade HTTP ${response.status} men inte med JSON (\`${peek}…\`) — access-tokenet gäller sannolikt inte längre`,
    );
  }

  return {
    name: `${data.given_name} ${data.family_name}`,
    scoutid: data.profile,
    email: data.email,
  };
}
