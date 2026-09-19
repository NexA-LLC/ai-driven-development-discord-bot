const DEFAULT_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"] as const;
const QUIZ_EMOJIS = ["🚀", "📈", "➡️", "📉", "🔥", "🌱", "☕", "🧊", "🦀", "🦐", "🍖", "🐟", "🍎", "🍰", "🍜", "🍚", "🥗", "🍵", "🤝", "⚖️", "🤔", "🙅", "👍", "👎", "❤️", "💤", "💡", "🔧", "💻", "🤖", "🧠", "🎨", "📚", "🔬", "🔒", "🌍", "🏠", "🏢", "💰", "⏰", "⚡", "🐢", "🎯", "🎮", "🎵", "👀", "🛡️", "🧪", "☀️", "🌧️", "🌙", "⭐", "✅", "❌"] as const;

/**
 * The local model sometimes answers our Japanese prompt entirely in Chinese.
 * Kana is the reliable separator: Chinese writing has none, and a whole quiz
 * written in Japanese effectively always contains some. Text with no Han
 * characters at all (a plain ASCII product name, say) is left alone.
 */
const KANA = /[\u3041-\u309F\u30A0-\u30FF]/u;
const HAN = /[\u3400-\u4DBF\u4E00-\u9FFF]/u;

export function isNonJapanese(text: string): boolean {
  return HAN.test(text) && !KANA.test(text);
}

/** Use one validated set for both visible choices and Discord reactions. */
export function quizEmojis(quiz: { emojis?: unknown }): [string, string, string, string] {
  const values = quiz.emojis;
  if (Array.isArray(values) && values.length === 4 &&
      values.every(value => typeof value === "string" && (QUIZ_EMOJIS as readonly string[]).includes(value)) &&
      new Set(values).size === 4) {
    return [...values] as [string, string, string, string];
  }
  return [...DEFAULT_EMOJIS];
}

export const QUIZ_SYSTEM_PROMPT = "あなたはDiscordコミュニティの編集者。指定された問いを尊重し、投票したくなる4択を作る。questionとchoicesは必ず日本語で書く。正解・解説は付けない。JSON以外を返さない。";

export function isQuizPrompt(input: string): boolean {
  return input.startsWith("日本語で4択クイズ/予測/投票を1問だけ作ってください。");
}

export function buildQuizPrompt(topic?: string): string {
  return [
    "日本語で4択クイズ/予測/投票を1問だけ作ってください。",
    "日次クイズと同じく、みんなの意見・好み・未来予測を集める投票です。正解・採点・解説・伏せ字は一切出しません。",
    "questionとchoicesは必ず日本語で書いてください。中国語や英語だけで書かれた出力は破棄されます。製品名・人名などの固有名詞はそのままで構いません。",
    "入力が質問ならその質問をそのままquestionに使ってください。別の話題や知識テストに置き換えないでください。",
    "二者比較ならその2つを最初の選択肢にし、残りは両方・どちらでもないなど重複しない立場にしてください。",
    "人物名だけでも資料を要求せず、その人物についてどれくらい知っているか等の意見・関心を問えます。未確認の経歴や著作を捏造しないでください。",
    "出力はJSONだけ。Markdownコードブロックは禁止。",
    'schema: {"type":"knowledge|prediction|opinion","question":"...","choices":["...","...","...","..."],"emojis":["...","...","...","..."],"sourceTitle":"任意"}',
    "choicesは必ず4個、各40文字以内。questionは120文字以内。正解番号や解説のフィールドは不要です。",
    "emojisはchoicesと同じ順番で、各選択肢の意味に合う異なる絵文字を4つ選んでください。正解を示唆したり、特定の選択肢だけを良く見せたりしないでください。",
    `絵文字候補: ${QUIZ_EMOJIS.join(" ")}。4つすべてに自然な候補がなければ無理に選ばずemojisを省略してください。その場合は数字で表示します。`,
    `入力: ${topic?.trim() || "AI開発者コミュニティで気軽に参加できる好みや未来予測"}`,
  ].join("\n\n");
}

export interface QuizDraft {
  type: "knowledge" | "prediction" | "opinion";
  question: string;
  choices: [string, string, string, string];
  emojis?: [string, string, string, string];
  sourceTitle?: string | undefined;
}

export function parseQuiz(raw: string, news: Array<{ title: string }> = []): QuizDraft {
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
  if (isNonJapanese([question, ...choices].join(" "))) {
    throw new Error("quiz was not written in Japanese");
  }
  const sourceTitle =
    typeof parsed.sourceTitle === "string" && parsed.sourceTitle.trim()
      ? parsed.sourceTitle.trim()
      : news[0]?.title;
  return {
    type,
    question: truncate(question, 120),
    choices: choices.map((choice) => truncate(choice, 40)) as [string, string, string, string],
    emojis: quizEmojis(parsed),
    sourceTitle,
  };
}

export function renderQuiz(quiz: QuizDraft): string {
  const label =
    quiz.type === "prediction"
      ? "🔮 みんなの予測"
      : quiz.type === "opinion"
        ? "🗳️ みんなの投票"
        : "📰 みんなのクイズ";
  const emojis = quizEmojis(quiz);
  const lines = [
    `**${label}**`,
    "",
    quiz.question,
    "",
    `${emojis[0]} ${quiz.choices[0]}`,
    `${emojis[1]} ${quiz.choices[1]}`,
    `${emojis[2]} ${quiz.choices[2]}`,
    `${emojis[3]} ${quiz.choices[3]}`,
    "",
    "リアクションで1つ選んでください。",
  ];
  if (quiz.sourceTitle && quiz.type !== "opinion") {
    lines.push(`元ネタ: ${truncate(quiz.sourceTitle, 120)}`);
  }
  return truncate(lines.join("\n"), 1_900);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

/** Slash commands must never silently substitute the daily default topic. */
export function buildRequestedQuizPrompt(topic: string | undefined): string {
  const question = topic?.trim();
  if (!question) throw new Error("topic を入力してください。例：ClaudeとCodex、どちらが流行る？");
  if (question.length > 120) throw new Error("topic は120文字以内で入力してください。");
  return buildQuizPrompt(question) + "\n\n指定テーマ(JSON): " + JSON.stringify(question);
}

export function parseRequestedQuiz(raw: string, input: string): QuizDraft {
  const quiz = parseQuiz(raw);
  const marker = "\n\n指定テーマ(JSON): ";
  const position = input.lastIndexOf(marker);
  if (position < 0) return quiz; // Existing queued jobs retain compatibility.
  const question = JSON.parse(input.slice(position + marker.length)) as string;
  // Preserve the actual requested wording rather than accepting a model rewrite.
  quiz.question = question;
  const names = [...new Set(question.match(/[A-Za-z][A-Za-z0-9.+-]{1,}/g) ?? [])];
  if (names.length >= 2 && /ど|比較|vs|対|or/i.test(question)) {
    const choices = quiz.choices.join(" ").toLowerCase();
    if (names.some(name => !choices.includes(name.toLowerCase()))) {
      throw new Error("指定された比較対象が選択肢に含まれていません。話題を変えた投票は投稿しません。");
    }
  }
  return quiz;
}
