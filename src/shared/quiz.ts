export const QUIZ_SYSTEM_PROMPT = "あなたはDiscordコミュニティの編集者。指定された問いを尊重し、投票したくなる4択を作る。正解・解説は付けない。JSON以外を返さない。";

export function isQuizPrompt(input: string): boolean {
  return input.startsWith("日本語で4択クイズ/予測/投票を1問だけ作ってください。");
}

export function buildQuizPrompt(topic?: string): string {
  return [
    "日本語で4択クイズ/予測/投票を1問だけ作ってください。",
    "日次クイズと同じく、みんなの意見・好み・未来予測を集める投票です。正解・採点・解説・伏せ字は一切出しません。",
    "入力が質問ならその質問をそのままquestionに使ってください。別の話題や知識テストに置き換えないでください。",
    "二者比較ならその2つを最初の選択肢にし、残りは両方・どちらでもないなど重複しない立場にしてください。",
    "人物名だけでも資料を要求せず、その人物についてどれくらい知っているか等の意見・関心を問えます。未確認の経歴や著作を捏造しないでください。",
    "出力はJSONだけ。Markdownコードブロックは禁止。",
    'schema: {"type":"knowledge|prediction|opinion","question":"...","choices":["...","...","...","..."],"sourceTitle":"任意"}',
    "choicesは必ず4個、各40文字以内。questionは120文字以内。正解番号や解説のフィールドは不要です。",
    `入力: ${topic?.trim() || "AI開発者コミュニティで気軽に参加できる好みや未来予測"}`,
  ].join("\n\n");
}

export interface QuizDraft {
  type: "knowledge" | "prediction" | "opinion";
  question: string;
  choices: [string, string, string, string];
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

export function renderQuiz(quiz: QuizDraft): string {
  const label =
    quiz.type === "prediction"
      ? "🔮 みんなの予測"
      : quiz.type === "opinion"
        ? "🗳️ みんなの投票"
        : "📰 みんなのクイズ";
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

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
