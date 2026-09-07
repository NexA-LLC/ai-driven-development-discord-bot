import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  type Message,
  type TextChannel,
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
// Operator channel (店長室) and musings channel (スーの独り言). Resolved by id,
// else by name inside the primary guild, else created (needs Manage Channels).
const primaryGuildId = process.env.DISCORD_GUILD_ID?.trim() || "";
let opsChannelId = process.env.OPS_CHANNEL_ID?.trim() || "";
let musingsChannelId = process.env.MUSINGS_CHANNEL_ID?.trim() || "";
const opsChannelName = process.env.OPS_CHANNEL_NAME?.trim() || "店長室";
const musingsChannelName = process.env.MUSINGS_CHANNEL_NAME?.trim() || "スーの独り言";
// Hours (JST) at which スー posts one musing each. The local LLM is free, so
// several a day are fine; each hour gets time-of-day material.
const musingsHoursJst = (process.env.MUSINGS_HOURS_JST ?? process.env.MUSINGS_HOUR_JST ?? "7,12,18,23")
  .split(",")
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isInteger(v) && v >= 0 && v <= 23);
const museOnStart = readBoolean("MUSE_ON_START", false);
// Daily improvement digest (Worker /internal/digest/run). The account has no
// spare Workers cron trigger, so the Gateway is the clock.
const digestHourJst = readPositiveInteger("DIGEST_HOUR_JST", 3);
let lastDigestDate = "";
const readinessPort = readPositiveInteger("READINESS_PORT", 8790);
const gatewayHost = process.env.GATEWAY_HOST_LABEL?.trim() || "gateway";

const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
];
if (enableMessageContentIntent) {
  intents.push(GatewayIntentBits.MessageContent);
}
if (welcomeChannelId) {
  // Needs "Server Members Intent" enabled in the Developer Portal.
  intents.push(GatewayIntentBits.GuildMembers);
}

const client = new Client({
  intents,
  partials: [Partials.Message, Partials.Reaction, Partials.Channel],
});
let inFlight = 0;
let lastMusingSlot = "";
const botRateState = new Map<string, RateState>();

client.once(Events.ClientReady, async (readyClient) => {
  console.log(
    `Gateway ready as ${readyClient.user.tag}; passiveObserve=${passiveObserve}; monitoredChannels=${monitoredChannelIds.size}; llm=${llmApiUrl ? llmModel || "(model unset)" : "disabled"}`,
  );
  try {
    await resolveOperatorChannels();
  } catch (error) {
    console.error("channel resolution failed", error);
  }
  startReadinessServer();
  void digestForever();
  if (llmApiUrl) {
    void pollJobsForever();
    void museForever();
    if (museOnStart && musingsChannelId) {
      postMusing(new Date(Date.now() + 9 * 60 * 60 * 1_000).getUTCHours(), true).catch((error) =>
        console.error("startup musing failed", error),
      );
    }
  } else {
    console.warn(
      "LLM_API_URL is not set; /ask and /pitch orders will stay in the queue",
    );
    void reportIncident("llm_not_configured", "error", "LLM_API_URL が未設定で、注文に答えられません");
  }
});

