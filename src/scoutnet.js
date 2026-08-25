import config from "./config.js";
import * as storage from "./storage.js";

/**
 * ScoutNet API client for event participant data. See https://scoutnet.se.
 *
 * The participant list is keyed by member number, and a scoutid *is* a ScoutNet
 * member number — which is what lets links join straight onto this data.
 */

/**
 * Has this registration been cancelled?
 *
 * ScoutNet carries **two** fields and the boolean is the broader one: a
 * `cancelled_date` always implies `cancelled: true`, never the reverse, so
 * reading only the date misses the registrations cancelled administratively
 * without one. One predicate, so the six read sites cannot drift apart.
 */
export function isCancelled(participant) {
  if (!participant) return false;
  return participant.cancelled === true || participant.cancelled_date != null;
}

/** A cancellation date if there is one, else a note that the flag is all we have. */
export function cancelledLabel(participant) {
  return participant?.cancelled_date ?? "utan datum";
}

/**
 * The participant's full name — the name that matters everywhere in this bot.
 * It is what the Discord nickname is built from and what the audit compares
 * against.
 */
export function fullName(participant) {
  return [participant?.first_name, participant?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** One participant by member number, or null if they are not in the event. */
export async function getParticipant(memberId) {
  const participants = await getParticipants();
  return participants[String(memberId)] ?? null;
}

/**
 * Every participant in the configured event, keyed by member number. Cached in
 * process memory for 10 minutes — the full list exceeds what Table Storage
 * holds in one property, and a cache miss costs one extra fetch.
 *
 * Each participant carries `fee_id`, `cancelled`, `cancelled_date`,
 * `first_name`, `last_name` and a `questions` map of questionId → answer.
 */
export async function getParticipants() {
  const cached = await storage.getScoutNetData("participants");
  if (cached) return cached;

  const url = `https://scoutnet.se/api/project/get/participants?id=${config.SCOUTNET_EVENT_ID}&key=${config.SCOUTNET_PARTICIPANTS_APIKEY}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `ScoutNet API error: [${response.status}] ${response.statusText} - ${await response.text()}`,
    );
  }

  const data = await response.json();
  const participants = data.participants ?? data;
  await storage.storeScoutNetData("participants", participants);
  return participants;
}
