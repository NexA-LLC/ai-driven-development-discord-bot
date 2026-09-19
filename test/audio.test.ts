import { afterEach, expect, it, vi } from "vitest";
import { isAudioAttachment, validateAudioAttachment, transcribeAudio, synthesizeSpeech, boundedAudio } from "../src/gateway/audio.js";
const attachment = { url: "https://cdn.discordapp.com/attachments/1/2/voice.ogg", size: 100, name: "voice.ogg", contentType: "audio/ogg" };
afterEach(() => vi.unstubAllEnvs());
it("recognizes voice attachments and rejects off-platform or oversized downloads", () => {
  expect(isAudioAttachment(attachment)).toBe(true);
  expect(isAudioAttachment({ name: "image.png", contentType: "image/png" })).toBe(false);
  expect(() => validateAudioAttachment({ ...attachment, url: "http://127.0.0.1/secret" })).toThrow();
  expect(() => validateAudioAttachment({ ...attachment, size: 9 * 1024 * 1024 })).toThrow();
  expect(() => validateAudioAttachment({ ...attachment, duration: 121 })).toThrow();
});
it("downloads Discord audio without redirects and submits a multipart transcription", async () => {
  vi.stubEnv("SU_STT_URL", "http://stt.test/transcribe");
  const fetcher = vi.fn().mockResolvedValueOnce(new Response("audio")).mockResolvedValueOnce(Response.json({ text: "こんにちは" }));
  expect(await transcribeAudio(attachment, fetcher)).toBe("こんにちは");
  expect(fetcher.mock.calls[0][1].redirect).toBe("error");
  expect(fetcher.mock.calls[1][1].body).toBeInstanceOf(FormData);
});
it("fails on empty recognition and non-audio synthesis instead of claiming success", async () => {
  vi.stubEnv("SU_STT_URL", "http://stt.test/transcribe"); vi.stubEnv("SU_TTS_URL", "http://tts.test/tts");
  await expect(transcribeAudio(attachment, vi.fn().mockResolvedValueOnce(new Response("audio")).mockResolvedValueOnce(Response.json({ text: "" })))).rejects.toThrow("聞き取れません");
  await expect(synthesizeSpeech("こんにちは", vi.fn().mockResolvedValue(Response.json({ error: "bad" })))) .rejects.toThrow("音声を返しません");
});
it("returns generated audio with the configured speaker", async () => {
  vi.stubEnv("SU_TTS_URL", "http://tts.test/tts"); vi.stubEnv("SU_TTS_SPEAKER", "Ono_Anna");
  const fetcher = vi.fn().mockResolvedValue(new Response("mp3", { headers: { "content-type": "audio/mpeg" } }));
  expect((await synthesizeSpeech("こんにちは", fetcher)).toString()).toBe("mp3");
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ speaker: "Ono_Anna", audio_format: "mp3" });
});
it("bounds actual downloaded bytes even when metadata is wrong", async () => {
  await expect(boundedAudio(new Response(new Uint8Array(8 * 1024 * 1024 + 1)))).rejects.toThrow("8MB");
});
it("passes the operator-selected reference and seed to Nexa Voice", async () => {
  vi.stubEnv("SU_TTS_URL", "http://tts.test/tts");
  vi.stubEnv("SU_TTS_REF_AUDIO_PATH", "/references/su-D2.mp3");
  vi.stubEnv("SU_TTS_REF_TEXT", "いらっしゃいませ。");
  vi.stubEnv("SU_TTS_SEED", "24104");
  const fetcher = vi.fn().mockResolvedValue(new Response("mp3", { headers: { "content-type": "audio/mpeg" } }));
  await synthesizeSpeech("今日もよろしくお願いします。", fetcher);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ ref_audio_path: "/references/su-D2.mp3", ref_text: "いらっしゃいませ。", seed: "24104" });
});
