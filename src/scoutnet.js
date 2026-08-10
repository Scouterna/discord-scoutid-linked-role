import config from "./config.js";
import * as storage from "./storage.js";

/**
 * ScoutNet API client for event participant data.
 * See https://scoutnet.se for API details.
 */

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
      `ScoutNet API error: [${response.status}] ${response.statusText} - ${errorText}`
    );
  }

  const data = await response.json();
  const participants = data.participants ?? data;
  await storage.storeScoutNetData("participants", participants);
  return participants;
}
