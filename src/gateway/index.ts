import { VoiceChat } from "./voice-chat.js";
import { parseVoiceDecision, VOICE_RESPONSE_FORMAT } from "./voice-audio.js";
import { isAudioAttachment, transcribeAudio, synthesizeSpeech } from "./audio.js";
import { resolve } from "node:path";
import { postChannelMessage } from "./channel-post.js";
import { runMentionAgent, mentionTools, type AgentMessage } from "./mention-agent.js";
import { readMentionedChannels } from "./channel-context.js";
import { allowsConversationInChannel, conversationContext, conversationReference, readableConversation, shouldAnswer } from "./message-routing.js";
import { ExperienceStore, experienceReference, type ExperienceMemory, type SyncOutcome } from "./experience-memory.js";
import { ConnpassFeed } from "./connpass-feed.js";
import { deliverMusing } from "./musing.js";
import { publicExperience, publicExperienceBody } from "../shared/public-experience.js";
import { startTyping } from "./typing.js";
import { seedQuizReactions } from "../shared/quiz-reactions.js";
import { isQuizPrompt, parseRequestedQuiz, parseQuiz, renderQuiz, QUIZ_SYSTEM_PROMPT } from "../shared/quiz.js";
import { readSlot, writeSlot } from "./schedule-state.js";
import { lifecycle } from "./lifecycle.js";
import { auditConversation } from "./conversation-audit.js";
import { inbox, type InboxItem } from "./inbox.js";
import { ConsecutiveFailureGate, LlmReliability, LlmRequestError, llmHttpError, normalizeLlmError } from "./llm-reliability.js";
import { completionText, type LlmCompletionBody } from "./llm-completion.js";
import { searchWeb } from "./web-search.js";
import { createHash, createHmac, randomUUID } from "node:crypto";
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
  guild_id?: string | null;
  requester_user_id?: string | null;
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
const llmAttemptTimeoutMs = readPositiveInteger("LLM_ATTEMPT_TIMEOUT_SECONDS", 45) * 1_000;
const llmTotalTimeoutMs = readPositiveInteger("LLM_TOTAL_TIMEOUT_SECONDS", 90) * 1_000;
const llmMaxAttempts = readPositiveInteger("LLM_MAX_ATTEMPTS", 2);
// Background prose can legitimately take longer than the generic 45 second
// attempt limit on the local reasoning model. Keep it bounded, but do not turn
// a merely slow scheduled musing into a user-facing outage.
const backgroundLlmAttemptTimeoutMs = readPositiveInteger("BACKGROUND_LLM_ATTEMPT_TIMEOUT_SECONDS", 120) * 1_000;
const backgroundLlmTotalTimeoutMs = readPositiveInteger("BACKGROUND_LLM_TOTAL_TIMEOUT_SECONDS", 180) * 1_000;
// Discord mentions are normal channel replies, so they can remain queued much
// longer than interactions. A waiting notice is posted while the single-flight
// request remains attached; ambiguous timeouts are never immediately retried.
const mentionLlmAttemptTimeoutMs = readPositiveInteger("MENTION_LLM_ATTEMPT_TIMEOUT_SECONDS", 180) * 1_000;
const mentionLlmTotalTimeoutMs = readPositiveInteger("MENTION_LLM_TOTAL_TIMEOUT_SECONDS", 240) * 1_000;
const mentionWaitNoticeMs = readPositiveInteger("MENTION_WAIT_NOTICE_SECONDS", 15) * 1_000;
const mentionDeferredRetries = readPositiveInteger("MENTION_DEFERRED_RETRIES", 2);
const mentionRetryDelayMs = readPositiveInteger("MENTION_RETRY_DELAY_SECONDS", 60) * 1_000;
const jobPollMs = readPositiveInteger("JOB_POLL_SECONDS", 3) * 1_000;
const pitcheeeUrl = process.env.PITCHEEE_URL?.trim() || undefined;
const llmReliability = new LlmReliability({
  maxConcurrency: readPositiveInteger("LLM_MAX_CONCURRENCY", 2),
  maxBackgroundConcurrency: readPositiveInteger("LLM_MAX_BACKGROUND_CONCURRENCY", 1),
  maxQueue: readPositiveInteger("LLM_MAX_QUEUE", 50),
  maxAttempts: llmMaxAttempts,
  attemptTimeoutMs: llmAttemptTimeoutMs,
  totalTimeoutMs: llmTotalTimeoutMs,
  retryDelayMs: readPositiveInteger("LLM_RETRY_DELAY_SECONDS", 2) * 1_000,
  circuitFailureThreshold: readPositiveInteger("LLM_CIRCUIT_FAILURES", 1),
  circuitCooldownMs: readPositiveInteger("LLM_CIRCUIT_COOLDOWN_SECONDS", 60) * 1_000,
});
let modelPreflightError: string | null = null;

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
// Nightly maintenance (Worker /internal/maintenance/run). The account has no spare
// Workers cron trigger, so the Gateway is the clock. It creates no daily report.
const maintenanceHourJst = readPositiveInteger("MAINTENANCE_HOUR_JST", readPositiveInteger("DIGEST_HOUR_JST", 3));
let lastMaintenanceDate = readSlot("digest-date");
// How often human edits made in the Garden are read back for known experience threads.
const experiencePullMs = readPositiveInteger("EXPERIENCE_PULL_SECONDS", 3600) * 1_000;
// Nodes read back per pull. The Worker caps this server-side too; the whole Garden is never read.
const experiencePullBatch = 20;
let lastExperiencePullAt = 0;
let lastGardenSyncAt: string | null = null;
let lastGardenReadAt: string | null = null;
let lastGardenSyncFailureAt: string | null = null;
let lastGardenSyncFailureStatus: string | null = null;
let lastGardenReadFailureAt: string | null = null;
let lastGardenReadFailureStatus: string | null = null;
let lastWebSearchAt: string | null = null;
let lastWebSearchFailureAt: string | null = null;
let lastWebSearchFailureStatus: string | null = null;
let sweepCursor = 0;
const readinessPort = readPositiveInteger("READINESS_PORT", 8790);
const gatewayHost = process.env.GATEWAY_HOST_LABEL?.trim() || "gateway";
const llmHealthProbeMs = readPositiveInteger("LLM_HEALTH_PROBE_SECONDS", 300) * 1_000;
const llmHealthProbeFailureThreshold = readPositiveInteger("LLM_HEALTH_PROBE_FAILURE_THRESHOLD", 3);
const llmHealthProbeFailures = new ConsecutiveFailureGate(llmHealthProbeFailureThreshold);

