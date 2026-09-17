import { z } from "zod";

// Public copies stay specific enough to tell two experiences apart, but no raw identifiers,
// links, contact details or secrets leave the Gateway. Redaction replaces, it does not flatten.
const REDACTIONS: Array<[RegExp, string]> = [
  [/<@!?\d+>|<@&\d+>/g, "[誰か]"],
  [/<#\d+>/g, "[どこかの話題]"],
  [/https?:\/\/\S+/g, "[リンク]"],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[連絡先]"],
  [/\b\d{15,21}\b/g, "[ID]"],
  [/```[\s\S]*?```|`[^`]*`/g, "[引用省略]"],
  // Honorific-suffixed names and @handles are the identifiers that actually show up in chat.
  [/[A-Za-z一-龥ぁ-んァ-ヶ][A-Za-z0-9一-龥ぁ-んァ-ヶ]{0,9}(?:さん|くん|ちゃん|さま|様|氏|先生|先輩|部長|課長|社長)/g, "[誰か]"],
  [/(?:^|\s)@[\w.-]{2,}/g, " [誰か]"],
];
const SECRET = /(?:Bearer\s|password\s*[:=]|api[_-]?key\s*[:=]|秘密|パスワード|sk-[a-z0-9]{8})/i;

/** Returns a publishable fragment, or "" when nothing survives redaction. */
export function redactForPublic(text: string, limit = 150): string {
  if (SECRET.test(text)) return "";
  let value = text;
  for (const [pattern, replacement] of REDACTIONS) value = value.replace(pattern, replacement);
  value = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (SECRET.test(value) || value.replace(/\[[^\]]*\]/g, "").trim().length < 4) return "";
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

export const publicExperienceSchema = z.object({
  // Thread identity, stable across revisions, so one experience keeps one Garden node.
  id: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().min(1).max(10_000),
  at: z.number().finite(),
  topic: z.enum(["quiz_terminology", "discovery", "changed_mind", "interest", "unfinished"]),
  observation: z.string().min(1).max(160),
  takeaway: z.string().min(1).max(160),
  openQuestion: z.string().min(1).max(160).optional(),
}).strict();
export type PublicExperience = z.infer<typeof publicExperienceSchema>;

type PublishableMemory = {
  threadId: string; revision: number; at: number; quote: string; interpretation: string;
  kind: "discovery" | "changed_mind" | "interest" | "unfinished";
};

export function publicExperience(memory: PublishableMemory): PublicExperience {
  const quiz = /正解/.test(memory.quote) && /4択|四択/.test(memory.quote) && /用語|呼び|投票/.test(memory.quote);
  const observation = redactForPublic(memory.quote);
  const takeaway = redactForPublic(memory.interpretation);
  const unresolved = memory.kind === "unfinished" || memory.kind === "interest";
  return publicExperienceSchema.parse({
    id: memory.threadId, revision: memory.revision, at: memory.at, topic: quiz ? "quiz_terminology" : memory.kind,
    // An empty field means redaction removed everything publishable; say that instead of inventing prose.
    observation: observation || "公開できる具体的な内容が残らなかった出来事",
    takeaway: takeaway || "内容は公開せず、根拠は運営側にだけ残している",
    ...(unresolved && takeaway ? { openQuestion: `この関心はまだ結論が出ていない: ${takeaway}`.slice(0, 160) } : {}),
  });
}

export function publicExperienceBody(item: PublicExperience): { title: string; body: string } {
  const labels = { quiz_terminology: "正解のない4択の呼び方", discovery: "会話で得た発見", changed_mind: "見方を考え直すきっかけ", interest: "会話から生まれた興味", unfinished: "続けて考えたい話" };
  return { title: `スーの経験: ${labels[item.topic]}`, body: [
    `出来事: ${item.observation}`,
    `受け止め方: ${item.takeaway}`,
    `残る問い: ${item.openQuestion ?? "いまはない。"}`,
    `最終更新: 第${item.revision}版 / 根拠の発言時刻 ${new Date(item.at).toISOString()}`,
    `記憶参照キー: ${publicExperienceSourceKey(item.id)}`,
    "受け止め方は解釈で、確定した事実ではない。原文・人物・Discord識別子は公開しない。運営用根拠は発言から最大30日で失効し、失効時はこのノードをarchived+privateへ下げる。",
  ].join("\n") };
}

export const publicExperienceSourceKey = (threadId: string): string => `su-experience:${threadId}`;
