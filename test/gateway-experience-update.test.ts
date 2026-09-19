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
  extraction: "[]", pull: { status: "ok", covered: [] as string[], notes: [] as Array<{ threadId: string; body: string; updatedAt: string }> },
  // The publication reviewer: a separate pass that rewrites the memory instead of copying it.
  review: JSON.stringify({ publishable: true, summary: { observation: "唯一の正解を決めない四択の呼び方について意見をもらった",
    takeaway: "投票と呼ぶほうが誤解が少ないのかもしれないと考えている", openQuestion: "どう呼べば誤解されにくいのか" } }),
  syncResponse: () => Response.json({ synced: true, operation: "created", nodeId: NODE_ID }),
}));
vi.mock("discord.js", async () => ({ ...await vi.importActual("discord.js"), Client: class { constructor() { return mocks.client; } } }));
vi.mock("../src/gateway/voice-chat.js", () => ({ VoiceChat: class {} }));
vi.mock("../src/gateway/conversation-audit.js", () => ({ auditConversation: vi.fn() }));
vi.mock("../src/gateway/typing.js", () => ({ startTyping: () => () => {} }));

let gateway: typeof import("../src/gateway/index.js");
const NODE_ID = "0198f0a1-1c2d-7e3f-8a4b-5c6d7e8f9a0b";
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
    LLM_API_URL: "https://llm.test/chat", CONNPASS_ENABLED: "false", MUSE_ON_START: "false", EXPERIENCE_KNOWLEDGE_CHANNEL_IDS: "channel" })) vi.stubEnv(key, value);
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
    const system = request.messages[0].content as string;
    const content = system.includes("スー宛の実際の会話") ? mocks.extraction
      : system.includes("非公開Knowledgeとして保存してよいか判定") ? mocks.review : "わかりました。";
    return Response.json({ choices: [{ message: { role: "assistant", content } }] });
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
  expect(first.observation).toContain("唯一の正解を決めない四択の呼び方");
  expect(first.observation).not.toContain(quoteA); // Published text is a retelling, never the original.
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
  mocks.review = JSON.stringify({ publishable: true, summary: { observation: "呼び分けるより投票と言う方が伝わるという話になった",
    takeaway: "前の考えを改めるほうがよさそうだと感じている" } });
  await gateway.onMessageImpl(message("day-2", quoteB, day2 - 1000));
  await gateway.experienceTick();
  expect(syncCalls()).toHaveLength(2);
  const second = syncCalls()[1]!.body;
  expect(second.id).toBe(first.id);          // One thread identity across days.
  expect(second.revision).toBe(2);
  expect(second.topic).toBe("changed_mind");
  expect(second.observation).toContain("投票と言う方が伝わる");
  expect(second.observation).not.toContain(quoteB);
  expect(second.observation).not.toBe(first.observation);
});

it("feeds the updated memory and the human Garden edit into the next answer", async () => {
  const threadId = syncCalls()[0]!.body.id as string;
  mocks.pull = { status: "ok", covered: [threadId], notes: [{ threadId, body: "店長の補足: 社内では投票と呼ぶ", updatedAt: "2026-09-17T00:00:00.000Z" }] };
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
    // A human edit in the Garden is held as long as a missing tool: both need a person, not a retry.
    { response: () => Response.json({ synced: false, status: "conflict" }, { status: 409 }), hold: 6 * 3600_000 },
    { response: () => Response.json({ synced: false, status: "update_unsupported" }), hold: 6 * 3600_000 },
  ];
  let clock = day2 + 86400_000;
  mocks.extraction = JSON.stringify([{ sourceId: "fresh", quote: "登山靴の防水手入れを教えてもらった",
    interpretation: "撥水剤の塗り直しを試したい", kind: "interest" }]);
  mocks.review = JSON.stringify({ publishable: true, summary: { observation: "雨に強くするための靴の手入れ方法を教わった",
    takeaway: "撥水の塗り直しを自分でも試してみたい", openQuestion: "どのくらいの頻度で塗り直すのがよいのか" } });
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
  mocks.syncResponse = () => Response.json({ synced: true, operation: "created", nodeId: NODE_ID });
  const before = syncCalls().length;
  await gateway.experienceTick();
  expect(syncCalls().length).toBe(before + 1);
  // Once accepted it settles and stops re-publishing.
  clock += 7 * 3600_000; vi.setSystemTime(clock);
  await gateway.experienceTick();
  expect(syncCalls().length).toBe(before + 1);
});

