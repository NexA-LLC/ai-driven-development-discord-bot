export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
type AudioAttachment = { url: string; size: number; contentType: string | null; name: string; duration?: number | null };
export function isAudioAttachment(a: Pick<AudioAttachment, "contentType" | "name">): boolean {
  return a.contentType?.startsWith("audio/") === true || /\.(ogg|opus|mp3|wav|m4a|webm)$/i.test(a.name);
}
export function validateAudioAttachment(a: AudioAttachment): void {
  const url = new URL(a.url);
  if (url.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) || !url.pathname.startsWith("/attachments/")) throw new Error("Discordの音声添付のみ利用できます");
  if (!isAudioAttachment(a) || a.size <= 0 || a.size > MAX_AUDIO_BYTES || (a.duration ?? 0) > 120) throw new Error("音声は8MB以下・2分以内で送ってください");
}
export async function boundedAudio(response: Response): Promise<Buffer> {
  if (!response.ok) throw new Error(`音声APIが応答できません (${response.status})`);
  if (!response.body) throw new Error("音声データがありません");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const {done, value} = await reader.read(); if (done) break; size += value.length; if (size > MAX_AUDIO_BYTES) throw new Error("音声が8MBを超えています"); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  if (!size) throw new Error("音声データが空です");
  return Buffer.concat(chunks);
}
export async function transcribeAudio(a: AudioAttachment, fetcher: typeof fetch = fetch): Promise<string> {
  validateAudioAttachment(a);
  const endpoint = process.env.SU_STT_URL;
  if (!endpoint) throw new Error("音声認識が未設定です");
  const audio = await boundedAudio(await fetcher(a.url, { redirect: "error", signal: AbortSignal.timeout(30000) }));
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: a.contentType ?? "application/octet-stream" }), a.name);
  form.append("response_format", "json"); form.append("language", "ja");
  const response = await fetcher(endpoint, { method: "POST", body: form, signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`音声認識に失敗しました (${response.status})`);
  const result = await response.json() as { text?: unknown };
  if (typeof result.text !== "string" || !result.text.trim()) throw new Error("音声を聞き取れませんでした");
  return result.text.trim().slice(0, 4000);
}
export async function synthesizeSpeech(text: string, fetcher: typeof fetch = fetch): Promise<Buffer> {
  const endpoint = process.env.SU_TTS_URL;
  if (!endpoint) throw new Error("音声生成が未設定です");
  if (!text.trim() || text.length > 400) throw new Error("音声返信は400文字以内です");
  const response = await fetcher(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, ...(process.env.SU_TTS_REF_AUDIO_PATH ? { ref_audio_path: process.env.SU_TTS_REF_AUDIO_PATH, ref_text: process.env.SU_TTS_REF_TEXT || undefined } : {}), ...(process.env.SU_TTS_SEED ? { seed: process.env.SU_TTS_SEED } : {}), backend: process.env.SU_TTS_BACKEND || "irodori-tts", speaker: process.env.SU_TTS_SPEAKER || "Ono_Anna", instruct: process.env.SU_TTS_INSTRUCT || "落ち着いた若い女性の声。自然で親しみやすい日本語。", language: "Japanese", audio_format: "mp3" }), signal: AbortSignal.timeout(180000) });
  if (response.ok && !response.headers.get("content-type")?.startsWith("audio/")) throw new Error("音声APIが音声を返しませんでした");
  return boundedAudio(response);
}
