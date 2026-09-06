import { createHmac, randomUUID } from "node:crypto";
import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
} from "discord.js";
import {
  buildSystemPrompt,
  detectLanguage,
  type AskMode,
  type SuEvent,
} from "../shared/persona.js";

interface AiJob {
  id: string;
  mode: AskMode;
  input: string | null;
  language: string;
  application_id: string;
  interaction_token: string;
  ephemeral: number;
}

const EPHEMERAL_FLAG = 1 << 6;

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

// In-house LLM (OpenAI-compatible Chat Completions, e.g. LM Studio on the LAN).
const llmApiUrl = process.env.LLM_API_URL?.trim() || "";
const llmModel = process.env.LLM_MODEL?.trim() || "";
const llmApiKey = process.env.LLM_API_KEY?.trim() || "";
const llmTimeoutMs = readPositiveInteger("LLM_TIMEOUT_SECONDS", 120) * 1_000;
const jobPollMs = readPositiveInteger("JOB_POLL_SECONDS", 3) * 1_000;
const pitcheeeUrl = process.env.PITCHEEE_URL?.trim() || undefined;

if (passiveObserve && monitoredChannelIds.size === 0) {
  throw new Error(
    "PASSIVE_OBSERVE=true requires a non-empty MONITORED_CHANNEL_IDS allowlist",
  );
}

const welcomeChannelId = process.env.WELCOME_CHANNEL_ID?.trim() || "";

const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (enableMessageContentIntent) {
  intents.push(GatewayIntentBits.MessageContent);
}
if (welcomeChannelId) {
  // Needs "Server Members Intent" enabled in the Developer Portal.
  intents.push(GatewayIntentBits.GuildMembers);
}

const client = new Client({ intents });
const botRateState = new Map<string, RateState>();

client.once(Events.ClientReady, (readyClient) => {
  console.log(
    `Gateway ready as ${readyClient.user.tag}; passiveObserve=${passiveObserve}; monitoredChannels=${monitoredChannelIds.size}; llm=${llmApiUrl ? llmModel || "(model unset)" : "disabled"}`,
  );
  if (llmApiUrl) {
    void pollJobsForever();
  } else {
    console.warn(
      "LLM_API_URL is not set; /ask and /pitch orders will stay in the queue",
    );
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  if (!welcomeChannelId || member.user.bot) {
    return;
  }
  try {
    const name = member.displayName || member.user.username;
    const text = await generateReply(
      "welcome",
      `新しいお客さんの名前: ${name}`,
      detectLanguage(name) === "ja" ? "ja" : "en",
    );
    const channel = await client.channels.fetch(welcomeChannelId);
    const sendable = channel as
      | {
          send?: (options: {
            content: string;
            allowedMentions: { users: string[] };
          }) => Promise<unknown>;
        }
      | null;
    if (typeof sendable?.send !== "function") {
      console.warn("WELCOME_CHANNEL_ID is not sendable");
      return;
    }
    await sendable.send({
      content: `<@${member.id}> ${truncate(text, 1_800)}`,
      allowedMentions: { users: [member.id] },
    });
  } catch (error) {
    console.error("welcome failed", error);
  }
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

  const prompt =
    message.content.replace(new RegExp(`<@!?${botUser.id}>`, "g"), "").trim() ||
    "この店で何ができますか？";

  let text: string;
  try {
    text = await generateReply("mention", prompt);
  } catch (error) {
    console.error("mention reply failed", error);
    text =
      "すみません、今、答えが作れませんでした。少し時間を置いて、もう一度お願いします。";
  }

  await message.reply({
    content: truncate(text, 1_900),
    allowedMentions: {
      parse: [],
      repliedUser: false,
    },
  });
}

async function pollJobsForever(): Promise<void> {
  for (;;) {
    try {
      const { jobs } = await postSigned<{ jobs: AiJob[] }>(
        "/internal/jobs/claim",
        {},
      );
      for (const job of jobs) {
        await processJob(job);
      }
    } catch (error) {
      console.error("job poll failed", error);
    }
    await sleep(jobPollMs);
  }
}

async function processJob(job: AiJob): Promise<void> {
  let text: string;
  let ok = true;
  let errorMessage: string | undefined;

  try {
    if (!job.input) {
      throw new Error("job has no input");
    }
    text = await generateReply(job.mode, job.input);
  } catch (error) {
    ok = false;
    errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`job ${job.id} failed`, error);
    text =
      "すみません、今、答えが作れませんでした。内容は外に出していません。少し時間を置いて、もう一度お願いします。";
  }

  try {
    await sendInteractionFollowUp(job, truncate(text, 1_900));
  } catch (error) {
    ok = false;
    errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`job ${job.id} follow-up failed`, error);
  }

  await postSigned("/internal/jobs/complete", {
    id: job.id,
    ok,
    error: errorMessage,
  });
}

async function generateReply(
  event: SuEvent,
  input: string,
  language = detectLanguage(input),
): Promise<string> {
  if (!llmApiUrl) {
    throw new Error("LLM_API_URL is not configured");
  }

  const systemPrompt = buildSystemPrompt(event, language, { pitcheeeUrl });

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (llmApiKey) {
    headers.authorization = `Bearer ${llmApiKey}`;
  }

  const response = await fetch(llmApiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: llmModel || undefined,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: input },
      ],
      temperature: 0.4,
      max_tokens: 900,
    }),
    signal: AbortSignal.timeout(llmTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`LLM API returned ${response.status}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = body.choices?.[0]?.message?.content;
  if (!text || text.trim().length === 0) {
    throw new Error("LLM API returned no text");
  }

  return stripReasoning(text).trim();
}

/** Some local models echo their reasoning in <think>…</think>; never show it. */
function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<\/?think>/g, "");
}

async function sendInteractionFollowUp(
  job: AiJob,
  content: string,
): Promise<void> {
  const response = await fetch(
    `https://discord.com/api/v10/webhooks/${job.application_id}/${job.interaction_token}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content,
        flags: job.ephemeral ? EPHEMERAL_FLAG : 0,
        allowed_mentions: { parse: [] },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Discord follow-up returned ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
