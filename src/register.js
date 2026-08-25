import config from "./config.js";
import * as discord from "./discord.js";

/**
 * One-time registration against Discord: the linked-role metadata schema, then
 * every slash command in `discord.COMMANDS`.
 *
 * Run with `node src/register.js`. Rarely needed — the definitions change
 * seldom, and re-registering is idempotent.
 */

/**
 * One key, and a constant `true` is the point: the value carries no information,
 * the **absence** does. Discord clears the metadata when the user disconnects the
 * app, which is exactly the revocation the Scout role represents.
 */
const METADATA_SCHEMA = [
  {
    key: "verified",
    name: "Verifierad",
    description: "Har verifierat sin identitet med ScoutID",
    type: 7, // boolean_eq
  },
];

console.log("Registering linked role metadata...");
const response = await fetch(
  `https://discord.com/api/v10/applications/${config.DISCORD_CLIENT_ID}/role-connections/metadata`,
  {
    method: "PUT",
    body: JSON.stringify(METADATA_SCHEMA),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${config.DISCORD_TOKEN}`,
    },
  },
);
console.log(
  response.ok
    ? `Metadata registered: ${JSON.stringify(await response.json())}`
    : `Metadata registration failed: ${await response.text()}`,
);

if (config.DISCORD_GUILD_ID) {
  for (const command of discord.COMMANDS) {
    try {
      await discord.registerCommand(config.DISCORD_GUILD_ID, command);
      console.log(`Registered /${command.name}`);
    } catch (e) {
      console.error(`Registering /${command.name} failed: ${e.message}`);
    }
  }
} else {
  console.log("Skipping slash command registration: DISCORD_GUILD_ID not set");
}

process.exit(0);
