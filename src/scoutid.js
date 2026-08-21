import crypto from "crypto";
import config from "./config.js";

/**
 * Code specific to communicating with the ScoutID API.
 * See https://scoutid.se for more details.
 *
 * OIDC discovery is available at:
 *  https://scoutid.se/simplesaml/module.php/oidc/openid-configuration.php
 */

/**
 * Generate the url which the user will be directed to in order to approve the
 * bot, and see the list of requested scopes.
 */
export function getOidcAuthorizationUrl() {
  // OIDC requires: state, nonce, PKCE (code_verifier + code_challenge), scope incl. openid
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();

  const codeVerifier = crypto.randomBytes(64).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const authorizationEndpoint =
    "https://scoutid.se/simplesaml/module.php/oidc/authorize.php";
  const url = new URL(authorizationEndpoint);
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

  return {
    state,
    nonce,
    codeVerifier,
    url: url.toString(),
  };
}

/**
 * Given an OIDC authorization code from ScoutID, exchange it for access tokens.
 */
export async function getOidcTokens({ code, codeVerifier }) {
  if (!code) throw new Error("Missing authorization code");
  if (!codeVerifier) throw new Error("Missing PKCE code_verifier");

  const url = "https://scoutid.se/simplesaml/module.php/oidc/access_token.php";
  const body = new URLSearchParams({
    client_id: config.SCOUTID_CLIENT_ID,
    client_secret: config.SCOUTID_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.SCOUTID_REDIRECT_URI,
    code_verifier: codeVerifier,
  });

  const response = await fetch(url, {
    body,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  if (response.ok) {
    return await response.json();
  } else {
    const errorText = await response.text();
    throw new Error(
      `Error fetching ScoutID OIDC tokens: [${response.status}] ${response.statusText} - ${errorText}`,
    );
  }
}

/**
 * Given an access token, fetch user profile information from ScoutID.
 *
 * Example response (fields depend on granted scopes):
 * {
 *   "sub": "123@scoutnet.se",
 *   "family_name": "Lastname",
 *   "given_name": "Firstname",
 *   "profile": "123",
 *   "email": "firstname.lastname@example.com",
 *   "roles": "{\"organisation\":[],\"region\":[],\"project\":{\"123\":{\"65\":\"leader\",\"138\":\"project_admin\"}},\"network\":[],\"corps\":[],\"district\":[],\"group\":[],\"troop\":[],\"patrol\":[]}",
 *   "role": "*:*:group_committee_1"
 * }
 */
export async function getUserData(tokens) {
  const url = "https://scoutid.se/simplesaml/module.php/oidc/userinfo.php";
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
    },
  });

  if (response.ok) {
    // Not `response.json()` straight off. SimpleSAMLphp answers a token it no
    // longer accepts with **HTTP 200 and an HTML page**, so `ok` is true and the
    // parse throws `Unexpected token '<', "<!DOCTYPE "...` — an error that says
    // nothing about the cause. This path is the one that must work (it is how the
    // scoutid is learned at link time), so when it does fail it should say why.
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

    const metadata = {
      name: data.given_name + " " + data.family_name,
      scoutid: data.profile,
      email: data.email,
    };

    return metadata;
  } else {
    const errorText = await response.text();
    throw new Error(
      `Error fetching ScoutID user data: [${response.status}] ${response.statusText} - ${errorText}`,
    );
  }
}