const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildVoiceStates,
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
const voiceChat = new VoiceChat(client, async (text, history, audit) => {
  const request = { model: llmModel || undefined, response_format: VOICE_RESPONSE_FORMAT, max_tokens: 1_500,
      messages: [{ role: "system", content: buildSystemPrompt("mention", "ja", { pitcheeeUrl }) + '\n音声通話中です。聞き取りは誤認識の可能性があります。応答はJSONだけで {"action":"reply|leave|ignore","text":"読み上げる自然な日本語、300文字以内"}。利用者の意図を判断して、退室依頼はleave、無音・雑音・意味不明な認識結果はignore、それ以外の会話はreply。返答は1〜3文で短く。読み上げに不向きなMarkdownやURLを入れない。通話以外の外部操作は実行できないので実行済みと主張しない。' }, ...history, { role: "user", content: text }],
  };
  auditConversation({ ...audit, phase: "llm_request", input: JSON.stringify(request) });
  const answer = await llmReliability.run(async ({ signal, requestId }) => {
    const response = await fetch(llmApiUrl, {
      method: "POST", headers: llmHeaders(requestId), body: JSON.stringify(request), signal,
    });
    if (!response.ok) {
      auditConversation({ ...audit, phase: "llm_response", ok: false, response: JSON.stringify({ status: response.status, requestId }) });
      throw llmHttpError(response.status);
    }
    return completionText(await response.json() as LlmCompletionBody);
  }, { priority: "interactive" });
  auditConversation({ ...audit, phase: "llm_response", ok: true, response: answer });
  return parseVoiceDecision(answer);
});
let startupReady = false;
let inFlight = 0;
const slowMentionIds = new Set<string>();
let lastMusingSlot = readSlot("musing-slot");
const botRateState = new Map<string, RateState>();
const experiences = new ExperienceStore();
const connpass = new ConnpassFeed(undefined, readPositiveInteger("CONNPASS_POLL_SECONDS", 3600) * 1000,
  readPositiveInteger("CONNPASS_CACHE_HOURS", 24) * 3600_000, process.env.CONNPASS_API_KEY?.trim() ?? "");
const connpassEnabled = readBoolean("CONNPASS_ENABLED", false);
if (connpassEnabled && !process.env.CONNPASS_API_KEY?.trim()) console.warn("CONNPASS_ENABLED requires CONNPASS_API_KEY; event refreshes will fail until it is set");
const experienceKnowledgeChannels = new Set([
  ...(process.env.EXPERIENCE_KNOWLEDGE_CHANNEL_IDS ?? "").split(","),
  // Backward-compatible alias. It now enables private Knowledge sync, never public visibility.
  ...(process.env.EXPERIENCE_PUBLIC_CHANNEL_IDS ?? "").split(","),
].map(s => s.trim()).filter(Boolean));

client.once(Events.ClientReady, async (readyClient) => {
  console.log(
    `Gateway ready as ${readyClient.user.tag}; passiveObserve=${passiveObserve}; monitoredChannels=${monitoredChannelIds.size}; llm=${llmApiUrl ? llmModel || "(model unset)" : "disabled"}`,
  );
  try {
    await resolveOperatorChannels();
  } catch (error) {
    console.error("channel resolution failed", error);
  }
  await preflightConfiguredModel();
  startReadinessServer();
  while (!lifecycle.draining) {
    try { await lifecycle.run(catchUpMessages); startupReady = true; break; }
    catch (error) { console.error("inbox recovery blocked", error); await sleep(5000); }
  }
  void replayInboxForever();
  void providerWatchForever();
  setInterval(() => { if (client.isReady() && !lifecycle.draining) inbox.heartbeat(); }, 5000);
  void maintenanceForever();
  void experienceForever();
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
  void resolveIncident("discord_disconnected");
});

client.on(Events.MessageReactionAdd, async (reaction, user) => lifecycle.run(async () => {
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
}));

const welcomeInProgress = new Set<string>();
client.on(Events.GuildMemberAdd, async (member) => lifecycle.run(async () => {
  if (!welcomeChannelId || member.user.bot || (primaryGuildId && member.guild.id !== primaryGuildId)) {
    return;
  }
  const slot = `welcome-${member.guild.id}-${member.id}`;
  const joined = String(member.joinedTimestamp ?? "unknown");
  if (welcomeInProgress.has(slot) || readSlot(slot) === joined) return;
  welcomeInProgress.add(slot);
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
            allowedMentions: { users: string[]; parse: [] };
            nonce: string;
            enforceNonce: boolean;
          }) => Promise<unknown>;
        }
      | null;
    if (typeof sendable?.send !== "function") {
      console.warn("WELCOME_CHANNEL_ID is not sendable");
      return;
    }
    const sent = (await sendable.send({
      content: `<@${member.id}> ${truncate(text, 1_800)}`,
      allowedMentions: { users: [member.id], parse: [] },
      nonce: createHmac("sha256", "welcome").update(`${slot}:${joined}`).digest("hex").slice(0, 24),
      enforceNonce: true,
    })) as { id?: string } | undefined;
    writeSlot(slot, joined);
    await logReply({
      event: "welcome",
      guildId: member.guild.id,
      channelId: welcomeChannelId,
      messageId: sent?.id,
      requesterUserId: member.id,
      replyText: text,
    });
    await resolveIncidentImpl("welcome_failed");
  } catch (error) {
    console.error("welcome failed", error);
    await reportIncident("welcome_failed", "warning", "新規参加者への挨拶に失敗", String(error));
  } finally {
    welcomeInProgress.delete(slot);
  }
}));

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    inbox.add(message.channelId, message.id);

  } catch (error) {
    console.error("message handler failed", error);
  }
});

interface MessageOutcome {
  status: "answered" | "deferred" | "failed";
  noticeMessageId?: string;
  error?: string;
  countAttempt?: boolean;
}