it("drops a Garden note the operator took down, and keeps one it could not re-check", async () => {
  // The earlier deletion test retired the quiz thread, so this runs on the one still remembered.
  const threadId = syncCalls().at(-1)!.body.id as string;
  let clock = day2 + 4 * 86400_000;
  vi.setSystemTime(clock);
  mocks.pull = { status: "ok", covered: [threadId], notes: [{ threadId, body: "店長の補足: 社内では投票と呼ぶ", updatedAt: "2026-09-17T00:00:00.000Z" }] };
  await gateway.experienceTick();
  const withNote = () => {
    const ref = mocks.llm.at(-1)!.messages.find((m: any) => m.content.includes("experience_reference"))!.content as string;
    return ref.includes("社内では投票と呼ぶ");
  };
  mocks.extraction = "[]";
  await gateway.onMessageImpl(message("check-1", "登山靴の防水手入れはどうすればいい？", clock - 1000));
  expect(withNote()).toBe(true);

  // The operator archives or privates the node: the pull still covers the thread but returns no note.
  clock += 2 * 3600_000; vi.setSystemTime(clock);
  mocks.pull = { status: "ok", covered: [threadId], notes: [] };
  await gateway.experienceTick();
  await gateway.onMessageImpl(message("check-2", "登山靴の防水手入れはどうすればいい？", clock - 1000));
  expect(withNote()).toBe(false);

  // A failed read is authoritative for nothing and must not erase a note it could not check.
  clock += 2 * 3600_000; vi.setSystemTime(clock);
  mocks.pull = { status: "ok", covered: [threadId], notes: [{ threadId, body: "店長の補足: 社内では投票と呼ぶ", updatedAt: "2026-09-18T00:00:00.000Z" }] };
  await gateway.experienceTick();
  clock += 2 * 3600_000; vi.setSystemTime(clock);
  mocks.pull = { status: "failed", covered: [], notes: [] };
  await gateway.experienceTick();
  await gateway.onMessageImpl(message("check-3", "登山靴の防水手入れはどうすればいい？", clock - 1000));
  expect(withNote()).toBe(true);
});

