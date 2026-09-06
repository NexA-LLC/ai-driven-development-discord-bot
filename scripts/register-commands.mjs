// Registers slash commands through the Worker, which holds the bot token.
// Needs WORKER_INTERNAL_URL and INTERNAL_SHARED_SECRET (from .env); set
// DISCORD_GUILD_ID to register for one guild only (instant), omit for global.
import { createHmac } from "node:crypto";

const workerInternalUrl = required("WORKER_INTERNAL_URL");
const sharedSecret = required("INTERNAL_SHARED_SECRET");
const guildId = process.env.DISCORD_GUILD_ID?.trim();

const timestamp = Math.floor(Date.now() / 1_000).toString();
const body = JSON.stringify(guildId ? { guildId } : {});
const signature = createHmac("sha256", sharedSecret)
  .update(`${timestamp}.${body}`)
  .digest("hex");

const response = await fetch(
  new URL("/internal/register-commands", workerInternalUrl),
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nexa-timestamp": timestamp,
      "x-nexa-signature": signature,
    },
    body,
  },
);

const text = await response.text();
if (!response.ok) {
  console.error(`Worker returned ${response.status}: ${text}`);
  process.exit(1);
}

const result = JSON.parse(text);
console.log(`Registered ${result.commands.length} commands (${result.scope}): ${result.commands.join(", ")}`);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required (put it in .env)`);
  }
  return value;
}
