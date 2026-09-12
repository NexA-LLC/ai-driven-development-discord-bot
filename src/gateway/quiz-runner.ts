import { seedQuizReactions } from "../shared/quiz-reactions.js";
import { buildQuizPrompt, parseQuiz, renderQuiz, type QuizDraft } from "../shared/quiz.js";
import { readSlot, writeSlot } from "./schedule-state.js";
import { lifecycle } from "./lifecycle.js";
import { createHmac } from "node:crypto";

interface NewsItem {
  title: string;
  link: string;
  publishedAt?: string;
}

const token = process.env.DISCORD_BOT_TOKEN?.trim() || "";
const workerInternalUrl = process.env.WORKER_INTERNAL_URL?.trim() || "";
const sharedSecret = process.env.INTERNAL_SHARED_SECRET?.trim() || "";
const llmApiUrl = process.env.LLM_API_URL?.trim() || "";
const llmModel = process.env.LLM_MODEL?.trim() || "";
const llmApiKey = process.env.LLM_API_KEY?.trim() || "";
const llmTimeoutMs = readPositiveInteger("LLM_TIMEOUT_SECONDS", 120) * 1_000;
const quizChannelId =
  process.env.QUIZ_CHANNEL_ID?.trim() || process.env.MUSINGS_CHANNEL_ID?.trim() || "";
const quizHourJst = readHour("QUIZ_HOUR_JST", 20);
const quizOnStart = readBoolean("QUIZ_ON_START", false);
const quizEnabled = readBoolean("QUIZ_ENABLED", true);
const communityPrompts = (process.env.QUIZ_COMMUNITY_PROMPTS ?? "")
  .split("|")
  .map((value) => value.trim())
  .filter(Boolean);
const newsQuery =
  process.env.QUIZ_NEWS_QUERY?.trim() ||
  "AI OR OpenAI OR Anthropic OR Claude OR Gemini OR LLM when:1d";

let lastQuizDate = readSlot("quiz-date");

if (!quizEnabled) {
  console.log("quiz runner disabled (QUIZ_ENABLED=false)");
} else if (!token || !quizChannelId || !llmApiUrl) {
  console.warn(
    `quiz runner idle: token=${Boolean(token)} channel=${Boolean(quizChannelId)} llm=${Boolean(llmApiUrl)}`,
  );
} else {
  if (quizOnStart) {
    void postDailyQuiz(true).catch((error) =>
      console.error("startup quiz failed", error),
    );
  }
  void quizForever();
}

async function quizForever(): Promise<void> {
  for (;;) {
    try {
      const nowJst = jstNow();
      const today = nowJst.toISOString().slice(0, 10);
      if (nowJst.getUTCHours() === quizHourJst && lastQuizDate !== today) {
        await postDailyQuiz(false);
      }
    } catch (error) {
      console.error("daily quiz failed", error);
    }
    await sleep(5 * 60 * 1_000);
  }
}

function postDailyQuiz(force: boolean): Promise<void> {
  if (lifecycle.draining) return Promise.resolve();
  return lifecycle.run(() => postDailyQuizImpl(force));
}

async function postDailyQuizImpl(force: boolean): Promise<void> {
  const today = jstNow().toISOString().slice(0, 10);
  if (!force && lastQuizDate === today) {
    return;
  }

  const draft = await buildQuiz(today);
  const content = renderQuiz(draft);
  const message = await sendDiscordMessage(quizChannelId, content);
  lastQuizDate = today;
  writeSlot("quiz-date", today);
  await seedQuizReactions(content, { id: message.id, channel_id: quizChannelId }, token);

  lastQuizDate = today;
  await logQuizMessage(message.id, content).catch((error) =>
    console.warn("quiz log failed", error),
  );
  console.log(`daily quiz posted ${today} message=${message.id} type=${draft.type}`);
}

