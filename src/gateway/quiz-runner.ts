import { createHmac } from "node:crypto";

interface NewsItem {
  title: string;
  link: string;
  publishedAt?: string;
}

interface QuizDraft {
  type: "knowledge" | "prediction" | "opinion";
  question: string;
  choices: [string, string, string, string];
  sourceTitle?: string | undefined;
}

const token = process.env.DISCORD_BOT_TOKEN?.trim() || "";
const workerInternalUrl = process.env.WORKER_INTERNAL_URL?.trim() || "";
const sharedSecret = process.env.INTERNAL_SHARED_SECRET?.trim() || "";
const llmApiUrl = process.env.LLM_API_URL?.trim() || "";
const llmModel = process.env.LLM_MODEL?.trim() || "";
const llmApiKey = process.env.LLM_API_KEY?.trim() || "";
const llmTimeoutMs = readPositiveInteger("LLM_TIMEOUT_SECONDS", 120) * 1_000;
// Reasoning models spend most of their budget before the first content token,
// so this has to be well above the ~150 tokens the quiz JSON itself needs.
const llmMaxTokens = readPositiveInteger("QUIZ_MAX_TOKENS", 1_400);
const quizChannelId =
  process.env.QUIZ_CHANNEL_ID?.trim() || process.env.MUSINGS_CHANNEL_ID?.trim() || "";
const quizHourJst = readHour("QUIZ_HOUR_JST", 20);
const quizOnStart = readBoolean("QUIZ_ON_START", false);
const quizEnabled = readBoolean("QUIZ_ENABLED", true);
const quizDryRun = readBoolean("QUIZ_DRY_RUN", false);
const communityPrompts = (process.env.QUIZ_COMMUNITY_PROMPTS ?? "")
  .split("|")
  .map((value) => value.trim())
  .filter(Boolean);
const newsQuery =
  process.env.QUIZ_NEWS_QUERY?.trim() ||
  "AI OR OpenAI OR Anthropic OR Claude OR Gemini OR LLM when:1d";

let lastQuizDate = "";

