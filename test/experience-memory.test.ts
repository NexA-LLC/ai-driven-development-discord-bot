import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExperienceStore, RETENTION_MS, type ExperienceSource } from "../src/gateway/experience-memory.js";
import { copiesVerbatim, publicExperience, publicExperienceBody, publicExperienceSourceKey, safePublicSummary } from "../src/shared/public-experience.js";

const dirs: string[] = [];
function setup() {
  const path = join(mkdtempSync(join(tmpdir(), "su-memory-test-")), "state.json"); dirs.push(path.slice(0, path.lastIndexOf("/")));
  return { path, store: new ExperienceStore(path) };
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const now = Date.now();
const day = 86400_000;
const quote = "正解のない4択は用語を分けた方がよい";
const source: ExperienceSource = { id: "source-1", guildId: "guild", channelId: "channel", at: now - 1000, role: "human", content: `${quote}。面白い発見でした。` };
const candidate = { sourceId: source.id, quote, interpretation: "クイズと投票を区別して説明したい", kind: "discovery" };
// A cleared retelling: says the same thing in different words, names nobody, quotes nothing.
const summary = { observation: "唯一の正解を決めない四択の呼び方について意見をもらった",
  takeaway: "投票と呼ぶほうが誤解が少ないのかもしれないと考えている" };
const approve = (s = summary) => async () => JSON.stringify({ publishable: true, summary: s });
const refuse = async () => JSON.stringify({ publishable: false });
/** Runs the real review gate so a test memory reaches the publishable state the way production does. */
async function clear(store: ExperienceStore, reviewer = approve(), now2 = now) {
  await store.review(reviewer, () => true, now2);
}

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
  const memory = restarted.list(now)[0]!;
  expect(memory).toMatchObject({ quote, interpretation: candidate.interpretation, sourceId: source.id, at: source.at, revision: 1 });
  expect(memory.threadId).toBe(memory.id);
  restarted.markMused([memory.id], now);
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

// --- B: one thread across days, updated with evidence, no date-keyed duplicates ---
it("keeps the next day's continuation on one thread, updates it with grounds, and never adds a second memory", async () => {
  const { store } = setup();
  store.enqueue("day-1", [source], now);
  await store.analyse(async () => JSON.stringify([candidate]), now);
  const first = store.list(now)[0]!;

  const later: ExperienceSource = { ...source, id: "source-2", at: now + day, content: "正解のない4択は用語を分けるより、投票と呼ぶのが一番わかりやすい" };
  store.enqueue("day-2", [later], now + day);
  await store.analyse(async () => JSON.stringify([{ sourceId: later.id, quote: "正解のない4択は用語を分けるより、投票と呼ぶのが一番わかりやすい",
    interpretation: "分け方より呼び方を変える方が伝わると考え直した", kind: "changed_mind" }]), now + day);

  const memories = store.list(now + day);
  expect(memories).toHaveLength(1);
  const updated = memories[0]!;
  expect(updated.threadId).toBe(first.threadId);
  expect(updated.revision).toBe(2);
  expect(updated.kind).toBe("changed_mind");
  expect(updated.sourceId).toBe(later.id);
  // The earlier grounds stay as history so a change of mind keeps its reason.
  expect(updated.history).toHaveLength(1);
  expect(updated.history[0]).toMatchObject({ sourceId: source.id, quote });
  expect(store.status("day-2")).toBe("success_found");
});
it("treats an unchanged repeat, a replay and a date-only change as no-op with zero Garden writes", async () => {
  const { store } = setup();
  store.enqueue("first", [source], now);
  await store.analyse(async () => JSON.stringify([candidate]), now);
  await clear(store);
  const send = vi.fn().mockResolvedValue("synced" as const);
  await store.sync(send); expect(send).toHaveBeenCalledOnce();

  // Same conversation re-analysed on a later day, producing the same candidate.
  store.enqueue("repeat", [source], now + day);
  await store.analyse(async () => JSON.stringify([candidate]), now + day);
  expect(store.status("repeat")).toBe("success_no_change");
  // A different message id quoting exactly the same thing still changes nothing.
  store.enqueue("empty-day", [{ ...source, id: "source-3", at: now + 2 * day }], now + 2 * day);
  await store.analyse(async () => "[]", now + 2 * day);
  expect(store.status("empty-day")).toBe("success_empty");

  expect(store.list(now + 2 * day)).toHaveLength(1);
  expect(store.list(now + 2 * day)[0]!.revision).toBe(1);
  await store.sync(send, () => true, undefined, now + 2 * day);
  expect(send).toHaveBeenCalledOnce(); // No memory change means no second write.
});
it("never merges threads across channel or guild, and keeps them separately recallable", async () => {
  const { store } = setup();
  const others: ExperienceSource[] = [
    { ...source, id: "other-channel", channelId: "channel-b" },
    { ...source, id: "other-guild", guildId: "guild-b" },
  ];
  store.enqueue("a", [source], now);
  await store.analyse(async () => JSON.stringify([candidate]), now);
  for (const other of others) {
    store.enqueue(other.id, [other], now);
    await store.analyse(async () => JSON.stringify([{ ...candidate, sourceId: other.id }]), now);
  }
  const threads = new Set(store.list(now).map(m => m.threadId));
  expect(store.list(now)).toHaveLength(3);
  expect(threads.size).toBe(3);
  expect(store.select("guild", "channel", quote, false, now)).toHaveLength(1);
  expect(store.select("guild-b", "channel", quote, false, now)).toHaveLength(1);
});

// --- D/F: read-back, expiry and deletion are maintenance, never a new report ---
it("reads back a human Garden edit for a known thread only, and drops it on scope mismatch", async () => {
  const { store } = setup();
  store.enqueue("event", [source], now);
  await store.analyse(async () => JSON.stringify([candidate]), now);
  const threadId = store.list(now)[0]!.threadId;
  store.applyEditorNotes([
    { threadId, body: "店長の補足: 投票という言い方で統一した", updatedAt: "2026-09-17T00:00:00.000Z" },
    { threadId: "f".repeat(64), body: "別Gardenの運営メモ", updatedAt: "2026-09-17T00:00:00.000Z" },
  ]);
  const reference = store.list(now)[0]!;
  expect(reference.editorNote?.body).toContain("投票という言い方で統一した");
  expect(JSON.stringify(store.list(now))).not.toContain("別Gardenの運営メモ");
});
it("expires at original source time, retracts the public copy, and keeps sync outcomes honest", async () => {
  const { store, path } = setup(); store.enqueue("event", [source], now);
  await store.analyse(async () => JSON.stringify([candidate]), now);
  await clear(store);
  // An unavailable or read-only Garden is never recorded as a completed sync.
  const send = vi.fn().mockRejectedValueOnce(new Error("DG failure"))
    .mockResolvedValueOnce("not_configured" as const).mockResolvedValueOnce("update_unsupported" as const)
    .mockResolvedValueOnce("conflict" as const).mockResolvedValue("synced" as const);
  let clock = now;
  for (let i = 0; i < 4; i++) {
    await store.sync(send, () => true, undefined, clock);
    expect(store.list(now)[0]?.synced).toBe(false);
    clock += 7 * 3600_000;
  }
  await store.sync(send, () => true, undefined, clock);
  expect(store.list(now)[0]?.synced).toBe(true);
  expect(store.list(now)[0]?.syncedRevision).toBe(1);
  // Every retry carried the same thread identity, so nothing could be created twice.
  expect(new Set(send.mock.calls.map(c => c[0].threadId)).size).toBe(1);

  const retract = vi.fn().mockResolvedValue(true);
  const restarted = new ExperienceStore(path);
  restarted.removeSource(source.id);
  expect(restarted.list(now)).toEqual([]);
  await restarted.sync(send, () => true, retract, clock);
  expect(retract).toHaveBeenCalledWith(store.list(now)[0]?.threadId ?? expect.any(String));
  expect(send).toHaveBeenCalledTimes(5); // Retraction is not a new publication.
});
it("expiry retracts instead of writing a fresh node", async () => {
  const { store } = setup(); store.enqueue("event", [source], now);
  await store.analyse(async () => JSON.stringify([candidate]), now);
  await clear(store);
  await store.sync(async () => "synced");
  const send = vi.fn().mockResolvedValue("synced" as const);
  const retract = vi.fn().mockResolvedValue(true);
  store.prune(source.at + RETENTION_MS + 1);
  await store.sync(send, () => true, retract, source.at + RETENTION_MS + 1);
  expect(retract).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
});

// --- C: nothing published is a copy, and nothing unsafe is published at all ---
const nameQuote = "竹村也哉が四択の呼び方を投票にしようと言っていた";
const privateQuote = "来月の値上げはまだ社外に出していないけど四択の呼び方も変える予定";
async function review(store: ExperienceStore, quoteText: string, reviewer: () => Promise<string>) {
  const src: ExperienceSource = { ...source, id: `s-${quoteText.length}-${quoteText.slice(0, 2)}`, content: `${quoteText}。` };
  store.enqueue(src.id, [src], now);
  await store.analyse(async () => JSON.stringify([{ sourceId: src.id, quote: quoteText, interpretation: "呼び方を見直したい", kind: "interest" }]), now);
  await store.review(reviewer, m => m.sourceId === src.id, now);
  return store.list(now).find(m => m.sourceId === src.id)!;
}

it("never publishes an ordinary personal name, even without an honorific", async () => {
  const { store } = setup();
  // The reviewer is the gate for names regex cannot see; a refusal means no node exists at all.
  const refused = await review(store, nameQuote, refuse);
  expect(refused.publicReview).toBe("rejected");
  expect(refused.publicSummary).toBeNull();
  expect(publicExperience(refused)).toBeNull();
  const send = vi.fn().mockResolvedValue("synced" as const);
  await store.sync(send, () => true, undefined, now);
  expect(send).not.toHaveBeenCalled();
  // And if the reviewer were wrong and carried the name through, the structural gate still refuses.
  expect(safePublicSummary({ observation: "竹村也哉が四択の呼び方を投票にしようと言っていた", takeaway: "呼び方を見直したい" }, nameQuote)).toBeNull();
});
it("never publishes private content that was never labelled a secret", async () => {
  const { store } = setup();
  const refused = await review(store, privateQuote, refuse);
  expect(refused.publicReview).toBe("rejected");
  expect(publicExperience(refused)).toBeNull();
  expect(JSON.stringify(store.list(now))).toContain(privateQuote); // Still remembered privately.
  const send = vi.fn().mockResolvedValue("synced" as const);
  await store.sync(send, () => true, undefined, now);
  expect(send).not.toHaveBeenCalled();
});
it("refuses any summary that copies the original wording, however it is dressed up", async () => {
  const { store } = setup();
  const copied = await review(store, nameQuote, async () => JSON.stringify({ publishable: true,
    summary: { observation: `ある人が「${nameQuote}」と話していた`, takeaway: "呼び方を見直したい" } }));
  expect(copied.publicReview).toBe("rejected");
  expect(copied.publicSummary).toBeNull();
  expect(copiesVerbatim("ある人が四択の呼び方を投票にしようと言っていたそうだ", nameQuote)).toBe(true);
  // A genuine retelling of the same event is not a copy.
  expect(copiesVerbatim("唯一の正解を決めない四択の呼び方の話が出た", nameQuote)).toBe(false);
});
it("keeps two anonymised experiences concretely different, and publishes no boilerplate node", async () => {
  const base = { threadId: "a".repeat(64), revision: 1, at: now, kind: "discovery" as const };
  const quizItem = publicExperience({ ...base, publicSummary: summary })!;
  const wearItem = publicExperience({ ...base, threadId: "b".repeat(64), kind: "interest",
    publicSummary: { observation: "腕時計側の通知が二重に出る現象の話になった", takeaway: "重複の原因を確かめたいと思っている",
      openQuestion: "同じ通知が二度届くのはどこの層の問題なのか" } })!;
  const quizBody = JSON.stringify(publicExperienceBody(quizItem));
  const wearBody = JSON.stringify(publicExperienceBody(wearItem));
  expect(quizBody).not.toBe(wearBody);
  expect(quizBody).toContain("唯一の正解を決めない四択の呼び方");
  expect(wearBody).toContain("通知が二重に出る");
  expect(wearBody).toContain("残る問い");
  expect(wearItem.openQuestion).toBeTruthy();
  expect(quizItem.topic).toBe("quiz_terminology");
  for (const body of [quizBody, wearBody]) {
    expect(body).not.toContain(quote);       // No original wording anywhere.
    expect(body).not.toContain("竹村");
    expect(body).toContain("原文の引用ではなく");
  }
  expect(quizBody).toContain(publicExperienceSourceKey("a".repeat(64)));
});
it("rejects identifiers, secrets and out-of-range summaries at the structural gate", () => {
  for (const bad of [
    { observation: "田中さんが呼び方の話をしていた", takeaway: "見直したい" },
    { observation: "<@12345> が呼び方の話をしていた", takeaway: "見直したい" },
    { observation: "詳しくは https://example.com/内部資料 にある", takeaway: "見直したい" },
    { observation: "api_key=sk-abcdef12 を共有された", takeaway: "見直したい" },
    { observation: "ここだけの話として聞いた設問の呼び方", takeaway: "見直したい" },
    { observation: "短い", takeaway: "見直したい" },
    { observation: "呼び方の話が出た", takeaway: "" },
    { observation: "呼び方の話が出た" },
    { observation: "呼び方の話が出た", takeaway: "見直したい", extra: "混入" },
  ]) expect(safePublicSummary(bad, quote)).toBeNull();
  expect(safePublicSummary(summary, quote)).toEqual(summary);
});
it("retries a reviewer that is unreachable instead of treating it as a refusal", async () => {
  const { store } = setup();
  store.enqueue("event", [source], now);
  await store.analyse(async () => JSON.stringify([candidate]), now);
  await store.review(undefined, () => true, now);
  expect(store.list(now)[0]!.publicReview).toBe("not_run");
  await store.review(async () => { throw new Error("LLM down"); }, () => true, now + 600_000);
  expect(store.list(now)[0]!.publicReview).toBe("pending");
  const send = vi.fn().mockResolvedValue("synced" as const);
  await store.sync(send, () => true, undefined, now + 600_000);
  expect(send).not.toHaveBeenCalled(); // Unknown is not permission to publish.
  await store.review(approve(), () => true, now + 2 * 3600_000);
  expect(store.list(now)[0]!.publicReview).toBe("approved");
  await store.sync(send, () => true, undefined, now + 2 * 3600_000);
  expect(send).toHaveBeenCalledOnce();
});
it("makes a new revision re-earn its clearance instead of inheriting the old one", async () => {
  const { store } = setup();
  store.enqueue("day-1", [source], now);
  await store.analyse(async () => JSON.stringify([candidate]), now);
  await clear(store);
  const send = vi.fn().mockResolvedValue("synced" as const);
  await store.sync(send); expect(send).toHaveBeenCalledOnce();

  const later: ExperienceSource = { ...source, id: "source-2", at: now + day, content: "正解のない4択は用語を分けるより、投票と呼ぶのが一番わかりやすい" };
  store.enqueue("day-2", [later], now + day);
  await store.analyse(async () => JSON.stringify([{ sourceId: later.id, quote: later.content,
    interpretation: "分け方より呼び方を変える方が伝わると考え直した", kind: "changed_mind" }]), now + day);
  expect(store.list(now + day)[0]).toMatchObject({ revision: 2, publicReview: "pending", publicSummary: null });
  await store.sync(send, () => true, undefined, now + day);
  expect(send).toHaveBeenCalledOnce(); // Revision 2 is not published on revision 1's clearance.
  await clear(store, approve({ observation: "呼び方を分けるより投票と言う方が伝わるという話になった", takeaway: "前の考えを改めた" }), now + day);
  await store.sync(send, () => true, undefined, now + day);
  expect(send).toHaveBeenCalledTimes(2);
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
it("reads a state file written before threading and adopts the old id as the thread identity", () => {
  const { path } = setup();
  const legacy = { id: "d".repeat(64), sourceId: source.id, guildId: "guild", channelId: "channel", quote,
    interpretation: candidate.interpretation, kind: "discovery", at: source.at, expiresAt: source.at + RETENTION_MS,
    synced: true, lastMusedAt: 0, musingHeldUntil: 0 };
  writeFileSync(path, JSON.stringify({ memories: [legacy], jobs: [] }));
  const store = new ExperienceStore(path);
  expect(store.available).toBe(true);
  expect(store.list(now)[0]).toMatchObject({ threadId: legacy.id, revision: 1, syncedRevision: 1, history: [], editorNote: null });
});
it("ineligible or failing sync candidates do not starve later memories", async () => {
  const { store } = setup();
  const topics = ["朝の電車が遅れる理由", "味噌汁の出汁の取り方", "自転車のブレーキ調整", "熱帯魚の水換え周期",
    "shell scriptのquote規則", "図書館の予約棚の番号", "紅茶の抽出温度", "将棋の穴熊の弱点",
    "天体望遠鏡のピント合わせ", "毛糸の太さと編み針", "古いレンズの絞り羽根", "登山靴の防水手入れ"];
  for (const [i, topic] of topics.entries()) {
    const id = `source-${i}`;
    store.enqueue(`event-${i}`, [{ ...source, id, content: `${topic}について聞いた。面白い発見でした。` }], now);
    await store.analyse(async () => JSON.stringify([{ sourceId: id, quote: topic, interpretation: `${topic}を調べたい`, kind: "discovery" }]), now);
  }
  expect(store.list(now)).toHaveLength(12);
  // The gate reviews a few per pass, so run it until every memory has a verdict.
  for (let i = 0; i < 12; i++) await clear(store, approve({ observation: `内容${i}についての一般化した気づきをまとめた`, takeaway: `扱い方を見直したいと考えている${i}` }));
  const selected = vi.fn().mockResolvedValue("failed" as const);
  await store.sync(selected, m => m.sourceId === "source-11");
  expect(selected).toHaveBeenCalledOnce(); expect(selected.mock.calls[0][0].sourceId).toBe("source-11");
  const retry = vi.fn().mockRejectedValue(new Error("DG unavailable"));
  let clock = now + 3600_000;
  await store.sync(retry, () => true, undefined, clock);
  clock += 3600_000;
  await store.sync(retry, () => true, undefined, clock);
  expect(new Set(retry.mock.calls.map(call => call[0].id)).size).toBe(12);
});
it("never turns a secret-bearing message into a memory or a public copy", async () => {
  const { store } = setup();
  const secret: ExperienceSource = { ...source, id: "secret", content: "api_key=sk-abcdef12 を共有します" };
  store.enqueue("secret-job", [secret], now);
  expect(store.status("secret-job")).toBeUndefined(); // Never queued, so never sent to the LLM.
  store.enqueue("mixed", [source, secret], now);
  await store.analyse(async () => JSON.stringify([{ sourceId: "secret", quote: "api_key=sk-abcdef12 を共有します",
    interpretation: "共有された", kind: "discovery" }]), now);
  expect(store.status("mixed")).toBe("failed");
  expect(store.list(now)).toEqual([]);
});
