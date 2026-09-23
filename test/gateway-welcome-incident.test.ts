import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GuildMember } from "discord.js";
import { WelcomeQueue } from "../src/gateway/welcome-queue.js";

const mocks = vi.hoisted(() => ({
  client: {
    on: vi.fn(), once: vi.fn(), login: vi.fn(),
    guilds: { fetch: vi.fn() }, channels: { fetch: vi.fn() },
  },
  members: new Map<string, unknown>(),
  workerCalls: [] as Array<{ path: string; body: Record<string, unknown> }>,
  llmMode: "timeout" as "timeout" | "success",
  sendFails: false,
  send: vi.fn(),
}));
vi.mock("discord.js", async () => ({ ...await vi.importActual("discord.js"), Client: class { constructor() { return mocks.client; } } }));
vi.mock("../src/gateway/voice-chat.js", () => ({ VoiceChat: class {} }));

const stateDir = mkdtempSync(join(tmpdir(), "su-welcome-incident-"));
const start = Date.parse("2026-09-23T12:49:00Z");
let gateway: typeof import("../src/gateway/index.js");
const incidents = () => mocks.workerCalls.filter(call => call.path === "/internal/incidents");
const recoveries = () => mocks.workerCalls.filter(call => call.path === "/internal/incidents/resolve");
const storedJob = (memberId: string) => {
  const queue = new WelcomeQueue(join(stateDir, "welcome-queue.json"));
  const job = queue.due(Number.MAX_SAFE_INTEGER).find(item => item.memberId === memberId);
  return { queue, job };
};
const member = (id: string): GuildMember => {
  const value = { id, joinedTimestamp: Date.now(), displayName: `member-${id}`,
    user: { bot: false, username: `member-${id}` }, guild: { id: "guild" } };
  mocks.members.set(id, value);
  return value as unknown as GuildMember;
};

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  for (const [key, value] of Object.entries({
    SU_STATE_DIR: stateDir, DISCORD_BOT_TOKEN: "fixture", WORKER_INTERNAL_URL: "https://worker.test",
    INTERNAL_SHARED_SECRET: "fixture", DISCORD_GUILD_ID: "guild", WELCOME_CHANNEL_ID: "welcome",
    LLM_API_URL: "https://llm.test/chat", LLM_MAX_ATTEMPTS: "1", LLM_CIRCUIT_FAILURES: "10",
  })) vi.stubEnv(key, value);
  mocks.client.guilds.fetch.mockResolvedValue({ members: { fetch: async (id: string) => mocks.members.get(id) } });
  mocks.send.mockImplementation(async () => {
    if (mocks.sendFails) throw new Error("Discord send unavailable");
    return { id: `receipt-${mocks.send.mock.calls.length}` };
  });
  mocks.client.channels.fetch.mockResolvedValue({ send: mocks.send });
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, options: RequestInit) => {
    if (String(url).includes("worker.test")) {
      const path = new URL(String(url)).pathname;
      mocks.workerCalls.push({ path, body: JSON.parse(String(options.body ?? "{}")) });
      return Response.json({ ok: true });
    }
    if (mocks.llmMode === "success") {
      return Response.json({ choices: [{ message: { role: "assistant", content: "ようこそ。スーです。" } }] });
    }
    return new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    });
  }));
  gateway = await import("../src/gateway/index.js");
});

afterAll(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

it("keeps two timed-out generations quiet and sends the fallback without an incident", async () => {
  mocks.workerCalls.length = 0;
  gateway.enqueueWelcome(member("slow"));
  for (let attempt = 1; attempt <= 2; attempt++) {
    const processing = gateway.processWelcomeQueue();
    await vi.advanceTimersByTimeAsync(45_000);
    await processing;
    expect(incidents()).toHaveLength(0);
    const { job } = storedJob("slow");
    expect(job).toMatchObject({ attempts: attempt, status: "pending" });
    vi.setSystemTime(job!.nextAttemptAt);
  }
  await gateway.processWelcomeQueue();
  expect(mocks.send).toHaveBeenCalledOnce();
  expect(mocks.send.mock.calls[0]?.[0].content).toContain("Welcome in, member-slow");
  expect(incidents()).toHaveLength(0);
  expect(storedJob("slow").queue.snapshot()).toMatchObject({ pending: 0, sent: 1 });
});

it("alerts after the third failed delivery and resolves only when the stalled welcome is sent", async () => {
  mocks.workerCalls.length = 0;
  mocks.llmMode = "success";
  mocks.sendFails = true;
  gateway.enqueueWelcome(member("stalled"));
  for (let attempt = 1; attempt <= 3; attempt++) {
    await gateway.processWelcomeQueue();
    expect(incidents()).toHaveLength(attempt === 3 ? 1 : 0);
    const { job } = storedJob("stalled");
    expect(job).toMatchObject({ attempts: attempt, status: "pending" });
    if (attempt < 3) vi.setSystemTime(job!.nextAttemptAt);
  }
  expect(incidents()[0]?.body).toMatchObject({ kind: "welcome_failed" });
  expect(storedJob("stalled").queue.hasEscalatedPending()).toBe(true);

  mocks.sendFails = false;
  gateway.enqueueWelcome(member("other"));
  await gateway.processWelcomeQueue();
  expect(recoveries()).toHaveLength(0);

  vi.setSystemTime(storedJob("stalled").job!.nextAttemptAt);
  await gateway.processWelcomeQueue();
  expect(storedJob("stalled").queue.snapshot()).toMatchObject({ pending: 0, sent: 3 });
  expect(recoveries()).toHaveLength(1);
});
