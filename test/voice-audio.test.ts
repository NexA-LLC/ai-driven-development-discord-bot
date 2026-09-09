import { expect, it } from "vitest";
import { hasSpeechEnergy, parseVoiceDecision, pcmToWav, PCM_BYTES_PER_SECOND } from "../src/gateway/voice-audio.js";
it("creates a valid WAV envelope for Discord PCM and rejects oversize input", () => {
  const pcm = Buffer.alloc(PCM_BYTES_PER_SECOND);
  const wav = pcmToWav(pcm);
  expect(wav.toString("ascii", 0, 4)).toBe("RIFF"); expect(wav.readUInt32LE(24)).toBe(48000);
  expect(wav.readUInt16LE(22)).toBe(2); expect(wav.readUInt32LE(40)).toBe(pcm.length);
  expect(() => pcmToWav(Buffer.alloc(PCM_BYTES_PER_SECOND * 31))).toThrow();
});
it("filters silence and tiny captures before ASR", () => {
  expect(hasSpeechEnergy(Buffer.alloc(PCM_BYTES_PER_SECOND))).toBe(false);
  expect(hasSpeechEnergy(Buffer.alloc(100, 1))).toBe(false);
  expect(hasSpeechEnergy(Buffer.alloc(PCM_BYTES_PER_SECOND, 20))).toBe(true);
});
it("executes the model's structured reply or leave decision, rejecting invalid output", () => {
  expect(parseVoiceDecision('{"action":"leave","text":"またお話ししましょう。"}').action).toBe("leave");
  expect(() => parseVoiceDecision('{"action":"ban","text":"done"}')).toThrow();
  expect(() => parseVoiceDecision('{"action":"reply","text":""}')).toThrow();
});
it("uses the deployed provider's supported strict JSON schema response format", async () => {
  const { VOICE_RESPONSE_FORMAT } = await import("../src/gateway/voice-audio.js");
  expect(VOICE_RESPONSE_FORMAT.type).toBe("json_schema");
  expect(VOICE_RESPONSE_FORMAT.json_schema.schema.required).toEqual(["action", "text"]);
  for (const action of VOICE_RESPONSE_FORMAT.json_schema.schema.properties.action.enum) {
    expect(parseVoiceDecision(JSON.stringify({ action, text: action === "ignore" ? "" : "はい。" })).action).toBe(action);
  }
});
