/**
 * One HTTP request, with the rate-limit retry Discord's API requires.
 *
 * Every call in discord.js goes through `request`, so no call site can forget
 * to stamp the status or to honour `retry_after`.
 */

/** Never wait longer than this for one retry, however long Discord asks. */
const MAX_RETRY_DELAY_MS = 10_000;
/** Nor short enough to be a hot loop: Discord can answer `retry_after: 0`. */
const MIN_RETRY_DELAY_MS = 250;

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
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
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

    if (error.status !== 429 || attempt >= retries - 1) throw error;
    const delay = retryDelayMs(attempt, error.retryAfterMs);
    console.log(
      `Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`,
    );
    await sleep(delay);
  }
}
