import config from "./config.js";
import * as storage from "./storage.js";

/**
 * ScoutNet API client for event participant data.
 * See https://scoutnet.se for API details.
 */

/**
 * Has this registration been cancelled?
 *
 * ScoutNet carries **two** fields, and the boolean is the broader one: of 2769
 * live records, 175 had `cancelled: true` while only 168 had a `cancelled_date`,
 * and none had a date without the flag. So a date always implies the flag, and
 * reading only the date missed seven people.
 *
 * Those seven were registrations that were never confirmed or paid (`fee_id:
 * null`, `confirmed: false`) and then cancelled administratively without a date
 * being written. None of them was linked and none had a fee, so nothing came of
 * it — but a person with the flag *and* a fee would have kept their division
 * role and their channels, and neither the sync nor audit category 5 would have
 * noticed.
 *
 * One predicate, so the two fields cannot be read inconsistently in six places
 * again.
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
 * Get a specific participant by member ID.
 * Returns null if not found.
 */
export async function getParticipant(memberId) {
  const participants = await getParticipants();
  const key = String(memberId);
  return participants[key] ?? null;
}

/**
 * Get all participants for the configured event.
 * Results are cached for 10 minutes.
 *
 * Each participant has: member_no, first_name, last_name,
 * registration_date, cancelled_date, fee, questions, etc.
 */
export async function getParticipants() {
  const cached = await storage.getScoutNetData("participants");
  if (cached) return cached;

  const url = `https://scoutnet.se/api/project/get/participants?id=${config.SCOUTNET_EVENT_ID}&key=${config.SCOUTNET_PARTICIPANTS_APIKEY}`;
  const response = await fetch(url);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `ScoutNet API error: [${response.status}] ${response.statusText} - ${errorText}`,
    );
  }

  const data = await response.json();
  const participants = data.participants ?? data;
  await storage.storeScoutNetData("participants", participants);
  return participants;
}
