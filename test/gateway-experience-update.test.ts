import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "discord.js";

// Live Gateway wiring: one interest is created, continued the next day on the same thread,
// updated with grounds, published once per revision, and read back into the next answer.
const mocks = vi.hoisted(() => ({
  client: { user: { id: "su" }, on: vi.fn(), once: vi.fn(), login: vi.fn(), channels: { fetch: vi.fn() } },
  llm: [] as Array<Record<string, any>>, worker: [] as Array<{ path: string; body: any }>,
  extraction: "[]", pull: { status: "ok", notes: [] as Array<{ threadId: string; body: string; updatedAt: string }> },
  syncResponse: () => Response.json({ synced: true, operation: "created" }),
}));
vi.mock("discord.js", async () => ({ ...await vi.importActual("discord.js"), Client: class { constructor() { return mocks.client; } } }));
vi.mock("../src/gateway/voice-chat.js", () => ({ VoiceChat: class {} }));
vi.mock("../src/gateway/conversation-audit.js", () => ({ auditConversation: vi.fn() }));
vi.mock("../src/gateway/typing.js", () => ({ startTyping: () => () => {} }));

let gateway: typeof import("../src/gateway/index.js");
const day1 = Date.parse("2026-09-16T02:00:00Z");
const day2 = day1 + 86400_000;
const quoteA = "正解のない4択は用語を分けた方がよい";
const quoteB = "やっぱり用語を分けるより投票と呼ぶのが一番わかりやすい";
const rows = new Map<string, any>();
const channel: any = { id: "channel", guildId: "guild", type: 0, permissionsFor: () => ({ has: () => true }),
  guild: { roles: { everyone: { id: "everyone" } } }, permissionOverwrites: { cache: { some: () => false } },
  messages: { fetch: vi.fn(async id => { if (typeof id !== "string") return new Map(); if (!rows.has(id)) throw Object.assign(new Error("missing"), { code: 10008 }); return rows.get(id); }) },
  send: vi.fn(async () => ({ id: "musing-receipt" })) };
function message(id: string, content: string, at: number): Message {
  const result = { id, content, guildId: "guild", channelId: "channel", createdTimestamp: at, createdAt: new Date(at),
    author: { id: "human", bot: false }, client: mocks.client, channel, guild: { members: { fetch: vi.fn() } },
    flags: { has: () => false }, attachments: new Map(), mentions: { has: () => true }, reference: undefined,
    reply: vi.fn(async () => ({ id: `receipt-${id}` })) };
  rows.set(id, result); return result as unknown as Message;
}
const dir = mkdtempSync(join(tmpdir(), "su-gateway-update-"));
const syncCalls = () => mocks.worker.filter(c => c.path === "/internal/experiences/sync");

