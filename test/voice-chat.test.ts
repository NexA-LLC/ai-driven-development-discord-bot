import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelType, Events, type Client, type Message } from "discord.js";
const mocks = vi.hoisted(() => ({ audit: vi.fn(), connections: [] as any[], subscribe: vi.fn(), play: vi.fn(), stt: vi.fn(), tts: vi.fn() }));
vi.mock("../src/gateway/conversation-audit.js", () => ({ auditConversation: mocks.audit }));
vi.mock("../src/gateway/audio.js", () => ({ transcribeAudioBytes: mocks.stt, synthesizeSpeech: mocks.tts }));
vi.mock("@discordjs/voice", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    AudioPlayerStatus: { Idle: "idle", Playing: "playing" }, EndBehaviorType: { AfterSilence: 1 }, VoiceConnectionStatus: { Ready: "ready", Disconnected: "disconnected", Destroyed: "destroyed" },
    joinVoiceChannel: vi.fn(() => { const c = Object.assign(new EventEmitter(), { state: { status: "ready" }, receiver: { speaking: new EventEmitter(), subscribe: mocks.subscribe }, subscribe: vi.fn(), destroy: vi.fn(function(this: any) { this.state.status = "destroyed"; }) }); mocks.connections.push(c); return c; }),
    createAudioPlayer: () => Object.assign(new EventEmitter(), { state: { status: "idle" }, play: mocks.play, stop: vi.fn() }),
    createAudioResource: () => ({ playStream: { destroy: vi.fn() } }), entersState: vi.fn(async (target) => target),
  };
});
import { VoiceChat } from "../src/gateway/voice-chat.js";
const managers: VoiceChat[] = [];
afterEach(() => { managers.forEach(m => m.stop()); managers.length = 0; mocks.connections.length = 0; vi.clearAllMocks(); });
function setup(permitted = true) {
  const client = Object.assign(new EventEmitter(), { user: { id: "bot" } });
  const channel = { id: "vc", name: "会話", type: ChannelType.GuildVoice, guild: { id: "guild", voiceAdapterCreator: {} }, permissionsFor: () => ({ has: () => permitted }), members: new Map([["user", { user: { bot: false } }], ["other", { user: { bot: false } }]]), send: vi.fn() };
  const member = { id: "user", voice: { channel }, permissions: { has: () => false } };
  const message = { guild: { id: "guild", members: { fetch: vi.fn(async () => member) } }, author: { id: "user" } } as unknown as Message;
  const answer = vi.fn(async () => ({ action: "reply" as const, text: "こんにちは" }));
  const manager = new VoiceChat(client as unknown as Client, answer); managers.push(manager);
  return { manager, message, client, member, answer };
}
it("rejects joining without voice permissions", async () => { const { manager, message } = setup(false); await expect(manager.join(message)).rejects.toThrow("権限"); expect(mocks.connections).toHaveLength(0); });
it("subscribes only to the requesting person and closes when they leave", async () => {
  const { manager, message, client } = setup(); await manager.join(message); const c = mocks.connections[0];
  c.receiver.speaking.emit("start", "other"); c.receiver.speaking.emit("start", "bot"); expect(mocks.subscribe).not.toHaveBeenCalled();
  client.emit(Events.VoiceStateUpdate, {}, { guild: { id: "guild" }, id: "user", channelId: null }); expect(c.destroy).toHaveBeenCalled();
});
it("decodes subscribed speech, runs ASR and model, and plays the generated response", async () => {
  const { manager, message, answer } = setup(); await manager.join(message);
  mocks.stt.mockResolvedValue("こんにちは"); mocks.tts.mockResolvedValue(Buffer.from("mp3"));
  const input = new PassThrough({ objectMode: true }); mocks.subscribe.mockReturnValue(input);
  const { default: Opus } = await import("opusscript"); const encoder = new Opus(48000, 2, Opus.Application.VOIP);
  mocks.connections[0].receiver.speaking.emit("start", "user");
  for (let f = 0; f < 25; f++) { const pcm = Buffer.alloc(3840); for (let i = 0; i < 1920; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i * 0.05)), i * 2); input.write(Buffer.from(encoder.encode(pcm, 960))); }
  input.end(); encoder.delete();
  await vi.waitFor(() => expect(mocks.play).toHaveBeenCalledTimes(1));
  expect(mocks.stt.mock.calls[0][0].toString("ascii", 0, 4)).toBe("RIFF"); expect(answer).toHaveBeenCalled(); expect(mocks.tts).toHaveBeenCalledWith("こんにちは");
  const entries = mocks.audit.mock.calls.map(([entry]) => entry);
  expect(entries.map(e => e.phase)).toEqual(["received", "transcribed", "decided", "synthesized", "played"]);
  expect(new Set(entries.map(e => e.id)).size).toBe(1);
  expect(entries[1]).toMatchObject({ event: "voice", userId: "user", channelId: "vc", input: "こんにちは" });
  expect(JSON.parse(entries[2].response)).toEqual({ action: "reply", text: "こんにちは" });
  expect(entries[4].ok).toBe(true);
});
