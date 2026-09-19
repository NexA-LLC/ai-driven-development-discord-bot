/** Discord decoded PCM: signed 16-bit, 48 kHz, stereo. */
export const PCM_BYTES_PER_SECOND = 48000 * 2 * 2;
export const MAX_VOICE_SECONDS = 30;
export function pcmToWav(pcm: Buffer): Buffer {
  if (!pcm.length || pcm.length % 4 || pcm.length > PCM_BYTES_PER_SECOND * MAX_VOICE_SECONDS) throw new Error("Invalid voice PCM length");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(pcm.length + 36, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48000, 24); header.writeUInt32LE(PCM_BYTES_PER_SECOND, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
export function hasSpeechEnergy(pcm: Buffer): boolean {
  if (pcm.length < PCM_BYTES_PER_SECOND * 0.3) return false;
  let sum = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) sum += (pcm.readInt16LE(i) / 32768) ** 2;
  return Math.sqrt(sum / (pcm.length / 2)) > 0.003;
}
export type VoiceDecision = { action: "reply" | "leave" | "ignore"; text: string };
export function parseVoiceDecision(raw: string): VoiceDecision {
  const value = JSON.parse(raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim()) as VoiceDecision;
  if (!["reply", "leave", "ignore"].includes(value.action) || typeof value.text !== "string" || value.text.length > 300 || (value.action !== "ignore" && !value.text.trim())) throw new Error("Invalid voice decision");
  return value;
}

// The deployed OpenAI-compatible provider accepts json_schema, not json_object.
export const VOICE_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: { name: "voice_reply", strict: true, schema: {
    type: "object",
    properties: { action: { type: "string", enum: ["reply", "leave", "ignore"] }, text: { type: "string" } },
    required: ["action", "text"], additionalProperties: false,
  } },
} as const;
