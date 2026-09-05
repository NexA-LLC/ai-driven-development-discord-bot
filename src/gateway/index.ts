import { createHmac, randomUUID } from "node:crypto";
import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
} from "discord.js";

interface AskResponse {
  text: string;
}

interface RateState {
  timestamps: number[];
  lastAlertAt: number;
}

const token = requiredEnv("DISCORD_BOT_TOKEN");
const workerInternalUrl = requiredEnv("WORKER_INTERNAL_URL");
const sharedSecret = requiredEnv("INTERNAL_SHARED_SECRET");

const monitoredChannelIds = new Set(
  (process.env.MONITORED_CHANNEL_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

const enableMessageContentIntent = readBoolean(
  "ENABLE_MESSAGE_CONTENT_INTENT",
  false,
);
const passiveObserve = readBoolean("PASSIVE_OBSERVE", false);
const allowMentionsAnywhere = readBoolean("ALLOW_MENTIONS_ANYWHERE", false);
const wardenAlertChannelId = process.env.WARDEN_ALERT_CHANNEL_ID;
const wardenWindowMs =
  readPositiveInteger("WARDEN_WINDOW_SECONDS", 30) * 1_000;
const wardenMaxMessages = readPositiveInteger("WARDEN_MAX_MESSAGES", 5);
const wardenCooldownMs =
  readPositiveInteger("WARDEN_COOLDOWN_SECONDS", 300) * 1_000;

if (passiveObserve && monitoredChannelIds.size === 0) {
  throw new Error(
    "PASSIVE_OBSERVE=true requires a non-empty MONITORED_CHANNEL_IDS allowlist",
  );
}

const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (enableMessageContentIntent) {
  intents.push(GatewayIntentBits.MessageContent);
}

const client = new Client({ intents });
const botRateState = new Map<string, RateState>();

client.once(Events.ClientReady, (readyClient) => {
  console.log(
    `Gateway ready as ${readyClient.user.tag}; passiveObserve=${passiveObserve}; monitoredChannels=${monitoredChannelIds.size}`,
  );
});

client.on(Events.MessageCreate, async (message) => {
  try {
    await onMessage(message);
  } catch (error) {
    console.error("message handler failed", error);
  }
});

async function onMessage(message: Message): Promise<void> {
  if (!message.guildId || message.author.id === client.user?.id) {
    return;
  }

  const inMonitoredChannel = monitoredChannelIds.has(message.channelId);

  if (message.author.bot) {
    if (inMonitoredChannel) {
      await observeExternalBotRate(message);
    }
    return; // Never let AI bots trigger this AI bot.
  }

  if (passiveObserve && inMonitoredChannel) {
    await postSigned("/internal/events", {
      eventId: randomUUID(),
      eventType: "human_message_observed",
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      actorId: message.author.id,
      actorIsBot: false,
      occurredAt: message.createdAt.toISOString(),
      contentObserved: message.content.length > 0,
    });
  }

  const botUser = client.user;
  if (!botUser || !message.mentions.has(botUser)) {
    return;
  }

  if (!inMonitoredChannel && !allowMentionsAnywhere) {
    return;
  }

  const prompt = message.content
    .replace(new RegExp(`<@!?${botUser.id}>`, "g"), "")
    .trim();

  const response = await postSigned<AskResponse>("/internal/ask", {
    prompt: prompt || "このコミュニティAIで何ができますか？",
    source: {
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      actorId: message.author.id,
    },
  });

  await message.reply({
    content: truncate(response.text, 1_900),
    allowedMentions: {
      parse: [],
      repliedUser: false,
    },
  });
}

async function observeExternalBotRate(message: Message): Promise<void> {
  const now = Date.now();
  const current = botRateState.get(message.author.id) ?? {
    timestamps: [],
    lastAlertAt: 0,
  };

  current.timestamps = current.timestamps.filter(
    (timestamp) => now - timestamp <= wardenWindowMs,
  );
  current.timestamps.push(now);
  botRateState.set(message.author.id, current);

  if (
    current.timestamps.length <= wardenMaxMessages ||
    now - current.lastAlertAt < wardenCooldownMs
  ) {
    return;
  }

  current.lastAlertAt = now;

  const incident = {
    eventId: randomUUID(),
    eventType: "bot_rate_exceeded",
    guildId: message.guildId ?? undefined,
    channelId: message.channelId,
    messageId: message.id,
    actorId: message.author.id,
    actorIsBot: true,
    occurredAt: new Date(now).toISOString(),
    reason: "external bot exceeded the configured message rate",
    count: current.timestamps.length,
    windowSeconds: Math.round(wardenWindowMs / 1_000),
  };

  await postSigned("/internal/events", incident);
  await alertModerators(
    [
      "⚠️ **Bot Warden alert**",
      `Bot: <@${message.author.id}> (\`${message.author.id}\`)`,
      `Channel: <#${message.channelId}>`,
      `${current.timestamps.length} messages / ${Math.round(wardenWindowMs / 1_000)}s`,
      "自動BANはしていません。運営がログを確認し、Quarantine / Kick / BANを判断してください。",
    ].join("\n"),
  );
}

async function alertModerators(content: string): Promise<void> {
  if (!wardenAlertChannelId) {
    console.warn(content);
    return;
  }

  const channel = await client.channels.fetch(wardenAlertChannelId);
  const sendable = channel as
    | {
        send?: (options: {
          content: string;
          allowedMentions: { parse: never[] };
        }) => Promise<unknown>;
      }
    | null;

  if (typeof sendable?.send !== "function") {
    console.warn("WARDEN_ALERT_CHANNEL_ID is not sendable");
    return;
  }

  await sendable.send({
    content,
    allowedMentions: { parse: [] },
  });
}

async function postSigned<T = unknown>(
  path: string,
  payload: unknown,
): Promise<T> {
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", sharedSecret)
    .update(`${timestamp}.${body}`)
    .digest("hex");

  const response = await fetch(new URL(path, workerInternalUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nexa-timestamp": timestamp,
      "x-nexa-signature": signature,
    },
    body,
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(
      `Worker ${path} returned ${response.status}: ${responseText.slice(0, 500)}`,
    );
  }

  return (await response.json()) as T;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }

  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new Error(`${name} must be true or false`);
}

function readPositiveInteger(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined) {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    client.destroy();
    process.exit(0);
  });
}

await client.login(token);
