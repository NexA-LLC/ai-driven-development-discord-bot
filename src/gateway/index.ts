import { VoiceChat } from "./voice-chat.js";
import { parseVoiceDecision, VOICE_RESPONSE_FORMAT } from "./voice-audio.js";
import { isAudioAttachment, transcribeAudio, synthesizeSpeech } from "./audio.js";
import { resolve } from "node:path";
import { postChannelMessage } from "./channel-post.js";
import { runMentionAgent, mentionTools, type AgentMessage } from "./mention-agent.js";
import { readMentionedChannels } from "./channel-context.js";
import { startTyping } from "./typing.js";
import { seedQuizReactions } from "../shared/quiz-reactions.js";
import { isQuizPrompt, parseRequestedQuiz, parseQuiz, renderQuiz, QUIZ_SYSTEM_PROMPT } from "../shared/quiz.js";
import { readSlot, writeSlot } from "./schedule-state.js";
import { lifecycle } from "./lifecycle.js";
import { auditConversation } from "./conversation-audit.js";
import { inbox } from "./inbox.js";
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
let lastDigestDate = readSlot("digest-date");
const readinessPort = readPositiveInteger("READINESS_PORT", 8790);
const gatewayHost = process.env.GATEWAY_HOST_LABEL?.trim() || "gateway";

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
const voiceChat = new VoiceChat(client, async (text, history) => {
  const response = await fetch(llmApiUrl, {
    method: "POST", headers: { "content-type": "application/json", ...(llmApiKey ? { authorization: `Bearer ${llmApiKey}` } : {}) },
    body: JSON.stringify({ model: llmModel || undefined, response_format: VOICE_RESPONSE_FORMAT, max_tokens: 700,
      messages: [{ role: "system", content: buildSystemPrompt("mention", "ja", { pitcheeeUrl }) + '\n音声通話中です。聞き取りは誤認識の可能性があります。応答はJSONだけで {"action":"reply|leave|ignore","text":"読み上げる自然な日本語、300文字以内"}。利用者の意図を判断して、退室依頼はleave、無音・雑音・意味不明な認識結果はignore、それ以外の会話はreply。返答は1〜3文で短く。読み上げに不向きなMarkdownやURLを入れない。通話以外の外部操作は実行できないので実行済みと主張しない。' }, ...history, { role: "user", content: text }],
    }), signal: AbortSignal.timeout(llmTimeoutMs),
  });
  if (!response.ok) throw new Error(`Voice LLM returned ${response.status}`);
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return parseVoiceDecision(body.choices?.[0]?.message?.content ?? "");
});
let startupReady = false;
let inFlight = 0;
let lastMusingSlot = readSlot("musing-slot");
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
  while (!lifecycle.draining) {
    try { await lifecycle.run(catchUpMessages); startupReady = true; break; }
    catch (error) { console.error("inbox recovery blocked", error); await sleep(5000); }
  }
  void replayInboxForever();
  setInterval(() => { if (client.isReady() && !lifecycle.draining) inbox.heartbeat(); }, 5000);
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