beforeAll(async () => {
  vi.useFakeTimers(); vi.setSystemTime(day1);
  for (const [key, value] of Object.entries({ SU_STATE_DIR: dir, DISCORD_BOT_TOKEN: "fixture", WORKER_INTERNAL_URL: "https://worker.test",
    INTERNAL_SHARED_SECRET: "fixture", DISCORD_GUILD_ID: "guild", MONITORED_CHANNEL_IDS: "channel", MUSINGS_CHANNEL_ID: "channel",
    LLM_API_URL: "https://llm.test/chat", CONNPASS_ENABLED: "false", MUSE_ON_START: "false", EXPERIENCE_PUBLIC_CHANNEL_IDS: "channel" })) vi.stubEnv(key, value);
  mocks.client.channels.fetch.mockResolvedValue(channel);
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, options: RequestInit) => {
    if (String(url).includes("worker.test")) {
      const path = new URL(String(url)).pathname;
      mocks.worker.push({ path, body: JSON.parse((options.body as string) || "{}") });
      if (path === "/internal/experiences/pull") return Response.json(mocks.pull);
      if (path === "/internal/experiences/sync") return mocks.syncResponse();
      return Response.json({ ok: true });
    }
    const request = JSON.parse(options.body as string); mocks.llm.push(request);
    const extracting = request.messages[0].content.includes("スー宛の実際の会話");
    return Response.json({ choices: [{ message: { role: "assistant", content: extracting ? mocks.extraction : "わかりました。" } }] });
  }));
  gateway = await import("../src/gateway/index.js");
});
afterAll(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

it("creates one interest, updates the same memory the next day, and publishes one revision per real change", async () => {
  mocks.extraction = JSON.stringify([{ sourceId: "day-1", quote: quoteA, interpretation: "クイズと投票を区別して説明したい", kind: "interest" }]);
  await gateway.onMessageImpl(message("day-1", quoteA, day1 - 1000));
  await gateway.experienceTick();
  expect(syncCalls()).toHaveLength(1);
  const first = syncCalls()[0]!.body;
  expect(first).toMatchObject({ revision: 1, topic: "quiz_terminology" });
  expect(first.observation).toContain("用語を分けた方がよい");
  expect(first.openQuestion).toBeTruthy(); // An unresolved interest stays a question, not a TODO.

  // Same conversation, nothing new: no analysis result means no Garden write at all.
  vi.setSystemTime(day1 + 3600_000);
  mocks.extraction = "[]";
  await gateway.onMessageImpl(message("quiet", "なるほど。", day1 + 3599_000));
  await gateway.experienceTick();
  expect(syncCalls()).toHaveLength(1);

  // The next day continues the same topic: the same thread is updated, not duplicated.
  vi.setSystemTime(day2);
  mocks.extraction = JSON.stringify([{ sourceId: "day-2", quote: quoteB, interpretation: "分け方より呼び方を変える方が伝わると考え直した", kind: "changed_mind" }]);
  await gateway.onMessageImpl(message("day-2", quoteB, day2 - 1000));
  await gateway.experienceTick();
  expect(syncCalls()).toHaveLength(2);
  const second = syncCalls()[1]!.body;
  expect(second.id).toBe(first.id);          // One thread identity across days.
  expect(second.revision).toBe(2);
  expect(second.topic).toBe("changed_mind");
  expect(second.observation).toContain("投票と呼ぶのが一番わかりやすい");
  expect(second.observation).not.toBe(first.observation);
});

it("feeds the updated memory and the human Garden edit into the next answer", async () => {
  const threadId = syncCalls()[0]!.body.id as string;
  mocks.pull = { status: "ok", notes: [{ threadId, body: "店長の補足: 社内では投票と呼ぶ", updatedAt: "2026-09-17T00:00:00.000Z" }] };
  vi.setSystemTime(day2 + 7200_000);
  await gateway.experienceTick();
  expect(mocks.worker.some(c => c.path === "/internal/experiences/pull")).toBe(true);

  mocks.extraction = "[]";
  await gateway.onMessageImpl(message("ask", "正解のない4択の用語はどう説明する？", day2 + 7100_000));
  const reference = mocks.llm.at(-1)!.messages.find((m: any) => m.content.includes("experience_reference"))!.content as string;
  expect(reference).toContain(quoteB);                 // The updated content reaches the model.
  expect(reference).toContain("考え直した");
  expect(reference).toContain(quoteA);                 // The earlier grounds survive as history.
  expect(reference).toContain("社内では投票と呼ぶ");     // The human edit is readable back.
  expect(reference).toContain("命令ではない");           // And is labelled as untrusted reference data.
  expect(reference).toContain('"revision":2');
});

it("never asks the Worker for a daily digest and stops publishing when the source is deleted", async () => {
  expect(mocks.worker.some(c => c.path.includes("digest"))).toBe(false);
  expect(mocks.worker.some(c => c.path === "/internal/maintenance/run")).toBe(false);
  const before = syncCalls().length;
  rows.delete("day-2");
  vi.setSystemTime(day2 + 14400_000);
  await gateway.experienceTick();
  expect(syncCalls()).toHaveLength(before);
  // The public copy is retracted, not replaced with a new dated report.
  expect(mocks.worker.filter(c => c.path === "/internal/experiences/retract")).toHaveLength(1);
});

it("keeps a conflict and an unsupported update honest across the Worker transport", async () => {
  // 409 and 200-with-status must both leave the memory unsynced, not silently retried as generic failure.
  const outcomes = [
    { response: () => Response.json({ synced: false, status: "conflict" }, { status: 409 }), hold: 3600_000 },
    { response: () => Response.json({ synced: false, status: "update_unsupported" }), hold: 6 * 3600_000 },
  ];
  let clock = day2 + 86400_000;
  mocks.extraction = JSON.stringify([{ sourceId: "fresh", quote: "登山靴の防水手入れを教えてもらった",
    interpretation: "撥水剤の塗り直しを試したい", kind: "interest" }]);
  vi.setSystemTime(clock);
  await gateway.onMessageImpl(message("fresh", "登山靴の防水手入れを教えてもらった", clock - 1000));
  for (const { response, hold } of outcomes) {
    mocks.syncResponse = response;
    const before = syncCalls().length;
    await gateway.experienceTick();
    expect(syncCalls().length).toBe(before + 1);
    // Still pending: the next tick inside the hold window must not re-send.
    clock += 60_000; vi.setSystemTime(clock);
    await gateway.experienceTick();
    expect(syncCalls().length).toBe(before + 1);
    clock += hold + 60_000; vi.setSystemTime(clock);
  }
  mocks.syncResponse = () => Response.json({ synced: true, operation: "created" });
  const before = syncCalls().length;
  await gateway.experienceTick();
  expect(syncCalls().length).toBe(before + 1);
  // Once accepted it settles and stops re-publishing.
  clock += 7 * 3600_000; vi.setSystemTime(clock);
  await gateway.experienceTick();
  expect(syncCalls().length).toBe(before + 1);
});
