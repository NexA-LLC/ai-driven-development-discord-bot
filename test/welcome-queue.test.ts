import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WelcomeQueue, fallbackWelcome } from "../src/gateway/welcome-queue.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "welcome-queue-"));
  dirs.push(dir);
  const path = join(dir, "welcome.json");
  return { path, queue: new WelcomeQueue(path) };
};

it("persists failed welcomes and retries them with bounded backoff", () => {
  const { path, queue } = setup();
  const now = Date.parse("2026-09-22T00:00:00Z");
  expect(queue.enqueue("guild", "member", now - 1000, now)).toBe(true);
  expect(queue.enqueue("guild", "member", now - 1000, now)).toBe(false);
  const job = queue.due(now)[0]!;
  expect(queue.beginAttempt(job.key, now)).toBe(1);
  queue.defer(job.key, "LLM attempt timed out", now);
  expect(queue.due(now + 59_999)).toEqual([]);
  expect(new WelcomeQueue(path).due(now + 60_000)).toHaveLength(1);
  expect(queue.snapshot(now)).toMatchObject({ available: true, pending: 1, due: 0, sent: 0 });
});

it("retains generated content across an ambiguous send and records the receipt", () => {
  const { path, queue } = setup();
  const now = Date.parse("2026-09-22T00:00:00Z");
  queue.enqueue("guild", "member", now, now);
  const job = queue.due(now)[0]!;
  queue.beginAttempt(job.key, now);
  queue.rememberContent(job.key, "同じ本文");
  queue.defer(job.key, "network reset", now);
  const restored = new WelcomeQueue(path);
  const retry = restored.due(now + 60_000)[0]!;
  expect(retry.content).toBe("同じ本文");
  restored.beginAttempt(retry.key, now + 60_000);
  restored.sent(retry.key, "discord-message", now + 60_001);
  expect(restored.due(now + 86400_000)).toEqual([]);
  expect(restored.snapshot(now + 60_001)).toMatchObject({ pending: 0, sent: 1 });
});

it("provides a bounded fallback after repeated LLM failures", () => {
  expect(fallbackWelcome("あかせ", "ja")).toContain("いらっしゃいませ、あかせさん");
  expect(fallbackWelcome("Alex", "en")).toContain("Welcome in, Alex");
  expect(fallbackWelcome("Alex", "en").length).toBeLessThan(1800);
});