export async function onMessageImpl(message: Message, recovery?: InboxItem): Promise<MessageOutcome | void> {
  if (!message.guildId || message.flags?.has(64) || (primaryGuildId && message.guildId !== primaryGuildId) || message.author.id === client.user?.id) {
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
  const inMusings = musingsChannelId !== "" && message.channelId === musingsChannelId;
  const conversationAllowed = allowsConversationInChannel({
    channelId: message.channelId,
    monitoredChannelIds,
    allowMentionsAnywhere,
    musingsChannelId,
    welcomeChannelId,
  });
  if (!conversationAllowed) return;
  // Preserve musing-channel feedback without collecting unrelated conversation context.
  if (!message.reference?.messageId && !message.mentions.has(botUser) && !inMusings) return;
  const context = message.reference?.messageId || message.mentions.has(botUser) || message.attachments.size
    ? await conversationContext(message) : { repliedToSu: false, sources: [], status: "unavailable" as const };

  // Feedback: a human replying to one of スー's messages (Discord reply), or
  // talking in her musings channel, is stored as feedback (SECURITY.md).
  const repliedToId = message.reference?.messageId;
  const repliedToSu = context.repliedToSu;
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

  const audioAttachments = [...message.attachments.values()].filter(isAudioAttachment);
  const audioAddressed = audioAttachments.length > 0 && (inMusings || repliedToSu || message.mentions.has(botUser));
  if (!shouldAnswer({ human: !message.author.bot, guildId: message.guildId, primaryGuildId,
    allowedChannel: conversationAllowed,
    mentioned: message.mentions.has(botUser), repliedToSu, audioAddressed })) {
    return;
  }

  let prompt =
    message.content.replace(new RegExp(`<@!?${botUser.id}>`, "g"), "").trim() ||
    "この店で何ができますか？";

  const stopTyping = "sendTyping" in message.channel
    ? startTyping(message.channel)
    : () => {};
  try {
    const audit = { id: message.id, event: "mention", userId: message.author.id, guildId: message.guildId, channelId: message.channelId };
    auditConversation({ ...audit, phase: "received", input: message.content });
    let text: string;
    let lethweiReaction = false;
    let speechText: string | undefined;
    let transcript: string | undefined;
    let ok = true;
    let deferredOutcome: MessageOutcome | undefined;
    let finalFailure: string | undefined;
    let recoveryNoticeMessageId = recovery?.noticeMessageId;
    let waitNoticePromise: Promise<void> | undefined;
    const startedAt = Date.now();
    const waitNoticeTimer = recovery ? setTimeout(() => {
      waitNoticePromise = (async () => {
        slowMentionIds.add(message.id);
        recoveryNoticeMessageId = await upsertRecoveryNotice(
          message,
          recoveryNoticeMessageId,
          "返答を生成中です。完了したら、このメッセージを回答に更新します。",
        );
      })().catch(error => console.error("waiting notice failed", error));
    }, mentionWaitNoticeMs) : undefined;
    inFlight += 1;
    try {
      if (audioAddressed) {
        if (audioAttachments.length !== 1) throw new Error("音声は1件ずつ送ってください");
        transcript = await transcribeAudio(audioAttachments[0]!);
        prompt = `${message.content.replace(new RegExp(`<@!?${botUser.id}>`, "g"), "").trim()}\n音声投稿の文字起こし（利用者の発言。聞き間違いの可能性あり）:\n${transcript}` ;
      }
      text = await runMentionAgent(
        prompt,
        buildSystemPrompt("mention", detectLanguage(prompt), { pitcheeeUrl }),
        async (messages, allowTools) => {
          return llmReliability.run(async ({ signal, requestId }) => {
            const response = await fetch(llmApiUrl, {
              method: "POST",
              headers: llmHeaders(requestId),
              body: JSON.stringify({ model: llmModel || undefined, messages, tools: mentionTools, tool_choice: allowTools ? "auto" : "none", temperature: 0.4, max_tokens: 1200 }),
              signal,
            });
            if (!response.ok) throw llmHttpError(response.status);
            const body = await response.json() as { choices?: Array<{ message?: AgentMessage }> };
            const answer = body.choices?.[0]?.message;
            if (!answer) throw new LlmRequestError("Agent LLM returned no message", { code: "empty_message", retryable: true });
            if (!(answer.tool_calls?.length)) completionText(body as LlmCompletionBody);
            return answer;
          }, {
            priority: "interactive",
            requestId: `mention-${message.id}-${randomUUID()}`,
            attemptTimeoutMs: mentionLlmAttemptTimeoutMs,
            totalTimeoutMs: mentionLlmTotalTimeoutMs,
          });
        },
        async (name, args) => {
          if (name === "search_web") {
            const search = (args ?? {}) as { query?: unknown; freshness_days?: unknown };
            if (typeof search.query !== "string") throw new Error("検索語が必要です");
            const freshnessDays = typeof search.freshness_days === "number" ? search.freshness_days : 7;
            try {
              const result = await searchWeb(search.query, { freshnessDays, limit: 5 });
              lastWebSearchAt = new Date().toISOString();
              lastWebSearchFailureAt = null;
              lastWebSearchFailureStatus = null;
              await resolveIncidentImpl("web_search_failed").catch(error => console.warn("web search recovery report failed", error));
              return result;
            } catch (error) {
              lastWebSearchFailureAt = new Date().toISOString();
              lastWebSearchFailureStatus = error instanceof Error ? error.name : "unknown";
              await reportIncidentImpl(
                "web_search_failed",
                "warning",
                "スーの公開ニュース検索に失敗",
                JSON.stringify({ provider: "Google News RSS", error: lastWebSearchFailureStatus }),
              ).catch(reportError => console.warn("web search incident report failed", reportError));
              throw error;
            }
          }
          if (name === "join_voice_channel") return voiceChat.join(message);
          if (name === "leave_voice_channel") return voiceChat.leave(message);
          if (name === "speak_reply") {
            const value = (args as { text?: unknown } | null)?.text;
            if (typeof value !== "string" || !value.trim() || value.length > 400) throw new Error("読み上げ文は1〜400文字で指定してください");
            speechText = value;
            return { prepared: true, delivery: "最終返信に音声を添付予定。まだ送信していません" };
          }
          if (name === "show_lethwei_reaction") {
            lethweiReaction = true;
            return { attachedToReply: true, animation: "怒りのラウェイ・コンボ", realAction: false };
          }
          if (name === "post_channel_message") {
            const post = (args ?? {}) as { channel_id?: unknown; content?: unknown };
            const receiptKey = `post:${createHash("sha256").update(JSON.stringify([post.channel_id, post.content])).digest("hex")}`;
            const prior = inbox.toolReceipt(message.id, receiptKey);
            if (prior.found) return prior.value;
            const result = await postChannelMessage(message, args);
            // Persist the result before asking the model for its final wording.
            // Discord's stable nonce is the crash-window backstop; this receipt
            // also lets a later replay report the original send accurately.
            inbox.recordToolReceipt(message.id, receiptKey, result);
            return result;
          }
          const id = (args as { channel_id?: unknown } | null)?.channel_id;
          const allowed = [...message.content.matchAll(/<#(\d+)>/g)].map(match => match[1]);
          if (typeof id !== "string" || !allowed.includes(id)) throw new Error("ユーザーが今回指定したチャンネルのみ参照できます");
          const result = await readMentionedChannels(message, [id]);
          return result?.context ? JSON.parse(result.context) : { status: result?.status ?? "参照できませんでした" };
        },
        event => auditConversation({ ...audit, phase: event.phase, ...(event.tool ? { tool: event.tool } : {}), ...(event.ok === undefined ? {} : { ok: event.ok }) }),
        [conversationReference(context), experienceReference(await recallExperiences(message, prompt))],
      );
    } catch (error) {
      if (waitNoticeTimer) clearTimeout(waitNoticeTimer);
      await waitNoticePromise;
      ok = false;
      console.error("mention agent failed", error);
      const failure = error instanceof Error ? error.message : String(error);
      if (error instanceof LlmRequestError) {
        await reportIncident(
          "mention_llm_failed",
          "error",
          "スーがメンションへの返答を生成できませんでした",
          JSON.stringify({ messageId: message.id, model: llmModel || null, code: error.code, failure, provider: llmReliability.snapshot() }),
        );
        if (recovery && recovery.attempts < mentionDeferredRetries) {
          const noticeMessageId = await upsertRecoveryNotice(
            message,
            recoveryNoticeMessageId,
            `返答処理を待ち行列に保持しています。LLMの復旧を確認してから再開します（試行 ${recovery.attempts + 1}/${mentionDeferredRetries}）。`,
          );
          deferredOutcome = {
            status: "deferred",
            noticeMessageId,
            error: failure,
            countAttempt: !["circuit_open", "circuit_half_open", "queue_full"].includes(error.code),
          };
        } else if (recovery) {
          finalFailure = failure;
        }
      }
      text = audioAddressed
        ? "すみません、音声を処理できませんでした。8MB以下・2分以内の音声を1件ずつ送るか、文字でお願いします。"
        : recovery
          ? "返答生成を自動で再試行しましたが、今回は復旧できませんでした。障害として記録し、改善対象に入れました。"
          : "すみません、今は依頼を完了できませんでした。障害として記録し、こちらで再試行します。";
    } finally {
      if (waitNoticeTimer) clearTimeout(waitNoticeTimer);
      await waitNoticePromise;
      slowMentionIds.delete(message.id);
      inFlight -= 1;
    }
    if (deferredOutcome) {
      await logReply({
        event: "mention_deferred",
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: deferredOutcome.noticeMessageId,
        requesterUserId: message.author.id,
        latencyMs: Date.now() - startedAt,
        ok: false,
        replyText: "automatic retry scheduled",
      });
      return deferredOutcome;
    }
  
    const files: Array<{ attachment: Buffer | string; name: string; description?: string }> = [];
    if (ok && lethweiReaction) files.push({ attachment: resolve("assets/su-lethwei.webp"), name: "su-lethwei.webp" });
    if (ok && speechText) {
      try {
        const spoken = speechText;
        files.push({ attachment: await synthesizeSpeech(spoken), name: "su-voice.mp3" });
      } catch (error) {
        console.error("speech synthesis failed", error);
        text += "\n（音声を作れなかったので、今回は文字でお返事します。）";
      }
    }
    if (transcript) text = `聞き取り：${truncate(transcript, 500)}\n\n${text}`;
    auditConversation({ ...audit, phase: "generated", response: truncate(text, 1_900), ok });
    const replyOptions = {
      content: truncate(text, 1_900),
      ...(files.length ? { files } : {}),
      allowedMentions: {
        parse: [],
        repliedUser: false,
      },
    };
    const sent = recoveryNoticeMessageId
      ? await editRecoveryNotice(message, recoveryNoticeMessageId, replyOptions.content, files)
      : await message.reply(replyOptions);
    auditConversation({ ...audit, phase: "sent", messageId: sent.id });
    if (ok && context.status === "available") {
      try { experiences.enqueue(message.id, context.sources); }
      catch { console.error("experience enqueue failed"); }
    }
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
    if (ok) {
      await resolveIncidentImpl("mention_llm_failed");
      if (recoveryNoticeMessageId && slowMentionIds.size === 0) {
        await resolveIncidentImpl("mention_llm_waiting");
      }
    }
    if (ok && inbox.deadLetterSize > 0) {
      const requeued = inbox.requeueDeadLetters(20);
      if (requeued > 0) console.log(`LLM recovered; requeued ${requeued} deferred mention(s)`);
    }
    return finalFailure ? { status: "failed", error: finalFailure } : { status: "answered" };
  } finally {
    stopTyping();
  }
}

async function upsertRecoveryNotice(message: Message, noticeMessageId: string | undefined, content: string): Promise<string> {
  if (noticeMessageId) {
    try {
      const notice = await message.channel.messages?.fetch(noticeMessageId);
      if (notice) {
        await notice.edit({ content, allowedMentions: { parse: [] } });
        return notice.id;
      }
    } catch (error) {
      console.warn("retry notice edit failed; sending a replacement", error);
    }
  }
  const sent = await message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
  return sent.id;
}

async function editRecoveryNotice(
  message: Message,
  noticeMessageId: string,
  content: string,
  files: Array<{ attachment: Buffer | string; name: string; description?: string }>,
): Promise<{ id: string }> {
  try {
    const notice = await message.channel.messages?.fetch(noticeMessageId);
    if (notice) return await notice.edit({ content, ...(files.length ? { files } : {}), allowedMentions: { parse: [] } });
  } catch (error) {
    console.warn("retry result edit failed; sending a replacement", error);
  }
  return message.reply({ content, ...(files.length ? { files } : {}), allowedMentions: { parse: [], repliedUser: false } });
}

async function verifyExperience(memory: ExperienceMemory): Promise<boolean> {
  try {
    const channel = await client.channels.fetch(memory.channelId);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return false;
    const text = channel as TextChannel;
    if (text.guildId !== memory.guildId || !client.user || !text.permissionsFor(client.user.id)?.has(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory)) return false;
    const source = await text.messages.fetch(memory.sourceId);
    const valid = !source.author.bot && !source.flags.has(64) && source.guildId === memory.guildId && source.channelId === memory.channelId &&
      source.createdTimestamp === memory.at && source.content.includes(memory.quote);
    if (!valid) experiences.removeSource(memory.sourceId);
    return valid;
  } catch (error) {
    if ((error as { code?: number }).code === 10008) experiences.removeSource(memory.sourceId);
    return false;
  }
}

async function recallExperiences(message: Message, query: string): Promise<ExperienceMemory[]> {
  if (!await readableConversation(message)) return [];
  const found: ExperienceMemory[] = [];
  for (const memory of experiences.select(message.guildId!, message.channelId, query)) if (await verifyExperience(memory)) found.push(memory);
  return found;
}

client.on(Events.MessageDelete, message => { try { experiences.removeSource(message.id); } catch { console.error("experience deletion failed"); } });
client.on(Events.MessageBulkDelete, messages => { for (const message of messages.values()) { try { experiences.removeSource(message.id); } catch { console.error("experience deletion failed"); } } });

/** Lets a read-back tell the text we published from a text a person rewrote. */
const bodyHash = (body: string): string => createHash("sha256").update(body).digest("hex");

/** Explicit source-channel allowlist inside the primary guild. Private Knowledge sync needs this and a review. */
const knowledgeChannel = (memory: ExperienceMemory): boolean =>
  experienceKnowledgeChannels.has(memory.channelId) && (!primaryGuildId || memory.guildId === primaryGuildId);

async function noteGardenSyncFailure(status: string): Promise<void> {
  lastGardenSyncFailureAt = new Date().toISOString();
  lastGardenSyncFailureStatus = status;
  await reportIncidentImpl("decisiongarden_sync_failed", "warning", "DecisionGardenへのKnowledge同期に失敗", `status=${status}`);
}

async function noteGardenSyncSuccess(): Promise<void> {
  lastGardenSyncAt = new Date().toISOString();
  lastGardenSyncFailureAt = null;
  lastGardenSyncFailureStatus = null;
  await resolveIncidentImpl("decisiongarden_sync_failed");
}

async function noteGardenReadFailure(status: string): Promise<void> {
  lastGardenReadFailureAt = new Date().toISOString();
  lastGardenReadFailureStatus = status;
  await reportIncidentImpl("decisiongarden_read_failed", "warning", "DecisionGardenのKnowledge読戻しに失敗", `status=${status}`);
}

async function noteGardenReadSuccess(): Promise<void> {
  lastGardenReadAt = new Date().toISOString();
  lastGardenReadFailureAt = null;
  lastGardenReadFailureStatus = null;
  await resolveIncidentImpl("decisiongarden_read_failed");
}

const experienceLlm = async (messages: AgentMessage[]): Promise<string> => {
  return llmReliability.run(async ({ signal, requestId }) => {
    const response = await fetch(llmApiUrl, { method: "POST", headers: llmHeaders(requestId),
      body: JSON.stringify({ model: llmModel || undefined, messages, temperature: 0.1, max_tokens: 1500 }), signal });
    if (!response.ok) throw llmHttpError(response.status);
    return completionText(await response.json() as LlmCompletionBody);
  }, {
    priority: "background",
    attemptTimeoutMs: backgroundLlmAttemptTimeoutMs,
    totalTimeoutMs: backgroundLlmTotalTimeoutMs,
    affectsCircuit: false,
  });
};

export async function experienceTick(): Promise<void> {
  experiences.prune();
  await sweepDeletedEvidence();
  if (connpassEnabled) await connpass.refresh();
  await experiences.analyse(llmApiUrl ? experienceLlm : undefined);
  // Knowledge review runs before sync, and only for memories from an explicitly allowed source channel.
  await experiences.review(llmApiUrl ? experienceLlm : undefined, knowledgeChannel);
  await experiences.sync(async memory => {
    // A private Knowledge copy is only valid while its evidence still exists and remains readable to the bot.
    if (!await verifyExperience(memory)) return { outcome: "failed" };
    const publishable = publicExperience(memory);
    // No cleared summary means nothing may be stored; never fall back to a generic node.
    if (!publishable) return { outcome: "failed" };
    // The node id addresses exactly one Garden node, so nothing else in the Garden is ever read.
    // The baseline is our own last-write token: the Worker compares it and refuses rather than
    // overwriting when a person has edited the node since; it is never a freshly read token.
    const payload = { ...publishable,
      ...(memory.syncedUpdatedAt ? { baselineUpdatedAt: memory.syncedUpdatedAt } : {}),
      ...(memory.gardenNodeId ? { nodeId: memory.gardenNodeId } : {}) };
    // A conflict or a Garden failure answers with a non-2xx; the status still has to be read, not thrown away.
    let result: { synced?: boolean; status?: SyncOutcome; updatedAt?: string; nodeId?: string } | null;
    try {
      result = (await postSignedOutcome<{ synced?: boolean; status?: SyncOutcome; updatedAt?: string; nodeId?: string }>("/internal/experiences/sync", payload)).body;
    } catch {
      await noteGardenSyncFailure("failed");
      return { outcome: "failed" };
    }
    if (result?.synced === true) {
      await noteGardenSyncSuccess();
      return { outcome: "synced", updatedAt: result.updatedAt ?? null, nodeId: result.nodeId ?? null,
        bodyHash: bodyHash(publicExperienceBody(publishable).body) };
    }
    const status = result?.status;
    const waiting: Record<string, string> = {
      // An older Garden without an update tool is reported as waiting, never as a completed sync.
      update_unsupported: "Garden has no update tool yet", not_permitted: "Garden write access missing",
      conflict: "someone edited this node in the Garden", absent: "the Garden node is gone",
      awaiting_readback: "no baseline yet; reading the Garden copy back first",
      node_unknown: "published before node ids were tracked; archive or re-create it by hand",
    };
    if (status && waiting[status]) console.warn(`experience ${memory.threadId.slice(0, 8)} rev${memory.revision}: ${waiting[status]}; waiting`);
    if (!status || ["not_configured", "not_permitted", "update_unsupported", "failed"].includes(status)) await noteGardenSyncFailure(status ?? "failed");
    return { outcome: status && (waiting[status] || status === "not_configured") ? status as SyncOutcome : "failed" };
  }, knowledgeChannel,
    async entry => (await postSigned<{ retracted: boolean }>("/internal/experiences/retract", entry)).retracted === true);
  // A publish blocked only on a missing baseline is unblocked by reading the Garden copy now.
  await pullEditorNotes(Date.now(), experiences.awaitingReadback());
}

/**
 * Maintenance only: re-check a few memories per tick so evidence deleted while nothing was
 * being published is still noticed. verifyExperience drops the memory and queues its retraction.
 */
async function sweepDeletedEvidence(): Promise<void> {
  const memories = experiences.list();
  if (!memories.length) return;
  const offset = sweepCursor % memories.length;
  const batch = [...memories.slice(offset), ...memories.slice(0, offset)].slice(0, 5);
  sweepCursor = (offset + batch.length) % memories.length;
  for (const memory of batch) await verifyExperience(memory);
}

/** Bounded read-back of human edits: known threads only, and only as reference material. */
async function pullEditorNotes(now = Date.now(), force = false): Promise<void> {
  if (!force && now - lastExperiencePullAt < experiencePullMs) return;
  lastExperiencePullAt = now;
  // Only nodes we created, one bounded batch: the rest of the Garden is never read.
  const nodes = experiences.publishedNodes(experiencePullBatch, now);
  if (!nodes.length) return;
  const known = new Set(nodes.map(n => n.threadId));
  try {
    const result = await postSigned<{ status: string; covered?: string[]; notes?: Array<{ threadId: string; body: string; updatedAt: string }> }>(
      "/internal/experiences/pull", { nodes });
    // Only an authoritative answer may clear a cached note; a partial or failed read clears nothing.
    if (result.status !== "ok" || !Array.isArray(result.notes) || !Array.isArray(result.covered)) {
      await noteGardenReadFailure(result.status || "failed");
      return;
    }
    await noteGardenReadSuccess();
    const covered = result.covered.filter(id => known.has(id));
    experiences.applyEditorNotes(
      result.notes.filter(n => covered.includes(n.threadId)).map(n => ({ ...n, bodyHash: bodyHash(n.body) })),
      covered, now);
  } catch {
    await noteGardenReadFailure("failed");
    /* The Garden is optional context; conversation continues without it. */
  }
}

async function experienceForever(): Promise<void> {
  for (;;) {
    if (!lifecycle.draining) {
      try { await lifecycle.run(experienceTick); }
      catch { console.error("experience tick failed"); }
    }
    await sleep(60_000);
  }
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
    const provider = llmReliability.snapshot();
    const active = lifecycle.active > 0;
    const providerDegraded = modelPreflightError !== null || provider.state !== "healthy" ||
      slowMentionIds.size > 0 || llmHealthProbeFailures.count >= llmHealthProbeFailureThreshold;
    const body = {
      contract: "nexa.host.update.readiness/v1",
      decision: active ? "defer" : providerDegraded ? "degraded" : "ready",
      draining: lifecycle.draining,
      startupReady: startupReady && client.isReady(),
      pid: process.pid,
      release: process.env.SU_RELEASE_SHA ?? "unknown",
      queuedMessages: inbox.size,
      deadLetterMessages: inbox.deadLetterSize,
      reasonCode: active ? (slowMentionIds.size > 0 ? "llm_response_slow" : "active_work") : modelPreflightError ? "llm_model_unavailable" : providerDegraded ? "llm_degraded" : "idle",
      message: modelPreflightError ?? `${lifecycle.active} operations in progress`,
      activeWork: lifecycle.active,
      llm: {
        ...provider,
        model: llmModel || null,
        preflightError: modelPreflightError,
        slowMentions: slowMentionIds.size,
        consecutiveProbeFailures: llmHealthProbeFailures.count,
        probeFailureThreshold: llmHealthProbeFailureThreshold,
      },
      webSearch: {
        provider: "Google News RSS",
        scope: "news",
        lastSuccessAt: lastWebSearchAt,
        lastFailureAt: lastWebSearchFailureAt,
        lastFailureStatus: lastWebSearchFailureStatus,
      },
      knowledge: {
        ...experiences.snapshot(Date.now(), knowledgeChannel),
        configuredChannels: experienceKnowledgeChannels.size,
        sync: { lastSuccessAt: lastGardenSyncAt, lastFailureAt: lastGardenSyncFailureAt, lastFailureStatus: lastGardenSyncFailureStatus },
        readback: { lastSuccessAt: lastGardenReadAt, lastFailureAt: lastGardenReadFailureAt, lastFailureStatus: lastGardenReadFailureStatus },
      },
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

/**
 * Once a day around MAINTENANCE_HOUR_JST, ask the Worker for nightly maintenance.
 * This no longer produces a daily report: it only reads operational counts and posts nothing.
 */
async function maintenanceForever(): Promise<void> {
  for (;;) {
    if (lifecycle.draining) { await sleep(1000); continue; }
    try {
      const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1_000);
      const today = nowJst.toISOString().slice(0, 10);
      if (nowJst.getUTCHours() >= maintenanceHourJst && lastMaintenanceDate !== today) {
        await lifecycle.run(() => postSigned("/internal/maintenance/run", { hours: 24 }));
        await resolveIncidentImpl("maintenance_failed");
        writeSlot("digest-date", today);
        lastMaintenanceDate = today;
        console.log(`nightly maintenance requested for ${today}`);
      }
    } catch (error) {
      console.error("nightly maintenance failed", error);
      await reportIncident("maintenance_failed", "warning", "夜間の保守処理の実行に失敗", String(error));
    }
    await sleep(5 * 60 * 1_000);
  }
}

/** At each configured hour (JST), スー posts one musing to her channel. */
async function museForever(): Promise<void> {
  for (;;) {
    if (lifecycle.draining) { await sleep(1000); continue; }
    try {
      const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1_000);
      const hour = nowJst.getUTCHours();
      const slot = `${nowJst.toISOString().slice(0, 10)}T${hour}`;
      if (musingsChannelId && musingsHoursJst.includes(hour) && lastMusingSlot !== slot) {
        await postMusing(hour, false);
        await resolveIncidentImpl("musing_failed");
        writeSlot("musing-slot", slot);
        lastMusingSlot = slot;
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
    return "時間帯: 朝。朝の空や眠気を題材に、想像や問いとして話してよい。夜勤を終えたなど、実際の出来事は根拠なしに語らない。";
  }
  if (hourJst >= 10 && hourJst < 15) {
    return "時間帯: 昼。言葉の学びを題材に、想像や問いとして話してよい。今日の授業や他人との会話を作らない。";
  }
  if (hourJst >= 15 && hourJst < 21) {
    return "時間帯: 夕方。これから知りたいことを問いとして話してよい。誰かの来店や会話を作らない。";
  }
  return "時間帯: 深夜。静かな時間を題材にした想像や問い。実際にした作業や来店客の様子は根拠なしに語らない。";
}

export async function postMusingImpl(
  hourJst: number,
  force: boolean,
  topic?: string,
  channelId: string = musingsChannelId,
): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  const text = channel as TextChannel | null;
  if (!text || text.type !== ChannelType.GuildText) {
    throw new Error("Musing channel unavailable");
  }
  if (primaryGuildId && text.guildId !== primaryGuildId) throw new Error("Musing guild is not allowed");
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
    ...(topic ? [`頼まれた話題（これを材料にする）: ${topic}`] : []),
  ].join("\n");
  const startedAt = Date.now();
  const memories: ExperienceMemory[] = [];
  for (const memory of experiences.select(text.guildId, text.id, topic ?? "", true)) if (await verifyExperience(memory)) memories.push(memory);
  const sent = await deliverMusing({ background: material, memories, store: experiences,
    generate: input => generateReply("musing", input, "ja"),
    send: content => text.send({ content, allowedMentions: { parse: [] } }) });
  await logReply({
    event: "musing",
    guildId: text.guildId,
    channelId: text.id,
    messageId: sent.id,
    latencyMs: Date.now() - startedAt,
    ok: true,
    replyText: sent.text,
  });
}

let repliesSinceStart = 0;
let failuresSinceStart = 0;

function llmHeaders(requestId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-nexa-client": "su-gateway",
    "x-nexa-request-id": requestId,
    ...(llmApiKey ? { authorization: `Bearer ${llmApiKey}` } : {}),
  };
}

async function preflightConfiguredModel(): Promise<void> {
  if (!llmApiUrl || !llmModel) return;
  try {
    const url = new URL(llmApiUrl);
    url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, "/models");
    const response = await fetch(url, {
      headers: llmHeaders(`model-preflight-${randomUUID()}`),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.warn(`LLM model preflight unavailable: ${response.status}`);
      return;
    }
    const body = await response.json() as { data?: Array<{ id?: string }> };
    const available = (body.data ?? []).flatMap(item => item.id ? [item.id] : []);
    if (!available.includes(llmModel)) {
      modelPreflightError = `configured model ${llmModel} is not loaded`;
      await reportIncident(
        "llm_model_unavailable",
        "critical",
        "スーが指定しているLLMモデルが204にロードされていません",
        JSON.stringify({ configuredModel: llmModel, availableModels: available.slice(0, 20) }),
      );
      return;
    }
    modelPreflightError = null;
    await resolveIncidentImpl("llm_model_unavailable");
  } catch (error) {
    console.warn("LLM model preflight failed", error);
  }
}

async function providerWatchForever(): Promise<void> {
  let nextPeriodicProbeAt = 0;
  for (;;) {
    if (!lifecycle.draining) {
      const snapshot = llmReliability.snapshot();
      const state = snapshot.state;
      const periodicProbeDue = state === "healthy" && snapshot.active === 0 &&
        snapshot.queuedInteractive === 0 && snapshot.queuedBackground === 0 && Date.now() >= nextPeriodicProbeAt;
      if (modelPreflightError || state === "open" || state === "degraded" || periodicProbeDue) {
        await preflightConfiguredModel();
        // An open circuit is already the consequence of a reported primary
        // failure. Calling run() while its cooldown is active only produces a
        // local circuit_open rejection and a duplicate incident; wait for the
        // half-open window instead.
        if (!modelPreflightError && state !== "open") try {
          const probe = async (signal: AbortSignal, requestId: string): Promise<void> => {
            const response = await fetch(llmApiUrl, {
              method: "POST",
              headers: llmHeaders(requestId),
              body: JSON.stringify({
                model: llmModel || undefined,
                messages: [
                  { role: "system", content: "Return only the requested final answer." },
                  { role: "user", content: "Answer with the single word OK." },
                ],
                temperature: 0,
                // Reasoning tokens share this budget. The current model uses
                // roughly 45 tokens for this probe, so leave a bounded margin.
                max_tokens: 128,
              }),
              signal,
            });
            if (!response.ok) throw llmHttpError(response.status);
            completionText(await response.json() as LlmCompletionBody);
          };

          if (state === "degraded") {
            // After cooldown, one real final answer closes the shared circuit.
            await llmReliability.run(
              ({ signal, requestId }) => probe(signal, requestId),
              { priority: "background", maxAttempts: 1, attemptTimeoutMs: 90_000, totalTimeoutMs: 90_000 },
            );
          } else {
            // A synthetic periodic probe must not open the production circuit
            // or block customer work. Real requests own circuit state.
            nextPeriodicProbeAt = Date.now() + llmHealthProbeMs;
            await llmReliability.probe(
              ({ signal, requestId }) => probe(signal, requestId),
              { requestId: `health-${randomUUID()}`, timeoutMs: 90_000 },
            );
          }
          nextPeriodicProbeAt = Date.now() + llmHealthProbeMs;
          const probeRecovery = llmHealthProbeFailures.recordSuccess();
          if (probeRecovery.previousCount > 0) {
            console.log(`LLM health probe succeeded; reset ${probeRecovery.previousCount} consecutive failure(s)`);
          }
          await resolveIncidentImpl("llm_health_probe_failed");
          const requeued = inbox.requeueDeadLetters(20);
          if (requeued > 0) console.log(`LLM health probe recovered; requeued ${requeued} mention(s)`);
        } catch (error) {
          console.warn("LLM health probe still degraded", error);
          const normalized = normalizeLlmError(error);
          // Admission/backpressure errors describe this gateway's current
          // state, not a fresh provider failure. The primary incident and its
          // recovery remain the single operator-visible lifecycle.
          if (!["circuit_open", "circuit_half_open", "queue_full"].includes(normalized.code)) {
            const probeFailure = llmHealthProbeFailures.recordFailure();
            console.warn(
              `LLM health probe consecutive failure ${probeFailure.count}/${llmHealthProbeFailureThreshold}`,
            );
            if (probeFailure.shouldOpen) {
              await reportIncidentImpl(
                "llm_health_probe_failed",
                "error",
                `スーのLLM実応答ヘルスチェックが${llmHealthProbeFailureThreshold}回連続で失敗`,
                JSON.stringify({
                  model: llmModel || null,
                  code: normalized.code,
                  message: normalized.message,
                  consecutiveProbeFailures: probeFailure.count,
                  provider: llmReliability.snapshot(),
                }),
              );
            }
          }
        }
      }
    }
    await sleep(30_000);
  }
}

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

async function reportIncidentImpl(
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

async function resolveIncidentImpl(kind: string): Promise<void> {
  try {
    await postSigned("/internal/incidents/resolve", { kind, source: gatewayHost });
  } catch (error) {
    console.error("incident resolve failed", error);
  }
}

async function pollJobsForever(): Promise<void> {
  for (;;) {
    if (lifecycle.draining) { await sleep(1000); continue; }
    try {
      await lifecycle.run(async () => {
      const { jobs } = await postSigned<{ jobs: AiJob[] }>(
        "/internal/jobs/claim",
        {},
      );
      for (const job of jobs) {
        await processJob(job);
      }
      });
    } catch (error) {
      console.error("job poll failed", error);
    }
    if (lifecycle.draining) continue;
    try {
      await lifecycle.run(async () => {
      const { commands } = await postSigned<{
        commands: Array<{ id: string; kind: string; payload: Record<string, unknown> }>;
      }>("/internal/commands/claim", {});
      for (const command of commands) {
        await processCommand(command);
      }
      });
    } catch (error) {
      console.error("command poll failed", error);
    }
    await sleep(jobPollMs);
  }
}

/** Commands queued by the Worker (MCP: "muse now", "say this"). */
async function processCommandImpl(command: {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    if (command.kind === "muse") {
      const topic = typeof command.payload.topic === "string" ? command.payload.topic : undefined;
      const hour = new Date(Date.now() + 9 * 60 * 60 * 1_000).getUTCHours();
      const target = command.payload.channel === "ops" ? opsChannelId : musingsChannelId;
      await postMusing(hour, true, topic, target);
      await postSigned("/internal/commands/complete", { id: command.id, ok: true, result: "posted" });
      return;
    }
    if (command.kind === "say") {
      const target = command.payload.channel === "ops" ? opsChannelId : musingsChannelId;
      const text = typeof command.payload.text === "string" ? command.payload.text : "";
      const channel = (await client.channels.fetch(target)) as TextChannel | null;
      if (!channel || !text) {
        throw new Error("say: channel or text missing");
      }
      await channel.send({ content: truncate(text, 1_900), allowedMentions: { parse: [] } });
      await postSigned("/internal/commands/complete", { id: command.id, ok: true, result: "posted" });
      return;
    }
    throw new Error(`unknown command kind ${command.kind}`);
  } catch (error) {
    console.error(`command ${command.id} failed`, error);
    await postSigned("/internal/commands/complete", {
      id: command.id,
      ok: false,
      result: error instanceof Error ? error.message : String(error),
    });
  }
}

async function processJobImpl(job: AiJob): Promise<void> {
  const audit = { id: job.id, event: job.input && isQuizPrompt(job.input) ? "quiz" : job.mode, userId: job.requester_user_id ?? null, guildId: job.guild_id ?? null };
  auditConversation({ ...audit, phase: "received", input: job.input });
  let text: string;
  const startedAt = Date.now();
  inFlight += 1;

  try {
    if (!job.input) {
      throw new Error("job has no input");
    }
    text = await generateReply(job.mode, job.input);
  } catch (error) {
    auditConversation({ ...audit, phase: "generation_failed" });
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
    auditConversation({ ...audit, phase: "generated", response: truncate(text, 1_900) });
    await sendInteractionFollowUp(job, truncate(text, 1_900));
    auditConversation({ ...audit, phase: "sent" });
  } catch (error) {
    auditConversation({ ...audit, phase: "send_failed" });
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
    requesterUserId: job.requester_user_id,
    guildId: job.guild_id,
    latencyMs: Date.now() - startedAt,
    ok: true,
    replyText: text,
  });
  await resolveIncidentImpl("llm_unreachable");
  await resolveIncidentImpl("followup_failed");
  await postSigned("/internal/jobs/complete", { id: job.id, ok: true });
}

async function generateReply(event: SuEvent, input: string, language = detectLanguage(input)): Promise<string> {
  const raw = await generateRawReply(event, input, language);
  return isQuizPrompt(input) ? renderQuiz(parseRequestedQuiz(raw, input)) : raw;
}

async function generateRawReply(
  event: SuEvent,
  input: string,
  language = detectLanguage(input),
): Promise<string> {
  if (!llmApiUrl) {
    throw new Error("LLM_API_URL is not configured");
  }

  const systemPrompt = isQuizPrompt(input) ? QUIZ_SYSTEM_PROMPT : buildSystemPrompt(event, language, { pitcheeeUrl });

  const requestBody = JSON.stringify({
    model: llmModel || undefined,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: input },
    ],
    temperature: 0.4,
    // Reasoning tokens are billed to this budget without being returned as
    // content, so too tight a cap comes back as an empty reply rather than a
    // short one. See the same note in quiz-runner.ts.
    max_tokens: 2_000,
  });

  const background = event === "musing";
  return llmReliability.run(async ({ signal, requestId }) => {
    const response = await fetch(llmApiUrl, {
      method: "POST",
      headers: llmHeaders(requestId),
      body: requestBody,
      signal,
    });
    if (!response.ok) throw llmHttpError(response.status);
    return completionText(await response.json() as LlmCompletionBody);
  }, {
    priority: background ? "background" : "interactive",
    ...(background ? {
      attemptTimeoutMs: backgroundLlmAttemptTimeoutMs,
      totalTimeoutMs: backgroundLlmTotalTimeoutMs,
      affectsCircuit: false,
    } : {}),
  });
}