client.on(Events.Error, (error) => {
  console.error("discord client error", error);
  void reportIncident("discord_client_error", "error", "Discord クライアントでエラー", String(error));
});
client.on(Events.ShardDisconnect, (event) => {
  void reportIncident("discord_disconnected", "warning", "Discord との接続が切れました", `code=${event.code}`);
});
client.on(Events.ShardResume, () => {
  console.log("discord shard resumed");
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (user.bot) {
      return;
    }
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    if (message.author?.id !== client.user?.id) {
      return; // Only reactions to スー's own messages are feedback.
    }
    await postSigned("/internal/feedback", {
      kind: "reaction",
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      inReplyToMessageId: message.id,
      userId: user.id,
      content: reaction.emoji.name ?? reaction.emoji.id ?? "?",
    });
  } catch (error) {
    console.error("reaction feedback failed", error);
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
    const sent = (await sendable.send({
      content: `<@${member.id}> ${truncate(text, 1_800)}`,
      allowedMentions: { users: [member.id] },
    })) as { id?: string } | undefined;
    await logReply({
      event: "welcome",
      guildId: member.guild.id,
      channelId: welcomeChannelId,
      messageId: sent?.id,
      requesterUserId: member.id,
      replyText: text,
    });
  } catch (error) {
    console.error("welcome failed", error);
    await reportIncident("welcome_failed", "warning", "新規参加者への挨拶に失敗", String(error));
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

  if (process.env.GATEWAY_DEBUG === "1") {
    console.log(
      `[msg] channel=${message.channelId} author=${message.author.id} bot=${message.author.bot} mentionsMe=${client.user ? message.mentions.has(client.user) : "?"} contentLen=${message.content.length}`,
    );
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
  if (!botUser) {
    return;
  }

  // Feedback: a human replying to one of スー's messages (Discord reply), or
  // talking in her musings channel, is stored as feedback (SECURITY.md).
  const repliedToId = message.reference?.messageId;
  let repliedToSu = false;
  if (repliedToId) {
    try {
      const referenced = await message.channel.messages.fetch(repliedToId);
      repliedToSu = referenced.author.id === botUser.id;
    } catch {
      repliedToSu = false;
    }
  }
  const inMusings = musingsChannelId !== "" && message.channelId === musingsChannelId;
  if (repliedToSu || inMusings) {
    await postSigned("/internal/feedback", {
      kind: "reply",
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      inReplyToMessageId: repliedToId ?? null,
      userId: message.author.id,
      content: message.content,
    }).catch((error) => console.error("feedback log failed", error));
  }

  if (!message.mentions.has(botUser)) {
    return;
  }

  if (!inMonitoredChannel && !allowMentionsAnywhere && !inMusings) {
    return;
  }

  const prompt =
    message.content.replace(new RegExp(`<@!?${botUser.id}>`, "g"), "").trim() ||
    "この店で何ができますか？";

  let text: string;
  let ok = true;
  const startedAt = Date.now();
  inFlight += 1;
  try {
    text = await generateReply("mention", prompt);
  } catch (error) {
    console.error("mention reply failed; falling back to the Worker", error);
    await reportIncident("mention_llm_unreachable", "warning", "メンション: 社内LLMに届かず、Workers AI で代替", String(error));
    try {
      const fallback = await postSigned<{ text: string }>("/internal/ask", {
        prompt,
        provider: "workers-ai",
      });
      text = fallback.text;
    } catch (fallbackError) {
      ok = false;
      console.error("mention fallback failed", fallbackError);
      await reportIncident("mention_unanswered", "error", "メンションに答えられませんでした", String(fallbackError));
      text =
        "すみません、今、答えが作れませんでした。少し時間を置いて、もう一度お願いします。";
    }
  } finally {
    inFlight -= 1;
  }

  const sent = await message.reply({
    content: truncate(text, 1_900),
    allowedMentions: {
      parse: [],
      repliedUser: false,
    },
  });
  await logReply({
    event: "mention",
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: sent.id,
    requesterUserId: message.author.id,
    latencyMs: Date.now() - startedAt,
    ok,
    replyText: text,
  });
}

async function resolveOperatorChannels(): Promise<void> {
  if (!primaryGuildId) {
    return;
  }
  const guild = await client.guilds.fetch(primaryGuildId);
  const channels = await guild.channels.fetch();
  const findByName = (name: string) =>
    channels.find((c) => c?.type === ChannelType.GuildText && c.name === name) as
      | TextChannel
      | undefined;

  if (!opsChannelId) {
    let ops = findByName(opsChannelName);
    if (!ops) {
      ops = await guild.channels.create({
        name: opsChannelName,
        type: ChannelType.GuildText,
        topic: "スーからの報告と、店長（運営）向けの通知。自動処罰はしません。",
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: client.user!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        ],
      });
      console.log(`created ops channel #${opsChannelName} (${ops.id})`);
    }
    opsChannelId = ops.id;
  }
  if (!musingsChannelId) {
    let musings = findByName(musingsChannelName);
    if (!musings) {
      musings = await guild.channels.create({
        name: musingsChannelName,
        type: ChannelType.GuildText,
        topic: "深夜、客のいない時間のスーの独り言。返事もリアクションも、彼女の材料になります。",
      });
      console.log(`created musings channel #${musingsChannelName} (${musings.id})`);
    }
    musingsChannelId = musings.id;
  }
  console.log(`channels: ops=${opsChannelId} musings=${musingsChannelId}`);
}

/** nexa.host.update.readiness/v1 on loopback, for the NexA Host runtime. */
function startReadinessServer(): void {
  const server = createServer((request, response) => {
    if (request.url !== "/readiness") {
      response.writeHead(404).end();
      return;
    }
    const body = {
      contract: "nexa.host.update.readiness/v1",
      decision: inFlight > 0 ? "defer" : "ready",
      reasonCode: inFlight > 0 ? "active_work" : "idle",
      message: inFlight > 0 ? `${inFlight} replies in progress` : "idle",
      activeWork: inFlight,
      retryAfterSeconds: 30,
      observedAt: new Date().toISOString(),
    };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  server.on("error", (error) => console.warn("readiness server unavailable", error));
  server.listen(readinessPort, "127.0.0.1", () =>
    console.log(`readiness at http://127.0.0.1:${readinessPort}/readiness`),
  );
}

/** Once a day around DIGEST_HOUR_JST, ask the Worker to run the improvement digest. */
async function digestForever(): Promise<void> {
  for (;;) {
    try {
      const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1_000);
      const today = nowJst.toISOString().slice(0, 10);
      if (nowJst.getUTCHours() === digestHourJst && lastDigestDate !== today) {
        lastDigestDate = today;
        await postSigned("/internal/digest/run", { hours: 24 });
        console.log(`digest requested for ${today}`);
      }
    } catch (error) {
      console.error("digest request failed", error);
      await reportIncident("digest_failed", "warning", "日次の改善ダイジェストの実行に失敗", String(error));
    }
    await sleep(5 * 60 * 1_000);
  }
}

/** At each configured hour (JST), スー posts one musing to her channel. */
async function museForever(): Promise<void> {
  for (;;) {
    try {
      const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1_000);
      const hour = nowJst.getUTCHours();
      const slot = `${nowJst.toISOString().slice(0, 10)}T${hour}`;
      if (musingsChannelId && musingsHoursJst.includes(hour) && lastMusingSlot !== slot) {
        lastMusingSlot = slot;
        await postMusing(hour, false);
      }
    } catch (error) {
      console.error("musing failed", error);
      await reportIncident("musing_failed", "warning", "独り言の投稿に失敗", String(error));
    }
    await sleep(5 * 60 * 1_000);
  }
}

function timeOfDayMaterial(hourJst: number): string {
  if (hourJst >= 5 && hourJst < 10) {
    return "時間帯: 朝。夜勤が明けて、店を出るところ。眠い。空が明るい。これから寝るか、日本語学校に行くか。";
  }
  if (hourJst >= 10 && hourJst < 15) {
    return "時間帯: 昼。日本語学校の昼休み。教室の窓際。授業で分からなかった言葉が一つある。";
  }
  if (hourJst >= 15 && hourJst < 21) {
    return "時間帯: 夕方。出勤前。アパートで制服に着替える。今日の常連は誰が来るだろう、と考える。";
  }
  return "時間帯: 深夜。レジに立っている。客はいない。品出しの途中。";
}

async function postMusing(hourJst: number, force: boolean): Promise<void> {
  const channel = await client.channels.fetch(musingsChannelId);
  const text = channel as TextChannel | null;
  if (!text || text.type !== ChannelType.GuildText) {
    return;
  }
  // Do not post twice in the same slot if the process restarted after posting.
  if (!force) {
    const recent = await text.messages.fetch({ limit: 3 });
    const tooSoon = recent.some(
      (m) => m.author.id === client.user?.id && Date.now() - m.createdTimestamp < 2 * 60 * 60 * 1_000,
    );
    if (tooSoon) {
      return;
    }
  }
  const todayJst = new Date(Date.now() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  const material = [
    `今日の日付（JST）: ${todayJst}、今の時刻: ${hourJst}時ごろ`,
    timeOfDayMaterial(hourJst),
    `この起動以降にレジで答えた回数: ${repliesSinceStart}、うまく答えられなかった回数: ${failuresSinceStart}`,
  ].join("\n");
  const startedAt = Date.now();
  const musing = await generateReply("musing", material, "ja");
  const sent = await text.send({ content: truncate(musing, 400), allowedMentions: { parse: [] } });
  await logReply({
    event: "musing",
    guildId: text.guildId,
    channelId: text.id,
    messageId: sent.id,
    latencyMs: Date.now() - startedAt,
    ok: true,
    replyText: musing,
  });
}

let repliesSinceStart = 0;
let failuresSinceStart = 0;

async function logReply(entry: {
  event: string;
  guildId?: string | null | undefined;
  channelId?: string | null | undefined;
  messageId?: string | null | undefined;
  requesterUserId?: string | null | undefined;
  latencyMs?: number | undefined;
  ok?: boolean | undefined;
  replyText?: string | undefined;
}): Promise<void> {
  if (entry.ok === false) {
    failuresSinceStart += 1;
  } else {
    repliesSinceStart += 1;
  }
  try {
    await postSigned("/internal/reply-logs", {
      ...entry,
      provider: "gateway",
      model: llmModel || null,
    });
  } catch (error) {
    console.error("reply log failed", error);
  }
}

async function reportIncident(
  kind: string,
  severity: "info" | "warning" | "error" | "critical",
  summary: string,
  detail?: string,
): Promise<void> {
  try {
    await postSigned("/internal/incidents", {
      kind,
      severity,
      source: gatewayHost,
      summary,
      detail: detail ? detail.slice(0, 1_500) : undefined,
      dedupeKey: `${gatewayHost}:${kind}`,
    });
  } catch (error) {
    console.error("incident report failed", error);
  }
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
  const startedAt = Date.now();
  inFlight += 1;

  try {
    if (!job.input) {
      throw new Error("job has no input");
    }
    text = await generateReply(job.mode, job.input);
  } catch (error) {
    inFlight -= 1;
    // Hand the order back: the Worker answers with its fallback model
    // (Workers AI) or apologises itself, so the customer always hears back.
    console.error(`job ${job.id} failed; handing back to the Worker`, error);
    failuresSinceStart += 1;
    await reportIncident(
      "llm_unreachable",
      "error",
      "社内LLMに届かず、注文をWorkerに戻しました",
      error instanceof Error ? `${error.message}${(error as { cause?: { code?: string } }).cause?.code ? ` (${(error as { cause?: { code?: string } }).cause?.code})` : ""}` : String(error),
    );
    await postSigned("/internal/jobs/complete", {
      id: job.id,
      ok: false,
      answered: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  inFlight -= 1;

  try {
    await sendInteractionFollowUp(job, truncate(text, 1_900));
  } catch (error) {
    console.error(`job ${job.id} follow-up failed`, error);
    await reportIncident("followup_failed", "warning", "Discord への返信送信に失敗", String(error));
    await postSigned("/internal/jobs/complete", {
      id: job.id,
      ok: false,
      answered: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  await logReply({
    event: job.mode,
    latencyMs: Date.now() - startedAt,
    ok: true,
    replyText: text,
  });
  await postSigned("/internal/jobs/complete", { id: job.id, ok: true });
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

  const requestBody = JSON.stringify({
    model: llmModel || undefined,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: input },
    ],
    temperature: 0.4,
    max_tokens: 900,
  });

  // The in-house LLM host occasionally drops off the LAN for a few seconds
  // (EHOSTUNREACH); retry up to five times before giving up on the order (the interaction token lives 15 minutes).
  const delaysMs = [0, 2_000, 5_000, 10_000, 20_000];
  let response: Response | undefined;
  let lastError: unknown;
  for (const delay of delaysMs) {
    if (delay > 0) {
      await sleep(delay);
    }
    try {
      response = await fetch(llmApiUrl, {
        method: "POST",
        headers,
        body: requestBody,
        signal: AbortSignal.timeout(llmTimeoutMs),
      });
      if (response.ok || response.status < 500) {
        break;
      }
      lastError = new Error(`LLM API returned ${response.status}`);
    } catch (error) {
      lastError = error;
      console.warn("LLM request failed, retrying", error);
    }
  }

  if (!response) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
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
