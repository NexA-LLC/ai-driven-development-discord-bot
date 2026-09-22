import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "discord.js";

const mocks = vi.hoisted(() => ({ client: { user: { id: "su" }, on: vi.fn(), once: vi.fn(), login: vi.fn(), channels: { fetch: vi.fn() } }, requests: [] as Array<Record<string, any>>, workerCalls: [] as Array<{ path: string; body: any }>, pullResponse: { status: "ok", notes: [] as any[] }, connpassJson: JSON.stringify({ results_start: 1, results_returned: 0, results_available: 0, events: [] }) }));
vi.mock("discord.js", async () => ({ ...await vi.importActual("discord.js"), Client: class { constructor() { return mocks.client; } } }));
vi.mock("../src/gateway/voice-chat.js", () => ({ VoiceChat: class {} }));
vi.mock("../src/gateway/conversation-audit.js", () => ({ auditConversation: vi.fn() }));
vi.mock("../src/gateway/typing.js", () => ({ startTyping: () => () => {} }));
let gateway: typeof import("../src/gateway/index.js");
const now = Date.parse("2026-09-16T02:00:00Z");
const quote = "正解のない4択は用語を分けた方がよい";
const rows = new Map<string, any>();
const channel: any = { id: "channel", guildId: "guild", type: 0, permissionsFor: () => ({ has: () => true }),
  guild: { roles: { everyone: { id: "everyone" } } }, permissionOverwrites: { cache: { some: () => false } },
  messages: { fetch: vi.fn(async id => { if (typeof id !== "string") return new Map(); if (!rows.has(id)) throw Object.assign(new Error("missing"), { code: 10008 }); return rows.get(id); }) },
  send: vi.fn(async () => ({ id: "musing-receipt" })) };
