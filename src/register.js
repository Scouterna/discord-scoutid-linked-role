import config from "./config.js";
import * as discord from "./discord.js";

/**
 * One-time registration script:
 * 1. Registers linked role metadata schema with Discord
 * 2. Registers the /refresh-scoutid slash command
 *
 * Run with: node src/register.js
 */

// --- Register linked role metadata ---

const metadataUrl = `https://discord.com/api/v10/applications/${config.DISCORD_CLIENT_ID}/role-connections/metadata`;
const metadata = [
  {
    key: "verified",
    name: "Verifierad",
    description: "Har verifierat sin identitet med ScoutID",
    type: 7, // boolean_eq
  },
];

console.log("Registering linked role metadata...");
const metadataResponse = await fetch(metadataUrl, {
  method: "PUT",
  body: JSON.stringify(metadata),
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bot ${config.DISCORD_TOKEN}`,
  },
});

if (metadataResponse.ok) {
  console.log("Metadata registered:", await metadataResponse.json());
} else {
  console.error("Metadata registration failed:", await metadataResponse.text());
}

// --- Register slash command ---

if (config.DISCORD_GUILD_ID) {
  console.log("Registering /refresh-scoutid command...");
  try {
    const result = await discord.registerGuildCommand(config.DISCORD_GUILD_ID);
    console.log("Command registered:", result.name);
  } catch (e) {
    console.error("Command registration failed:", e.message);
  }

  console.log("Registering /status-scoutid command...");
  try {
    const result = await discord.registerStatusCommand(config.DISCORD_GUILD_ID);
    console.log("Command registered:", result.name);
  } catch (e) {
    console.error("Command registration failed:", e.message);
  }

  console.log("Registering /audit-scoutid command...");
  try {
    const result = await discord.registerAuditCommand(config.DISCORD_GUILD_ID);
    console.log("Command registered:", result.name);
  } catch (e) {
    console.error("Command registration failed:", e.message);
  }

  console.log("Registering /link-scoutid command...");
  try {
    const result = await discord.registerLinkCommand(config.DISCORD_GUILD_ID);
    console.log("Command registered:", result.name);
  } catch (e) {
    console.error("Command registration failed:", e.message);
  }
} else {
  console.log("Skipping slash command registration: DISCORD_GUILD_ID not set");
}

process.exit(0);
