import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExperienceStore, RETENTION_MS, type ExperienceSource } from "../src/gateway/experience-memory.js";
import { publicExperience, publicExperienceBody } from "../src/shared/public-experience.js";

const dirs: string[] = [];
function setup() {
  const path = join(mkdtempSync(join(tmpdir(), "su-memory-test-")), "state.json"); dirs.push(path.slice(0, path.lastIndexOf("/")));
  return { path, store: new ExperienceStore(path) };
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const now = Date.now();
const quote = "正解のない4択は用語を分けた方がよい";
const source: ExperienceSource = { id: "source-1", guildId: "guild", channelId: "channel", at: now - 1000, role: "human", content: `${quote}。面白い発見でした。` };
const candidate = { sourceId: source.id, quote, interpretation: "クイズと投票を区別して説明したい", kind: "discovery" };

it("extracts ordinary useful conversation, separates exact evidence, recalls by topic/scope, upserts across restart", async () => {
  const { store, path } = setup(); store.enqueue("event", [source], now);
  const complete = vi.fn(async messages => { expect(messages[0].content).toContain("苦情に限定しない"); return JSON.stringify([candidate]); });
  await store.analyse(complete, now);
  const restarted = new ExperienceStore(path);
  restarted.enqueue("event", [source], now); await restarted.analyse(complete, now);
  expect(complete).toHaveBeenCalledOnce();
  expect(restarted.status("event")).toBe("success_found");
  expect(restarted.select("guild", "channel", "正解のない4択の用語は？", false, now)).toHaveLength(1);
  expect(restarted.select("guild", "else", "正解のない4択の用語", false, now)).toEqual([]);
  expect(restarted.select("else", "channel", "正解のない4択の用語", false, now)).toEqual([]);
  expect(restarted.select("guild", "channel", "今日の天気", false, now)).toEqual([]);
  expect(JSON.parse(readFileSync(path, "utf8")).jobs[0].sources).toEqual([]);
  expect(restarted.list(now)[0]).toMatchObject({ quote, interpretation: candidate.interpretation, sourceId: source.id, at: source.at });
  restarted.markMused([restarted.list(now)[0]!.id], now);
  expect(restarted.select("guild", "channel", "", true, now + 3600_000)).toEqual([]);
});
it.each([
  { ...candidate, sourceId: "invented" }, { ...candidate, quote: "誰も言っていない発言" },
])("rejects invented evidence: %j", async bad => {
  const { store } = setup(); store.enqueue("event", [source], now);
  await store.analyse(async () => JSON.stringify([bad]), now);
  expect(store.status("event")).toBe("failed"); expect(store.list(now)).toEqual([]);
});
it("distinguishes no provider, timeout, invalid JSON, empty success, then retries", async () => {
  const { store } = setup(); store.enqueue("event", [source], now);
  await store.analyse(undefined, now); expect(store.status("event")).toBe("not_run");
  await store.analyse(async () => { throw new Error("timeout"); }, now + 300_000); expect(store.status("event")).toBe("failed");
  await store.analyse(async () => "not JSON", now + 900_000); expect(store.status("event")).toBe("failed");
  await store.analyse(async () => "[]", now + 1800_000); expect(store.status("event")).toBe("success_empty");
});
it("expires at original source time, supports source deletion, and keeps DG failures retryable", async () => {
  const { store, path } = setup(); store.enqueue("event", [source], now);
  await store.analyse(async () => JSON.stringify([candidate]), now);
  const send = vi.fn().mockRejectedValueOnce(new Error("DG failure")).mockResolvedValueOnce(false).mockResolvedValue(true);
  await store.sync(send); expect(store.list(now)[0]?.synced).toBe(false);
  const restarted = new ExperienceStore(path); await restarted.sync(send); expect(restarted.list(now)[0]?.synced).toBe(false);
  await restarted.sync(send); expect(restarted.list(now)[0]?.synced).toBe(true);
  expect(new Set(send.mock.calls.map(c => c[0].id)).size).toBe(1);
  restarted.removeSource(source.id); expect(restarted.list(now)).toEqual([]);
  store.prune(source.at + RETENTION_MS); expect(new ExperienceStore(path).list(now)).toEqual([]);
});
it("never publishes raw excerpts, names, or Discord identifiers to the public Garden", () => {
  const projection = publicExperience({ id: "a".repeat(64), at: now, quote: `${quote}。田中さん <@12345>`, kind: "discovery" });
  const serialized = JSON.stringify(publicExperienceBody(projection));
  expect(serialized).toContain("正解を定めない4択");
  expect(serialized).not.toContain("田中"); expect(serialized).not.toContain("12345"); expect(serialized).not.toContain(quote);
});
it("caps pending work, expires unprocessed text, and never overwrites damaged state", () => {
  const { store, path } = setup();
  for (let i = 0; i < 105; i++) store.enqueue(`event-${i}`, [{ ...source, id: `source-${i}` }], now);
  expect(JSON.parse(readFileSync(path, "utf8")).jobs).toHaveLength(100);
  store.prune(source.at + RETENTION_MS);
  expect(JSON.parse(readFileSync(path, "utf8")).jobs).toEqual([]);
  writeFileSync(path, "damaged");
  const damaged = new ExperienceStore(path); expect(damaged.available).toBe(false);
  damaged.enqueue("event", [source], now); expect(damaged.list(now)).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe("damaged");
});
it("ineligible or failing sync candidates do not starve later memories", async () => {
  const { store } = setup();
  for (let i = 0; i < 12; i++) {
    const id = `source-${i}`;
    store.enqueue(`event-${i}`, [{ ...source, id }], now);
    await store.analyse(async () => JSON.stringify([{ ...candidate, sourceId: id }]), now);
  }
  const selected = vi.fn().mockResolvedValue(false);
  await store.sync(selected, m => m.sourceId === "source-11");
  expect(selected).toHaveBeenCalledOnce(); expect(selected.mock.calls[0][0].sourceId).toBe("source-11");
  const retry = vi.fn().mockRejectedValue(new Error("DG unavailable"));
  await store.sync(retry); await store.sync(retry);
  expect(new Set(retry.mock.calls.map(call => call[0].id)).size).toBe(12);
});