const generalChannel: any = { ...channel, id: "general", send: vi.fn(async () => ({ id: "general-receipt" })) };
function message(id: string, content: string, author = "human", reference?: string, mentioned = false): Message {
  const result = { id, content, guildId: "guild", channelId: "channel", createdTimestamp: now - 1000, createdAt: new Date(now - 1000),
    author: { id: author, bot: author === "su" || author === "another-bot" }, client: mocks.client,
    channel, guild: { members: { fetch: vi.fn() } }, flags: { has: () => false }, attachments: new Map(),
    mentions: { has: () => mentioned }, reference: reference ? { messageId: reference, channelId: "channel", guildId: "guild" } : undefined,
    reply: vi.fn(async () => ({ id: `receipt-${id}` })) };
  rows.set(id, result); return result as unknown as Message;
}
const dir = mkdtempSync(join(tmpdir(), "su-gateway-flow-"));
beforeAll(async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  for (const [key, value] of Object.entries({ SU_STATE_DIR: dir, DISCORD_BOT_TOKEN: "fixture", WORKER_INTERNAL_URL: "https://worker.test", INTERNAL_SHARED_SECRET: "fixture", DISCORD_GUILD_ID: "guild", MONITORED_CHANNEL_IDS: "channel", MUSINGS_CHANNEL_ID: "channel", EVENT_POST_CHANNEL_ID: "general", LLM_API_URL: "https://llm.test/chat", CONNPASS_ENABLED: "true", CONNPASS_API_KEY: "connpass-fixture", MUSE_ON_START: "false", EXPERIENCE_KNOWLEDGE_CHANNEL_IDS: "channel" })) vi.stubEnv(key, value);
  mocks.client.channels.fetch.mockImplementation(async id => id === "general" ? generalChannel : channel);
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, options: RequestInit) => {
    if (String(url).includes("connpass.com/api/v2/events")) {
      expect((options.headers as Record<string, string>)["x-api-key"]).toBe("connpass-fixture");
      return new Response(mocks.connpassJson, { headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("worker.test")) {
      const path = new URL(String(url)).pathname;
      mocks.workerCalls.push({ path, body: JSON.parse((options.body as string) || "{}") });
      if (path === "/internal/experiences/pull") return Response.json(mocks.pullResponse);
      return Response.json({ ok: true, synced: true });
    }
    const request = JSON.parse(options.body as string); mocks.requests.push(request);
    const extraction = request.messages[0].content.includes("スー宛の実際の会話");
    return Response.json({ choices: [{ message: { role: "assistant", content: extraction ? JSON.stringify([{ sourceId: "original", quote, interpretation: "クイズと投票を分けて説明する", kind: "discovery" }]) : "正解のない4択は投票として伝えます。" } }] });
  }));
  gateway = await import("../src/gateway/index.js");
});
afterAll(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

it("live handler answers an unmentioned reply with bounded ancestors and later recalls its sourced experience", async () => {
  message("original", quote, "human", undefined, true);
  message("su-reply", "用語を分けてみましょう", "su", "original");
  const reply = message("follow-up", "そう、その呼び方について続けたい", "human", "su-reply");
  await gateway.onMessageImpl(reply);
  expect(reply.reply).toHaveBeenCalledOnce();
  expect(JSON.stringify(mocks.requests.at(-1)?.messages)).toContain(quote);
  expect(JSON.stringify(mocks.requests.at(-1)?.messages)).toContain("su-reply");
  await gateway.experienceTick();
  const later = message("later", "正解のない4択の用語はどう説明する？", "human", undefined, true);
  await gateway.onMessageImpl(later);
  const messages = mocks.requests.at(-1)?.messages;
  const reference = messages.find((m: any) => m.content.includes("experience_reference"));
  expect(reference.content).toContain(quote); expect(reference.content).toContain("original"); expect(reference.content).toContain("interpretation");
  await gateway.postMusingImpl(12, true);
  expect(JSON.stringify(mocks.requests.at(-1)?.messages)).toContain(quote);
  expect(channel.send).toHaveBeenCalledOnce();
  await gateway.postMusingImpl(18, true);
  expect(JSON.stringify(mocks.requests.at(-1)?.messages)).not.toContain(quote);
});
it("live handler ignores unrelated messages, bots, DMs, other guilds and non-allowlisted channels", async () => {
  for (const input of [message("unrelated", "こんにちは"), message("bot", "<@su>", "another-bot", undefined, true),
    { ...message("dm", "hi", "human", undefined, true), guildId: null },
    { ...message("other-guild", "hi", "human", undefined, true), guildId: "other" },
    { ...message("other-channel", "hi", "human", undefined, true), channelId: "other" }]) {
    await gateway.onMessageImpl(input as Message); expect(input.reply).not.toHaveBeenCalled();
  }
});
it("does not recall on unrelated topics, denied permissions, or deleted/edited sources", async () => {
  const latest = () => mocks.requests.at(-1)?.messages.find((m: any) => m.content.includes("experience_reference")).content;
  await gateway.onMessageImpl(message("weather", "今日の天気は？", "human", undefined, true)); expect(latest()).not.toContain(quote);
  const oldPermissions = channel.permissionsFor;
  channel.permissionsFor = () => ({ has: () => false });
  await gateway.onMessageImpl(message("denied", "正解のない4択の用語", "human", undefined, true)); expect(latest()).not.toContain(quote);
  channel.permissionsFor = oldPermissions;
  rows.get("original").content = "変更済み";
  await gateway.onMessageImpl(message("edited", "正解のない4択の用語", "human", undefined, true)); expect(latest()).not.toContain(quote);
});
it("refreshes connpass without injecting events into replies or non-milestone musings", async () => {
  vi.setSystemTime(now + 6 * 3600_000);
  mocks.connpassJson = JSON.stringify({ results_start: 1, results_returned: 1, results_available: 1, events: [{ event_id: 407072, title: "AI駆動開発のイベント", catch: "AI開発の工夫を紹介", description: "", event_url: "https://aid.connpass.com/event/407072/", started_at: "2026-09-20T19:00:00+09:00", ended_at: "2026-09-20T21:00:00+09:00", updated_at: "2026-09-16T02:10:00Z" }] });
  await gateway.experienceTick();
  await gateway.postMusingImpl(12, true);
  expect(JSON.stringify(mocks.requests.at(-1)?.messages)).not.toContain("public_event_reference");
  expect(channel.send.mock.calls.at(-1)?.[0].content).not.toContain("https://aid.connpass.com/event/407072/");
  await gateway.onMessageImpl(message("event-question", "connpassのイベントを教えて", "human", undefined, true));
  expect(JSON.stringify(mocks.requests.at(-1)?.messages)).not.toContain("public_event_reference");
  expect(JSON.stringify(mocks.requests.at(-1)?.messages)).not.toContain("407072");
});
it("turns a three-day event milestone into one sourced musing", async () => {
  vi.setSystemTime(Date.parse("2026-09-17T03:00:00Z"));
  await gateway.experienceTick();
  await gateway.postMusingImpl(12, true);
  expect(JSON.stringify(mocks.requests.at(-1)?.messages)).toContain("開催3日前");
  expect(JSON.stringify(mocks.requests.at(-1)?.messages)).toContain("public_event_reference");
  expect(generalChannel.send.mock.calls.at(-1)?.[0].content).toContain("https://aid.connpass.com/event/407072/");
  expect(mocks.client.channels.fetch).toHaveBeenLastCalledWith("general");
  await gateway.onMessageImpl(message("event-question-after-musing", "次のイベントは？", "human", undefined, true));
  expect(JSON.stringify(mocks.requests.at(-1)?.messages)).not.toContain("public_event_reference");
});
