/**
 * One HTTP request, with the retries Discord's API needs.
 *
 * Every call in discord.js goes through `request`, so no call site can forget
 * to stamp the status or to honour `retry_after`.
 *
 * Two kinds of failure are retried. A **429** always: Discord refused before
 * doing anything, so asking again cannot do anything twice. A **transient**
 * failure — 502, 503, 504, or no response at all — only for a method that is
 * safe to repeat. Such a failure does not say whether the request reached
 * Discord, and a POST that did is not harmless to send again: a token refresh
 * rotates the refresh token, so the repeat would come back `invalid_grant`,
 * which the verification gate reads as a revoked grant.
 */

/** Never wait longer than this for one retry, however long Discord asks. */
const MAX_RETRY_DELAY_MS = 10_000;
/** Nor short enough to be a hot loop: Discord can answer `retry_after: 0`. */
const MIN_RETRY_DELAY_MS = 250;

/** Repeating one of these leaves the same state as sending it once. */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "PATCH"]);

/** Discord's edge answering for a backend that did not. */
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long to wait before retry number `attempt`.
 *
 * Discord's own `retry_after` wins whenever it sent one — it is the answer to
 * exactly this question. The exponential ladder is the fallback for responses
 * that carry no hint.
 *
 * Clamped at both ends: never a hot loop, and never long enough to outlast the
 * pod's 60s termination grace, so a rate limit cannot hold up a rollout.
 */
export function retryDelayMs(attempt, retryAfterMs) {
  const asked = Number.isFinite(retryAfterMs)
    ? retryAfterMs
    : Math.pow(2, attempt) * 1000;
  return Math.min(Math.max(asked, MIN_RETRY_DELAY_MS), MAX_RETRY_DELAY_MS);
}

/**
 * Callers branch on `error.status` — memberscan tells a 403 on the audit log
 * from a real failure by that field alone. `Retry-After` is seconds and may be
 * fractional; the header is used because it is on every response without
 * having to read the body first.
 */
function attachStatus(error, response) {
  error.status = response.status;
  if (response.status === 429) {
    const seconds = Number(response.headers?.get?.("retry-after"));
    if (Number.isFinite(seconds) && seconds >= 0) {
      error.retryAfterMs = seconds * 1000;
    }
  }
  return error;
}

/**
 * Fetch with retries, returning parsed JSON by default.
 *
 * - `what` names the call in the error message.
 * - `parse` — `"json"`, `"none"` (returns true), or `"raw"` to get the Response
 *   back unread and unthrown, for a caller that needs to see the status itself.
 * - `withBody` appends the error response body to the message, for calls where
 *   Discord explains the refusal there.
 */
export async function request(
  url,
  {
    what = "request",
    parse = "json",
    withBody = false,
    retries = 3,
    ...init
  } = {},
) {
  const repeatable = IDEMPOTENT_METHODS.has(
    String(init.method ?? "GET").toUpperCase(),
  );
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= retries - 1;
    let response;
    try {
      response = await fetch(url, init);
    } catch (e) {
      // No response at all: a reset connection or a timeout on the way.
      if (!repeatable || last) throw e;
      const delay = retryDelayMs(attempt);
      console.log(
        `${what}: ${e.message}, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`,
      );
      await sleep(delay);
      continue;
    }
    if (parse === "raw") return response;
    if (response.ok) {
      return parse === "json" ? await response.json() : true;
    }

    const detail = [response.statusText, withBody ? await response.text() : ""]
      .filter(Boolean)
      .join(" ");
    const error = attachStatus(
      new Error(`${what}: [${response.status}]${detail ? ` ${detail}` : ""}`),
      response,
    );

    const retryable =
      error.status === 429 ||
      (repeatable && TRANSIENT_STATUSES.has(error.status));
    if (!retryable || last) throw error;
    const delay = retryDelayMs(attempt, error.retryAfterMs);
    console.log(
      `${error.message}, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`,
    );
    await sleep(delay);
  }
}