async function buildQuiz(today: string): Promise<QuizDraft> {
  const news = await fetchAiNews().catch((error) => {
    console.warn("AI news fetch failed", error);
    return [] as NewsItem[];
  });

  const useCommunity =
    communityPrompts.length > 0 && dayNumber(today) % 3 === 0;
  const communitySeed = useCommunity
    ? communityPrompts[dayNumber(today) % communityPrompts.length]
    : undefined;

  const material = communitySeed
    ? [
        "今日はコミュニティ内の未来予測を1問作る。",
        `種: ${communitySeed}`,
        "答えはまだ確定していなくてよい。4つの選択肢は時間帯・起きること・程度など、互いに排他的にする。",
      ].join("\n")
    : [
        "以下は直近24時間のAI関連ニュース見出し。ここからDiscordで答えたくなる1問を作る。",
        ...news.slice(0, 10).map((item, index) => `${index + 1}. ${item.title}`),
        "単なる暗記より、何が起きたか・次に何が起きそうか・開発者への影響のどれかを問う。",
      ].join("\n");

  const prompt = buildQuizPrompt(material);

  // The local model sometimes answers in Chinese or returns unusable JSON, and
  // parseQuiz rejects both. Retry within this run so one bad draft does not cost
  // the whole day's quiz; quizForever still re-checks on the next tick.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return parseQuiz(await callLlm(prompt), news);
    } catch (error) {
      lastError = error;
      console.warn(`quiz draft attempt ${attempt} rejected`, error);
    }
  }
  throw lastError;
}

async function fetchAiNews(): Promise<NewsItem[]> {
  const params = new URLSearchParams({
    q: newsQuery,
    hl: "ja",
    gl: "JP",
    ceid: "JP:ja",
  });
  const response = await fetch(`https://news.google.com/rss/search?${params.toString()}`, {
    headers: { "user-agent": "ai-driven-development-discord-bot/0.1" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Google News RSS returned ${response.status}`);
  }
  const xml = await response.text();
  const items: NewsItem[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = match[1] ?? "";
    const title = extractXmlTag(block, "title");
    const link = extractXmlTag(block, "link");
    const publishedAt = extractXmlTag(block, "pubDate");
    if (title && link) {
      items.push({ title: decodeXml(title), link: decodeXml(link), publishedAt });
    }
    if (items.length >= 15) {
      break;
    }
  }
  if (items.length === 0) {
    throw new Error("Google News RSS returned no parseable items");
  }
  return items;
}

function extractXmlTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`));
  return match?.[1]?.trim() ?? "";
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function callLlm(prompt: string): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (llmApiKey) {
    headers.authorization = `Bearer ${llmApiKey}`;
  }
  const response = await fetch(llmApiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: llmModel || undefined,
      messages: [
        {
          role: "system",
          content:
            "あなたはDiscordコミュニティの編集者。短く、具体的で、4択が重複しない問いを作る。questionとchoicesは必ず日本語で書く。JSON以外を返さない。",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.6,
      // Reasoning tokens count against this budget and are not returned as
      // content, so a model that deliberates for a while can spend the whole
      // allowance and hand back an empty message. The quiz JSON itself is under
      // 100 tokens; the headroom is for the thinking in front of it.
      max_tokens: 2_000,
    }),
    signal: AbortSignal.timeout(llmTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`LLM API returned ${response.status}`);
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  };
  const choice = body.choices?.[0];
  const text = choice?.message?.content?.trim();
  if (!text) {
    throw new Error(
      choice?.finish_reason === "length"
        ? "LLM spent the whole token budget on reasoning and returned no quiz JSON"
        : "LLM returned no quiz JSON",
    );
  }
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

async function sendDiscordMessage(
  channelId: string,
  content: string,
): Promise<{ id: string }> {
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bot ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (!response.ok) {
    throw new Error(`Discord message returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const body = (await response.json()) as { id?: string };
  if (!body.id) {
    throw new Error("Discord message response had no id");
  }
  return { id: body.id };
}

async function logQuizMessage(messageId: string, content: string): Promise<void> {
  if (!workerInternalUrl || !sharedSecret) {
    return;
  }
  await postSigned("/internal/reply-logs", {
    event: "quiz",
    channelId: quizChannelId,
    messageId,
    provider: "gateway-quiz",
    model: llmModel || null,
    ok: true,
    replyText: content,
  });
}

async function postSigned(path: string, payload: unknown): Promise<void> {
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
    throw new Error(`Worker ${path} returned ${response.status}`);
  }
}

function jstNow(): Date {
  return new Date(Date.now() + 9 * 60 * 60 * 1_000);
}

function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  if (raw === "1" || raw === "true") {
    return true;
  }
  if (raw === "0" || raw === "false") {
    return false;
  }
  throw new Error(`${name} must be true/false or 1/0`);
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function readHour(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 23) {
    throw new Error(`${name} must be an integer from 0 to 23`);
  }
  return value;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