if (!quizEnabled) {
  console.log("quiz runner disabled (QUIZ_ENABLED=false)");
} else if (quizDryRun) {
  void printDryRunQuiz();
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

// QUIZ_DRY_RUN builds one quiz and prints it instead of posting to Discord, so
// a prompt or model change can be checked without spending a community post.
async function printDryRunQuiz(): Promise<void> {
  if (!llmApiUrl) {
    console.error("QUIZ_DRY_RUN needs LLM_API_URL");
    process.exitCode = 1;
    return;
  }
  try {
    const draft = await buildQuiz(jstNow().toISOString().slice(0, 10));
    console.log(`--- dry run (type=${draft.type}, nothing posted) ---`);
    console.log(renderQuiz(draft));
  } catch (error) {
    console.error("dry run quiz failed", error);
    process.exitCode = 1;
  }
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

async function postDailyQuiz(force: boolean): Promise<void> {
  const today = jstNow().toISOString().slice(0, 10);
  if (!force && lastQuizDate === today) {
    return;
  }

  const draft = await buildQuiz(today);
  const content = renderQuiz(draft);
  const message = await sendDiscordMessage(quizChannelId, content);
  for (const emoji of ["1️⃣", "2️⃣", "3️⃣", "4️⃣"]) {
    await addDiscordReaction(quizChannelId, message.id, emoji);
  }

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

  const basePrompt = [
    "AI開発者コミュニティ向けの4択クイズ/予測を1問だけ作ってください。",
    "questionとchoicesは必ず日本語で書く。中国語や英語の文で書かない。",
    "回答はDiscordの1️⃣2️⃣3️⃣4️⃣リアクションで行います。",
    "出力はJSONだけ。Markdownコードブロックは禁止。",
    'schema: {"type":"knowledge|prediction|opinion","question":"...","choices":["...","...","...","..."],"sourceTitle":"任意"}',
    "choicesは必ず4個、各40文字以内。questionは120文字以内。",
    "knowledgeでも正解番号は出力しない。ここでは集合知を取るのが目的。",
    "predictionは将来に解決可能な問いを優先。opinionは好みではなく実務判断を優先。",
    material,
  ].join("\n\n");

  // Reasoning models drift into Chinese or English on this prompt, and a
  // wrong-language post into a Japanese channel is worse than skipping a day.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt =
      attempt === 1
        ? basePrompt
        : `${basePrompt}\n\n直前の出力は日本語ではありませんでした。questionとchoicesを、ひらがなとカタカナを含む自然な日本語で書き直してください。`;
    try {
      const draft = parseQuiz(await callLlm(prompt), news);
      if (isJapanese(draft)) {
        return draft;
      }
      lastError = new Error("quiz was not written in Japanese");
      console.warn(`quiz attempt ${attempt} was not Japanese`);
    } catch (error) {
      lastError = error;
      console.warn(`quiz attempt ${attempt} failed`, error);
    }
  }
  throw lastError ?? new Error("quiz generation failed");
}

function isJapanese(quiz: QuizDraft): boolean {
  // Kana only: CJK ideographs alone cannot tell Japanese from Chinese.
  return /[぀-ヿ]/.test([quiz.question, ...quiz.choices].join(" "));
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
            "あなたは日本語のDiscordコミュニティの編集者。短く、具体的で、4択が重複しない問いを日本語で作る。JSON以外を返さない。",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.6,
      max_tokens: llmMaxTokens,
    }),
    signal: AbortSignal.timeout(llmTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`LLM API returned ${response.status}`);
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("LLM returned no quiz JSON");
  }
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function parseQuiz(raw: string, news: NewsItem[]): QuizDraft {
  const jsonText = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const parsed = JSON.parse(jsonText) as Partial<QuizDraft> & { choices?: unknown };
  const type =
    parsed.type === "prediction" || parsed.type === "opinion" || parsed.type === "knowledge"
      ? parsed.type
      : "prediction";
  const question = String(parsed.question ?? "").trim();
  const choices = Array.isArray(parsed.choices)
    ? parsed.choices.map((value) => String(value).trim()).filter(Boolean)
    : [];
  if (!question || choices.length !== 4 || new Set(choices).size !== 4) {
    throw new Error("quiz JSON was invalid or choices were not unique");
  }
  const sourceTitle =
    typeof parsed.sourceTitle === "string" && parsed.sourceTitle.trim()
      ? parsed.sourceTitle.trim()
      : news[0]?.title;
  return {
    type,
    question: truncate(question, 120),
    choices: choices.map((choice) => truncate(choice, 40)) as [string, string, string, string],
    sourceTitle,
  };
}

function renderQuiz(quiz: QuizDraft): string {
  const label =
    quiz.type === "prediction"
      ? "🔮 今日のAI予測"
      : quiz.type === "opinion"
        ? "🧠 今日のAI判断"
        : "📰 今日のAIクイズ";
  const lines = [
    `**${label}**`,
    "",
    quiz.question,
    "",
    `1️⃣ ${quiz.choices[0]}`,
    `2️⃣ ${quiz.choices[1]}`,
    `3️⃣ ${quiz.choices[2]}`,
    `4️⃣ ${quiz.choices[3]}`,
    "",
    "リアクションで1つ選んでください。",
  ];
  if (quiz.sourceTitle && quiz.type !== "opinion") {
    lines.push(`元ネタ: ${truncate(quiz.sourceTitle, 120)}`);
  }
  return truncate(lines.join("\n"), 1_900);
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

async function addDiscordReaction(
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  const response = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    {
      method: "PUT",
      headers: { authorization: `Bot ${token}` },
    },
  );
  if (!response.ok) {
    throw new Error(`Discord reaction returned ${response.status}`);
  }
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