async function sendInteractionFollowUp(
  job: AiJob,
  content: string,
): Promise<void> {
  const response = await fetch(
    `https://discord.com/api/v10/webhooks/${job.application_id}/${job.interaction_token}?wait=true`,
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
  if (job.input && isQuizPrompt(job.input) && !job.ephemeral) {
    const message = await response.json() as { id: string; channel_id: string };
    // Delivery has succeeded: reaction failure must never trigger a second reply.
    await seedQuizReactions(content, message, token).catch(error => {
      console.error("quiz reaction seeding failed", error);
    });
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

/** Same signed call, but the caller sees the status instead of an exception. */
async function postSignedOutcome<T = unknown>(path: string, payload: unknown): Promise<{ status: number; body: T | null }> {
  const response = await signedRequest(path, payload);
  try { return { status: response.status, body: (await response.json()) as T }; }
  catch { return { status: response.status, body: null }; }
}

async function postSigned<T = unknown>(
  path: string,
  payload: unknown,
): Promise<T> {
  const response = await signedRequest(path, payload);
  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(
      `Worker ${path} returned ${response.status}: ${responseText.slice(0, 500)}`,
    );
  }
  return (await response.json()) as T;
}

async function signedRequest(path: string, payload: unknown): Promise<Response> {
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
    signal: AbortSignal.timeout(30000),
  });

  return response;
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

for (const signal of ["SIGINT", "SIGTERM", "SIGUSR2"] as const) {
  process.on(signal, () => {
    lifecycle.drain();
    voiceChat.stop();
    console.log(`draining: signal=${signal} active=${lifecycle.active} queued=${inbox.size}`);
  });
}
setInterval(() => {
  if (lifecycle.draining && lifecycle.active === 0) {
    client.destroy();
    console.log("drain complete; queued requests retained");
    process.exit(0);
  }
}, 250);

async function catchUpMessages(): Promise<void> {
  const after = ((BigInt(Math.max(1420070400000, inbox.onlineAt - 10000)) - 1420070400000n) << 22n).toString();
  for (const channelId of new Set([...monitoredChannelIds, musingsChannelId].filter(Boolean))) {
    const channel = await client.channels.fetch(channelId) as TextChannel | null;
    if (!channel?.messages) continue;
    let cursor: string | undefined;
    for (;;) {
      const messages = await channel.messages.fetch(cursor ? { before: cursor, limit: 100 } : { limit: 100 });
      const ordered = [...messages.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
      for (const message of ordered) {
        if (BigInt(message.id) > BigInt(after) && !message.author.bot) inbox.add(channelId, message.id);
      }
      const last = ordered.at(0);
      if (!last || BigInt(last.id) <= BigInt(after) || last.id === cursor || messages.size < 100) break;
      cursor = last.id;
    }
  }
  inbox.heartbeat();
  console.log(`inbox recovery complete; queued=${inbox.size}`);
}

async function replayInboxForever(): Promise<void> {
  const replayingMessageIds = new Set<string>();
  for (;;) {
    if (!lifecycle.draining) {
      const ready = inbox.items().filter(item => !replayingMessageIds.has(item.messageId)).slice(0, 20);
      await Promise.allSettled(ready.map(async item => {
        replayingMessageIds.add(item.messageId);
        try {
          await lifecycle.run(async () => {
            const channel = await client.channels.fetch(item.channelId) as TextChannel | null;
            if (!channel?.messages) throw new Error("inbox channel unavailable");
            const message = await channel.messages.fetch(item.messageId);
            const outcome = await onMessageImpl(message, item);
            if (outcome?.status === "deferred") {
              inbox.defer(item.messageId, {
                delayMs: mentionRetryDelayMs,
                ...(outcome.noticeMessageId ? { noticeMessageId: outcome.noticeMessageId } : {}),
                ...(outcome.error ? { error: outcome.error } : {}),
                ...(outcome.countAttempt === undefined ? {} : { countAttempt: outcome.countAttempt }),
              });
            } else if (outcome?.status === "failed") {
              inbox.fail(item.messageId, outcome.error);
            } else {
              inbox.remove(item.messageId);
            }
          });
        } catch (error) {
          if ((error as { code?: number }).code === 10008) inbox.remove(item.messageId);
          else console.error("inbox replay failed", error);
        } finally {
          replayingMessageIds.delete(item.messageId);
        }
      }));
    }
    await sleep(5000);
  }
}

const postMusing = (...args: Parameters<typeof postMusingImpl>): ReturnType<typeof postMusingImpl> => lifecycle.run(() => postMusingImpl(...args));

const processJob = (...args: Parameters<typeof processJobImpl>): ReturnType<typeof processJobImpl> => lifecycle.run(() => processJobImpl(...args));

const processCommand = (...args: Parameters<typeof processCommandImpl>): ReturnType<typeof processCommandImpl> => lifecycle.run(() => processCommandImpl(...args));

const reportIncident = (...args: Parameters<typeof reportIncidentImpl>): ReturnType<typeof reportIncidentImpl> => lifecycle.run(() => reportIncidentImpl(...args));

const resolveIncident = (...args: Parameters<typeof resolveIncidentImpl>): ReturnType<typeof resolveIncidentImpl> => lifecycle.run(() => resolveIncidentImpl(...args));

await client.login(token);