async function onMessageImpl(message: Message): Promise<void> {
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

  const audioAttachments = [...message.attachments.values()].filter(isAudioAttachment);
  const audioAddressed = audioAttachments.length > 0 && (inMusings || repliedToSu || message.mentions.has(botUser));
  if (!message.mentions.has(botUser) && !audioAddressed) {
    return;
  }

  if (!inMonitoredChannel && !allowMentionsAnywhere && !inMusings) {
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
    const startedAt = Date.now();
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
          const response = await fetch(llmApiUrl, {
            method: "POST",
            headers: { "content-type": "application/json", ...(llmApiKey ? { authorization: `Bearer ${llmApiKey}` } : {}) },
            body: JSON.stringify({ model: llmModel || undefined, messages, tools: mentionTools, tool_choice: allowTools ? "auto" : "none", temperature: 0.4, max_tokens: 1200 }),
            signal: AbortSignal.timeout(llmTimeoutMs),
          });
          if (!response.ok) throw new Error(`Agent LLM returned ${response.status}`);
          const body = await response.json() as { choices?: Array<{ message?: AgentMessage }> };
          const answer = body.choices?.[0]?.message;
          if (!answer) throw new Error("Agent LLM returned no message");
          return answer;
        },
        async (name, args) => {
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
          if (name === "post_channel_message") return postChannelMessage(message, args);
          const id = (args as { channel_id?: unknown } | null)?.channel_id;
          const allowed = [...message.content.matchAll(/<#(\d+)>/g)].map(match => match[1]);
          if (typeof id !== "string" || !allowed.includes(id)) throw new Error("ユーザーが今回指定したチャンネルのみ参照できます");
          const result = await readMentionedChannels(message, [id]);
          return result?.context ? JSON.parse(result.context) : { status: result?.status ?? "参照できませんでした" };
        },
        event => auditConversation({ ...audit, phase: event.phase, ...(event.tool ? { tool: event.tool } : {}), ...(event.ok === undefined ? {} : { ok: event.ok }) }),
      );
    } catch (error) {
      ok = false;
      console.error("mention agent failed", error);
      text = audioAddressed ? "すみません、音声を処理できませんでした。8MB以下・2分以内の音声を1件ずつ送るか、文字でお願いします。" : "すみません、今は依頼を完了できませんでした。少し時間を置いて再度お願いします。";
    } finally {
      inFlight -= 1;
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
    const sent = await message.reply({
      content: truncate(text, 1_900),
      ...(files.length ? { files } : {}),
      allowedMentions: {
        parse: [],
        repliedUser: false,
      },
    });
    auditConversation({ ...audit, phase: "sent", messageId: sent.id });
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
  } finally {
    stopTyping();
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
    const body = {
      contract: "nexa.host.update.readiness/v1",
      decision: lifecycle.active > 0 ? "defer" : "ready",
      draining: lifecycle.draining,
      startupReady: startupReady && client.isReady(),
      pid: process.pid,
      release: process.env.SU_RELEASE_SHA ?? "unknown",
      queuedMessages: inbox.size,
      reasonCode: lifecycle.active > 0 ? "active_work" : "idle",
      message: `${lifecycle.active} operations in progress`,
      activeWork: lifecycle.active,
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
    if (lifecycle.draining) { await sleep(1000); continue; }
    try {
      const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1_000);
      const today = nowJst.toISOString().slice(0, 10);
      if (nowJst.getUTCHours() === digestHourJst && lastDigestDate !== today) {
        lastDigestDate = today;
        writeSlot("digest-date", today);
        await lifecycle.run(() => postSigned("/internal/digest/run", { hours: 24 }));
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
    if (lifecycle.draining) { await sleep(1000); continue; }
    try {
      const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1_000);
      const hour = nowJst.getUTCHours();
      const slot = `${nowJst.toISOString().slice(0, 10)}T${hour}`;
      if (musingsChannelId && musingsHoursJst.includes(hour) && lastMusingSlot !== slot) {
        lastMusingSlot = slot;
        writeSlot("musing-slot", slot);
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

async function postMusingImpl(
  hourJst: number,
  force: boolean,
  topic?: string,
  channelId: string = musingsChannelId,
): Promise<void> {
  const channel = await client.channels.fetch(channelId);
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
    ...(topic ? [`頼まれた話題（これを材料にする）: ${topic}`] : []),
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
    signal: AbortSignal.timeout(30000),
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
  for (;;) {
    if (!lifecycle.draining) {
      for (const item of inbox.items()) {
        if (lifecycle.draining) break;
        try {
          await lifecycle.run(async () => {
            const channel = await client.channels.fetch(item.channelId) as TextChannel | null;
            if (!channel?.messages) throw new Error("inbox channel unavailable");
            const message = await channel.messages.fetch(item.messageId);
            await onMessage(message);
            inbox.remove(item.messageId);
          });
        } catch (error) {
          if ((error as { code?: number }).code === 10008) inbox.remove(item.messageId);
          else console.error("inbox replay failed", error);
        }
      }
    }
    await sleep(5000);
  }
}

const onMessage = (...args: Parameters<typeof onMessageImpl>): ReturnType<typeof onMessageImpl> => lifecycle.run(() => onMessageImpl(...args));

const postMusing = (...args: Parameters<typeof postMusingImpl>): ReturnType<typeof postMusingImpl> => lifecycle.run(() => postMusingImpl(...args));

const processJob = (...args: Parameters<typeof processJobImpl>): ReturnType<typeof processJobImpl> => lifecycle.run(() => processJobImpl(...args));

const processCommand = (...args: Parameters<typeof processCommandImpl>): ReturnType<typeof processCommandImpl> => lifecycle.run(() => processCommandImpl(...args));

const reportIncident = (...args: Parameters<typeof reportIncidentImpl>): ReturnType<typeof reportIncidentImpl> => lifecycle.run(() => reportIncidentImpl(...args));

await client.login(token);
