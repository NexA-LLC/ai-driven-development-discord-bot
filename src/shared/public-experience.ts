import { z } from "zod";

// Nothing published here is a copy of what a person wrote. A separate review step produces a
// short de-identified retelling, and these checks are the structural floor under that judgement:
// they reject identifiers, links, secrets and any run copied verbatim from the original message.
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
const SECRET = /(?:Bearer\s|password\s*[:=]|api[_-]?key\s*[:=]|秘密|パスワード|内緒|ここだけ|オフレコ|sk-[a-z0-9]{8})/i;
/** A shared run this long is a copy of the original wording, not a retelling of it. */
export const MAX_VERBATIM_RUN = 12;
const FIELD_LIMIT = 160;

/** Returns a publishable fragment, or "" when nothing survives redaction. */
export function redactForPublic(text: string, limit = 150): string {
  if (SECRET.test(text)) return "";
  let value = text;
  for (const [pattern, replacement] of REDACTIONS) value = value.replace(pattern, replacement);
  value = normalise(value);
  if (SECRET.test(value) || value.replace(/\[[^\]]*\]/g, "").trim().length < 4) return "";
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

const normalise = (text: string): string => text.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();

/** True when the two texts share a run long enough to be a quotation rather than a retelling. */
export function copiesVerbatim(summary: string, original: string, run = MAX_VERBATIM_RUN): boolean {
  const a = normalise(summary).replace(/\s/g, "");
  const b = normalise(original).replace(/\s/g, "");
  if (a.length < run || b.length < run) return false;
  for (let i = 0; i + run <= a.length; i++) if (b.includes(a.slice(i, i + run))) return true;
  return false;
}

export const publicSummarySchema = z.object({
  observation: z.string().min(4).max(FIELD_LIMIT),
  takeaway: z.string().min(4).max(FIELD_LIMIT),
  openQuestion: z.string().min(4).max(FIELD_LIMIT).optional(),
}).strict();
export type PublicSummary = z.infer<typeof publicSummarySchema>;

/**
 * Structural gate for a reviewed summary. Returns the cleaned summary, or null when the
 * candidate has no safe specific content — the caller must then publish nothing at all.
 * Redaction is used as a detector here, not a repair: a field that needed redacting is a
 * field the review step got wrong, so it is rejected rather than silently patched.
 */
export function safePublicSummary(summary: unknown, original: string): PublicSummary | null {
  const parsed = publicSummarySchema.safeParse(summary);
  if (!parsed.success) return null;
  const clean: Record<string, string> = {};
  for (const [key, raw] of Object.entries(parsed.data)) {
    if (raw === undefined) continue;
    const value = normalise(raw);
    if (!value || redactForPublic(value, FIELD_LIMIT) !== value) return null;
    if (copiesVerbatim(value, original)) return null;
    clean[key] = value;
  }
  if (!clean.observation || !clean.takeaway) return null;
  return clean as PublicSummary;
}

export const publicExperienceSchema = z.object({
  // Thread identity, stable across revisions, so one experience keeps one Garden node.
  id: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().min(1).max(10_000),
  at: z.number().finite(),
  topic: z.enum(["quiz_terminology", "discovery", "changed_mind", "interest", "unfinished"]),
  observation: z.string().min(1).max(FIELD_LIMIT),
  takeaway: z.string().min(1).max(FIELD_LIMIT),
  openQuestion: z.string().min(1).max(FIELD_LIMIT).optional(),
}).strict();
export type PublicExperience = z.infer<typeof publicExperienceSchema>;

type PublishableMemory = {
  threadId: string; revision: number; at: number;
  kind: "discovery" | "changed_mind" | "interest" | "unfinished";
  publicSummary: PublicSummary | null;
};

/**
 * Builds the public copy from the reviewed summary only. Never reads the original message.
 * Returns null when no reviewed summary exists, so an unreviewed memory publishes nothing
 * instead of a boilerplate node that says the same thing for every experience.
 */
export function publicExperience(memory: PublishableMemory): PublicExperience | null {
  if (!memory.publicSummary) return null;
  const { observation, takeaway, openQuestion } = memory.publicSummary;
  // Classified from the reviewed text, so even the topic label is not derived from the original.
  const quiz = /4択|四択/.test(observation) && /用語|呼び|投票/.test(observation);
  const result = publicExperienceSchema.safeParse({
    id: memory.threadId, revision: memory.revision, at: memory.at,
    topic: quiz ? "quiz_terminology" : memory.kind,
    observation, takeaway, ...(openQuestion ? { openQuestion } : {}),
  });
  return result.success ? result.data : null;
}

export function publicExperienceBody(item: PublicExperience): { title: string; body: string } {
  const labels = { quiz_terminology: "正解のない4択の呼び方", discovery: "会話で得た発見", changed_mind: "見方を考え直すきっかけ", interest: "会話から生まれた興味", unfinished: "続けて考えたい話" };
  return { title: `スーの経験: ${labels[item.topic]}`, body: [
    `出来事: ${item.observation}`,
    `受け止め方: ${item.takeaway}`,
    `残る問い: ${item.openQuestion ?? "いまはない。"}`,
    `最終更新: 第${item.revision}版 / 根拠の発言時刻 ${new Date(item.at).toISOString()}`,
    `記憶参照キー: ${publicExperienceSourceKey(item.id)}`,
    "これは原文の引用ではなく、非公開Knowledgeとして保存してよいか判定したうえで書き直した要約。受け止め方は解釈で、確定した事実ではない。原文・人物・Discord識別子は保存しない。運営用根拠は発言から最大30日で失効し、失効時はこのノードをarchived+privateへ下げる。",
  ].join("\n") };
}

export const publicExperienceSourceKey = (threadId: string): string => `su-experience:${threadId}`;
