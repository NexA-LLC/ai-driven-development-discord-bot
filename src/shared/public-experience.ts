import { z } from "zod";

// Deliberately finite public vocabulary: no raw quotes, identities, source IDs or LLM prose leave the Gateway.
export const publicExperienceSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), at: z.number().finite(),
  topic: z.enum(["quiz_terminology", "discovery", "changed_mind", "interest", "unfinished"]) }).strict();
export type PublicExperience = z.infer<typeof publicExperienceSchema>;
export function publicExperience(memory: { id: string; at: number; quote: string; kind: "discovery" | "changed_mind" | "interest" | "unfinished" }): PublicExperience {
  const quiz = /正解/.test(memory.quote) && /4択|四択/.test(memory.quote) && /用語|呼び|投票/.test(memory.quote);
  return { id: memory.id, at: memory.at, topic: quiz ? "quiz_terminology" : memory.kind };
}
export function publicExperienceBody(item: PublicExperience): { title: string; body: string } {
  const labels = { quiz_terminology: "正解のない4択の呼び方", discovery: "会話で得た発見", changed_mind: "見方を考え直すきっかけ", interest: "会話から生まれた興味", unfinished: "続けて考えたい話" };
  return { title: `スーの経験: ${labels[item.topic]}`, body: [
    `観察: ${item.topic === "quiz_terminology" ? "正解を定めない4択の用語について意見があった。" : "スー宛の実在する会話から、上記の種類の経験候補を得た。"}`,
    "解釈: 今後の関連する会話で根拠を再確認して参照する。内容の正しさや実装完了を意味しない。",
    `発言時刻: ${new Date(item.at).toISOString()}`,
    `記憶参照キー: su-experience:${item.id}`,
    "プライバシー保護のため詳細・原文・人物・Discord識別子は公開しない。運営用根拠は発言から最大30日で失効。",
  ].join("\n") };
}