it("carries its own last-write token and stops publishing when the Garden reports a human edit", async () => {
  const sent: any[] = [];
  let clock = day2 + 10 * 86400_000;
  vi.setSystemTime(clock);
  // A brand-new thread so this runs from create through update.
  mocks.extraction = JSON.stringify([{ sourceId: "kettle", quote: "やかんの注ぎ口を掃除する方法を教わった",
    interpretation: "クエン酸を試したい", kind: "interest" }]);
  mocks.review = JSON.stringify({ publishable: true, summary: { observation: "湯を沸かす道具の注ぎ口の掃除の仕方を教わった",
    takeaway: "酸を使う方法を試してみたい", openQuestion: "どのくらいの間隔で掃除するのがよいのか" } });
  mocks.syncResponse = () => { sent.push("create"); return Response.json({ synced: true, operation: "created", nodeId: NODE_ID }); };
  await gateway.onMessageImpl(message("kettle", "やかんの注ぎ口を掃除する方法を教わった", clock - 1000));
  await gateway.experienceTick();
  const created = syncCalls().at(-1)!.body;
  expect(created.revision).toBe(1);
  expect(created.baselineUpdatedAt).toBeUndefined(); // A create has no prior token to guard.

  // A second revision on a thread with no token yet waits for the read-back rather than overwriting.
  clock += 86400_000; vi.setSystemTime(clock);
  mocks.extraction = JSON.stringify([{ sourceId: "kettle-2", quote: "やかんの注ぎ口の掃除はクエン酸より重曹が向いている",
    interpretation: "酸ではなく重曹を試すことにした", kind: "changed_mind" }]);
  mocks.review = JSON.stringify({ publishable: true, summary: { observation: "注ぎ口の掃除には別の粉の方が向くと教わった",
    takeaway: "先に考えていた方法を変えることにした" } });
  mocks.syncResponse = () => Response.json({ synced: false, status: "awaiting_readback" });
  await gateway.onMessageImpl(message("kettle-2", "やかんの注ぎ口の掃除はクエン酸より重曹が向いている", clock - 1000));
  await gateway.experienceTick();
  expect(syncCalls().at(-1)!.body.revision).toBe(2);
  expect(syncCalls().at(-1)!.body.baselineUpdatedAt).toBeUndefined();

  // Once a write hands back a token, every later attempt carries it.
  clock += 3600_000; vi.setSystemTime(clock);
  mocks.syncResponse = () => Response.json({ synced: true, operation: "updated", updatedAt: "2026-09-30T00:00:00.000Z", nodeId: NODE_ID });
  await gateway.experienceTick();
  expect(syncCalls().at(-1)!.body.baselineUpdatedAt).toBeUndefined(); // This attempt still had none.

  clock += 86400_000; vi.setSystemTime(clock);
  mocks.extraction = JSON.stringify([{ sourceId: "kettle-3", quote: "やかんの注ぎ口の掃除は重曹を溶かした湯で拭くのがよい",
    interpretation: "拭き方まで決めた", kind: "discovery" }]);
  // Deliberately a retelling: sharing a 12-character run with the original would be rejected as a quote.
  mocks.review = JSON.stringify({ publishable: true, summary: { observation: "粉を湯に溶いてから拭き取るとよいと分かった",
    takeaway: "手順まで決めておきたい" } });
  // The Garden says a person edited it since our write: do not resolve that by overwriting.
  mocks.syncResponse = () => Response.json({ synced: false, status: "conflict" }, { status: 409 });
  await gateway.onMessageImpl(message("kettle-3", "やかんの注ぎ口の掃除は重曹を溶かした湯で拭くのがよい", clock - 1000));
  await gateway.experienceTick();
  const guarded = syncCalls().at(-1)!.body;
  expect(guarded.revision).toBe(3);
  expect(guarded.baselineUpdatedAt).toBe("2026-09-30T00:00:00.000Z");

  // It stays unsynced and is not retried inside the hold window.
  const before = syncCalls().length;
  clock += 3600_000; vi.setSystemTime(clock);
  await gateway.experienceTick();
  expect(syncCalls()).toHaveLength(before);
});

it("asks the Worker only for the nodes it created, never for the Garden as a whole", async () => {
  const pulls = mocks.worker.filter(c => c.path === "/internal/experiences/pull");
  expect(pulls.length).toBeGreaterThan(0);
  for (const pull of pulls) {
    // Bounded by node id. No gardenId, no "give me everything" shape.
    expect(Array.isArray(pull.body.nodes)).toBe(true);
    expect(pull.body.threadIds).toBeUndefined();
    expect(pull.body.gardenId).toBeUndefined();
    expect(pull.body.nodes.length).toBeLessThanOrEqual(20);
    for (const node of pull.body.nodes) {
      expect(node.nodeId).toBe(NODE_ID);
      expect(node.threadId).toMatch(/^[a-f0-9]{64}$/);
    }
  }
  // Retraction is addressed the same way.
  for (const retract of mocks.worker.filter(c => c.path === "/internal/experiences/retract")) {
    expect(retract.body).toMatchObject({ nodeId: NODE_ID });
    expect(retract.body.threadId).toMatch(/^[a-f0-9]{64}$/);
  }
});
