import { expect, it, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import worker from "../src/worker/index.js";

afterEach(() => vi.unstubAllGlobals());
const env = { INTERNAL_SHARED_SECRET: "fixture-secret", DECISIONGARDEN_MCP_TOKEN: "fixture-token", DECISIONGARDEN_GARDEN_ID: "garden" };
const threadId = "a".repeat(64);
const NODE_ID = "0198f0a1-1c2d-7e3f-8a4b-5c6d7e8f9a0b";
const sourceKey = `su-experience:${threadId}`;
const BASELINE = "2026-09-17T00:00:00.000Z";
const TITLE = "スーの経験: 正解のない4択の呼び方";
function request(body: unknown, path = "/internal/experiences/sync", signed = true) {
  const raw = JSON.stringify(body); const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://worker.test" + path, { method: "POST", body: raw, headers: { "x-nexa-timestamp": timestamp,
    "x-nexa-signature": signed ? createHmac("sha256", env.INTERNAL_SHARED_SECRET).update(`${timestamp}.${raw}`).digest("hex") : "invalid" } });
}
const data = (overrides: Record<string, unknown> = {}) => ({
  id: threadId, revision: 1, at: Date.now() - 1000, topic: "quiz_terminology",
  observation: "正解のない4択は用語を分けた方がよい", takeaway: "クイズと投票を区別して説明したい", ...overrides,
});
const update = (overrides: Record<string, unknown> = {}) => data({ revision: 2, nodeId: NODE_ID, baselineUpdatedAt: BASELINE, ...overrides });
const rpc = (result: unknown) => Response.json({ result });
const structured = (value: unknown) => rpc({ structuredContent: value });
const saved = (id: unknown = NODE_ID) => structured({ operation: "created", memoryNode: { id, gardenId: "garden", sourceKey } });
/** get_memory_node answer: the Garden identity lives in `garden.id`, not inside memoryNode. */
const got = (node: Record<string, unknown> = {}, gardenId = "garden") => structured({
  garden: { id: gardenId, title: "スーの秘密日記", kind: "personal" },
  memoryNode: { id: NODE_ID, sourceKey, kind: "knowledge", state: "active", visibility: "garden",
    source: "ai-driven-development-discord-bot/gateway experience", title: TITLE,
    body: "出来事: もとの本文", updatedAt: BASELINE, ...node },
});
const notFound = () => rpc({ isError: true, content: [{ text: "memory_node_not_found" }] });
const updated = (operation: "updated" | "unchanged", body: string, overrides: Record<string, unknown> = {}) =>
  structured({ operation, expectedUpdatedAtMatched: operation === "updated",
    memoryNode: { id: NODE_ID, gardenId: "garden", sourceKey, kind: "knowledge", state: "active",
      visibility: "garden", title: TITLE, body, updatedAt: BASELINE, ...overrides } });
const args = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.map(c => JSON.parse((c[1] as RequestInit).body as string).params);
/** Replies to update_memory_node by echoing back exactly what was asked for. */
const echoUpdate = (operation: "updated" | "unchanged" = "updated", sent: Array<Record<string, unknown>> = []) =>
  async (_url: unknown, options: RequestInit) => {
    const call = JSON.parse(options.body as string).params;
    if (call.name === "get_memory_node") return got();
    sent.push(call.arguments);
    return updated(operation, call.arguments.body);
  };

it("creates one Garden node for the first revision and never files an experience as a TODO", async () => {
  const fetcher = vi.fn().mockResolvedValue(saved());
  vi.stubGlobal("fetch", fetcher);
  const result = await worker.fetch(request(data()), env as never, {} as never);
  expect(result.status).toBe(200);
  // The node id comes back so the Gateway can address this copy directly from now on.
  expect(await result.json()).toEqual({ synced: true, operation: "created", nodeId: NODE_ID });
  const [call] = args(fetcher);
  expect(call.name).toBe("save_memory_node");
  expect(call.arguments).toMatchObject({ sourceKey, kind: "knowledge", state: "active", visibility: "garden" });
  expect(JSON.stringify(call.arguments)).toContain("正解のない4択");
  expect(JSON.stringify(call.arguments)).not.toContain("sourceId");
});
it("refuses a create receipt without a usable node id", async () => {
  for (const bad of [
    structured({ operation: "created", memoryNode: { gardenId: "garden", sourceKey } }), // no id at all
    saved("node-1"),                                                                     // not a UUID
    structured({ operation: "created" }),                                                // no node at all
  ]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(bad));
    expect((await worker.fetch(request(data()), env as never, {} as never)).status).toBe(502);
  }
});

// --- Bounded addressing: one known node is read, never the whole Garden ---
it("reads exactly the one node it owns and never lists the Garden", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const fetcher = vi.fn().mockImplementation(echoUpdate("updated", sent));
  vi.stubGlobal("fetch", fetcher);
  const result = await worker.fetch(request(update({ observation: "投票と呼ぶのが一番わかりやすい" })), env as never, {} as never);
  expect(await result.json()).toEqual({ synced: true, operation: "updated", updatedAt: BASELINE, nodeId: NODE_ID });
  const calls = args(fetcher);
  expect(calls.map(c => c.name)).toEqual(["get_memory_node", "update_memory_node"]);
  expect(calls[0].arguments).toEqual({ nodeId: NODE_ID });    // No gardenId-wide read of any kind.
  expect(calls.some(c => c.name === "list_memory_nodes")).toBe(false);
  expect(calls[1].arguments).toMatchObject({ nodeId: NODE_ID, expectedUpdatedAt: BASELINE });
  expect(sent[0]!.body).toContain("投票と呼ぶのが一番わかりやすい");
  // Strict schema: provenance and lifecycle fields are rejected by the Garden, so they are never sent.
  expect(Object.keys(calls[1].arguments).sort()).toEqual(["body", "expectedUpdatedAt", "nodeId", "title"]);
  expect(calls.some(c => c.name === "save_memory_node")).toBe(false);
});
it("treats a node in another Garden, of another kind, or no longer public as not ours", async () => {
  const foreign = [
    got({}, "another-garden"),                              // garden.id must match exactly.
    got({ sourceKey: "su-experience:" + "b".repeat(64) }),  // a different thread's node.
    got({ id: "0198f0a1-0000-7000-8000-00000000ffff" }),    // not the node we asked for.
    got({ kind: "todo" }),
    got({ source: "manual" }),
    got({ state: "archived" }),
    got({ visibility: "private" }),
  ];
  for (const answer of foreign) {
    const fetcher = vi.fn().mockResolvedValue(answer);
    vi.stubGlobal("fetch", fetcher);
    const result = await worker.fetch(request(update()), env as never, {} as never);
    expect(await result.json()).toEqual({ synced: false, status: "absent" });
    expect(args(fetcher).some(c => c.name === "update_memory_node")).toBe(false);
  }
});
it("calls a node absent only when the Garden itself says so, and stays failed on any other error", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(notFound()));
  expect(await (await worker.fetch(request(update()), env as never, {} as never)).json())
    .toEqual({ synced: false, status: "absent" });

  // A transport or server problem is not evidence of absence.
  for (const broken of [new Response("boom", { status: 500 }), rpc({ isError: true, content: [{ text: "database unavailable" }] })]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(broken));
    const result = await worker.fetch(request(update()), env as never, {} as never);
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({ synced: false, status: "failed" });
  }
});
it("will not update a copy published before node ids were tracked", async () => {
  const fetcher = vi.fn().mockResolvedValue(saved());
  vi.stubGlobal("fetch", fetcher);
  const result = await worker.fetch(request(data({ revision: 2, baselineUpdatedAt: BASELINE })), env as never, {} as never);
  expect(await result.json()).toEqual({ synced: false, status: "node_unknown" });
  expect(fetcher).not.toHaveBeenCalled(); // No search of the Garden to find it, either.
});
it("refuses a node id that is not a UUID rather than sending it to the Garden", async () => {
  const fetcher = vi.fn().mockResolvedValue(got());
  vi.stubGlobal("fetch", fetcher);
  const result = await worker.fetch(request(update({ nodeId: "node-1" })), env as never, {} as never);
  expect(result.status).toBe(502);
  expect(fetcher).not.toHaveBeenCalled();
});

// --- Lost-update protection: our own last-write token is the only baseline we will write over ---
it("refuses to overwrite a human Garden edit and never writes with a freshly read token", async () => {
  const fetcher = vi.fn().mockResolvedValue(got({ updatedAt: "2026-09-18T09:00:00.000Z", body: "店長が書き直した本文" }));
  vi.stubGlobal("fetch", fetcher);
  const result = await worker.fetch(request(update()), env as never, {} as never);
  expect(result.status).toBe(409);
  expect(await result.json()).toEqual({ synced: false, status: "conflict" });
  // Read only. The node's own newer timestamp is never used as permission to overwrite it.
  expect(args(fetcher).map(c => c.name)).toEqual(["get_memory_node"]);
});
it("waits for a read-back instead of writing when it holds no baseline of its own", async () => {
  const fetcher = vi.fn().mockResolvedValue(got());
  vi.stubGlobal("fetch", fetcher);
  const result = await worker.fetch(request(data({ revision: 2, nodeId: NODE_ID })), env as never, {} as never);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ synced: false, status: "awaiting_readback" });
  expect(args(fetcher).map(c => c.name)).toEqual(["get_memory_node"]);
});
it("retrying the same body reuses the held baseline and asks the Garden for no new write", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const fetcher = vi.fn().mockImplementation(echoUpdate("unchanged", sent));
  vi.stubGlobal("fetch", fetcher);
  // The evidence timestamp is part of the body, and in production it is fixed per memory, so it is
  // pinned here too: a retry must send a byte-identical body.
  const at = Date.now() - 1000;
  for (let i = 0; i < 3; i++) {
    const result = await worker.fetch(request(update({ at })), env as never, {} as never);
    expect(await result.json()).toEqual({ synced: true, operation: "unchanged", updatedAt: BASELINE, nodeId: NODE_ID });
  }
  expect(sent.every(a => a.expectedUpdatedAt === BASELINE)).toBe(true);
  expect(new Set(sent.map(a => a.body)).size).toBe(1);
  expect(sent).toHaveLength(3);
});
it("rejects an update receipt that does not prove our content is stored", async () => {
  const echo = { id: NODE_ID, gardenId: "garden", sourceKey, title: TITLE, body: "出来事: もとの本文", updatedAt: BASELINE };
  for (const bad of [
    structured({ operation: "updated" }),
    structured({ operation: "updated", memoryNode: { ...echo, body: "誰かが書き換えた別の本文" } }),
    structured({ operation: "updated", memoryNode: { ...echo, gardenId: "other" } }),
    structured({ operation: "updated", memoryNode: { ...echo, sourceKey: "su-experience:" + "c".repeat(64) } }),
    structured({ memoryNode: echo }),
    structured({ operation: "updated", memoryNode: { ...echo, updatedAt: "" } }),
  ]) {
    const fetcher = vi.fn().mockResolvedValueOnce(got()).mockResolvedValueOnce(bad);
    vi.stubGlobal("fetch", fetcher);
    const result = await worker.fetch(request(update()), env as never, {} as never);
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({ synced: false, status: "failed" });
  }
});
it("holds on a missing scope or Garden write role instead of retrying it as a transient failure", async () => {
  for (const denial of ["forbidden", "insufficient_scope", "personal_token_required", "provenance_immutable"]) {
    const fetcher = vi.fn().mockResolvedValueOnce(got()).mockResolvedValueOnce(rpc({ isError: true, content: [{ text: denial }] }));
    vi.stubGlobal("fetch", fetcher);
    const result = await worker.fetch(request(update()), env as never, {} as never);
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ synced: false, status: "not_permitted" });
  }
});
it("reports an older Garden without an update tool as waiting, not as a completed sync", async () => {
  for (const unsupported of [
    Response.json({ error: { code: -32601, message: "method not found" } }),
    rpc({ isError: true, content: [{ text: "unknown tool: update_memory_node" }] }),
    new Response("not found", { status: 404 }),
  ]) {
    const fetcher = vi.fn().mockResolvedValueOnce(got()).mockResolvedValueOnce(unsupported);
    vi.stubGlobal("fetch", fetcher);
    const result = await worker.fetch(request(update()), env as never, {} as never);
    expect(await result.json()).toEqual({ synced: false, status: "update_unsupported" });
    expect(args(fetcher).some(c => c.name === "save_memory_node")).toBe(false);
  }
});
it("surfaces source_key_conflict and updated_at_conflict instead of a silent no_change success", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(rpc({ isError: true, content: [{ text: "source_key_conflict" }] })));
  let result = await worker.fetch(request(data()), env as never, {} as never);
  expect(result.status).toBe(409);
  expect(await result.json()).toEqual({ synced: false, status: "conflict" });

  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(got())
    .mockResolvedValueOnce(rpc({ isError: true, content: [{ text: "updated_at_conflict" }] })));
  result = await worker.fetch(request(update()), env as never, {} as never);
  expect(result.status).toBe(409);
  expect(await result.json()).toEqual({ synced: false, status: "conflict" });
});
it("does not treat an accepted-only or mismatched save receipt as a saved node", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(rpc({ content: [{ text: '{"ok":true}' }] }))
    .mockResolvedValueOnce(structured({ memoryNode: { id: NODE_ID, gardenId: "other", sourceKey: "other" } })));
  for (let i = 0; i < 2; i++) {
    const result = await worker.fetch(request(data()), env as never, {} as never);
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({ synced: false, status: "failed" });
  }
});
it("rejects unsigned, stale, or arbitrary public prose and reports missing DG configuration explicitly", async () => {
  for (const req of [request(data(), undefined, false), request({ ...data(), quote: "secret" }), request({ ...data(), at: 1 }),
    request({ ...data(), observation: "" }), request({ ...data(), revision: 0 })]) {
    expect((await worker.fetch(req, env as never, {} as never)).status).toBeGreaterThanOrEqual(400);
  }
  const result = await worker.fetch(request(data()), { INTERNAL_SHARED_SECRET: env.INTERNAL_SHARED_SECRET } as never, {} as never);
  expect(await result.json()).toEqual({ synced: false, status: "not_configured" });
});

// --- Retraction and read-back, both addressed by node id ---
it("retracts by node id, and calls it absent only on a direct not-found", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(got()).mockResolvedValueOnce(structured({ operation: "updated", memoryNode: { id: NODE_ID } }));
  vi.stubGlobal("fetch", fetcher);
  const archived = await worker.fetch(request({ threadId, nodeId: NODE_ID }, "/internal/experiences/retract"), env as never, {} as never);
  expect(await archived.json()).toEqual({ retracted: true, status: "archived" });
  expect(args(fetcher).map(c => c.name)).toEqual(["get_memory_node", "set_memory_node_lifecycle"]);
  expect(args(fetcher)[1]!.arguments).toEqual({ nodeId: NODE_ID, state: "archived", visibility: "private" });

  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(notFound()));
  const absent = await worker.fetch(request({ threadId, nodeId: NODE_ID }, "/internal/experiences/retract"), env as never, {} as never);
  expect(await absent.json()).toEqual({ retracted: true, status: "absent" });

  // A copy from before node ids were tracked is reported, not hunted for across the Garden.
  const blind = vi.fn();
  vi.stubGlobal("fetch", blind);
  const unknown = await worker.fetch(request({ threadId }, "/internal/experiences/retract"), env as never, {} as never);
  expect(await unknown.json()).toEqual({ retracted: false, status: "node_unknown" });
  expect(blind).not.toHaveBeenCalled();
  expect((await worker.fetch(request({ threadId: "nope", nodeId: NODE_ID }, "/internal/experiences/retract"), env as never, {} as never)).status).toBe(400);
});
it("reads back only the nodes it was given, one per request, and says what it covered", async () => {
  const second = "0198f0a1-2222-7333-8444-555566667777";
  const otherThread = "e".repeat(64);
  const fetcher = vi.fn().mockImplementation(async (_url: unknown, options: RequestInit) => {
    const call = JSON.parse(options.body as string).params;
    expect(call.name).toBe("get_memory_node");
    return call.arguments.nodeId === NODE_ID
      ? got({ body: "店長の補足: 投票で統一" })
      : notFound();
  });
  vi.stubGlobal("fetch", fetcher);
  const ok = await worker.fetch(request({ nodes: [{ threadId, nodeId: NODE_ID }, { threadId: otherThread, nodeId: second }] },
    "/internal/experiences/pull"), env as never, {} as never);
  const body = await ok.json() as { status: string; covered: string[]; notes: Array<{ threadId: string; body: string }> };
  expect(body.status).toBe("ok");
  // Both reads succeeded, so both threads are covered; the one with no node has had its note removed.
  expect(body.covered).toEqual([threadId, otherThread]);
  expect(body.notes).toEqual([{ threadId, body: "店長の補足: 投票で統一", updatedAt: BASELINE }]);
  expect(args(fetcher)).toHaveLength(2);
});
it("leaves a thread out of covered when its read failed, and refuses a request with no known node", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(got({ body: "店長の補足" }))
    .mockResolvedValueOnce(new Response("boom", { status: 500 }));
  vi.stubGlobal("fetch", fetcher);
  const partial = await worker.fetch(request({ nodes: [{ threadId, nodeId: NODE_ID }, { threadId: "f".repeat(64), nodeId: "0198f0a1-2222-7333-8444-555566667777" }] },
    "/internal/experiences/pull"), env as never, {} as never);
  const body = await partial.json() as { status: string; covered: string[] };
  expect(body.status).toBe("ok");
  expect(body.covered).toEqual([threadId]); // The unreadable thread is not authoritative, so nothing is cleared for it.

  for (const bad of [{ nodes: [] }, { nodes: [{ threadId, nodeId: "node-1" }] }, { threadIds: [threadId] }]) {
    const rejected = await worker.fetch(request(bad, "/internal/experiences/pull"), env as never, {} as never);
    expect(rejected.status).toBe(400);
  }
});

// --- Nightly maintenance stays free of the Garden entirely ---
it("nightly maintenance writes nothing to the Garden and keeps statistics in the operations log", async () => {
  const first = vi.fn().mockResolvedValue({ total: 3, failed: 1 });
  const db = { prepare: () => ({ bind: () => ({ first }) }) };
  const fetcher = vi.fn().mockRejectedValue(new Error("no outbound call expected"));
  vi.stubGlobal("fetch", fetcher);
  for (const path of ["/internal/maintenance/run", "/internal/digest/run"]) {
    const result = await worker.fetch(request({}, path), { ...env, DB: db } as never, {} as never);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ ok: true, analysis: "not_run", analysisLocation: "gateway",
      gardenWrites: 0, dailyReport: "discontinued", replies: 3, failed: 1, statsDestination: "operations_log" });
  }
  expect(fetcher).not.toHaveBeenCalled();
});
it("the deprecated su_run_digest tool creates no daily node", async () => {
  const db = { prepare: () => ({ bind: () => ({ first: vi.fn().mockResolvedValue({ total: 0, failed: 0 }) }) }) };
  const fetcher = vi.fn().mockRejectedValue(new Error("no outbound call expected"));
  vi.stubGlobal("fetch", fetcher);
  const call = new Request("https://worker.test/api/mcp", { method: "POST", headers: { authorization: "Bearer su-token", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "su_run_digest", arguments: {} } }) });
  const result = await worker.fetch(call, { ...env, DB: db, SU_MCP_TOKEN: "su-token" } as never, {} as never);
  const payload = JSON.parse((await result.json() as any).result.content[0].text);
  expect(payload).toMatchObject({ ran: true, deprecated: true, gardenWrites: 0, dailyReport: "discontinued" });
  expect(fetcher).not.toHaveBeenCalled();

  const tools = await worker.fetch(new Request("https://worker.test/api/mcp", { method: "POST", headers: { authorization: "Bearer su-token", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }), { ...env, DB: db, SU_MCP_TOKEN: "su-token" } as never, {} as never);
  const listedTools = (await tools.json() as any).result.tools as Array<{ name: string; description: string }>;
  expect(listedTools.find(t => t.name === "su_run_digest")?.description).toContain("非推奨");
});
it("the Worker cron runs maintenance only and creates no Garden node", async () => {
  const db = { prepare: () => ({ bind: () => ({ first: vi.fn().mockResolvedValue({ total: 5, failed: 0 }) }) }) };
  const fetcher = vi.fn().mockRejectedValue(new Error("no outbound call expected"));
  vi.stubGlobal("fetch", fetcher);
  const waits: Array<Promise<unknown>> = [];
  await worker.scheduled({} as never, { ...env, DB: db } as never, { waitUntil: (p: Promise<unknown>) => waits.push(p) } as never);
  await Promise.all(waits);
  expect(fetcher).not.toHaveBeenCalled();
});

// --- A resend after a lost response must reach the Garden's unchanged branch, not stall on conflict ---
/**
 * Behaves like the real update_memory_node: equal content is unchanged whatever the token says,
 * a stale token with different content is updated_at_conflict, and a good write advances updatedAt.
 */
function fakeGarden(initial = { title: TITLE, body: "出来事: もとの本文", updatedAt: BASELINE }) {
  const store = { ...initial };
  let clock = 0;
  const calls: Array<{ name: string; arguments: any }> = [];
  const fetcher = vi.fn().mockImplementation(async (_url: unknown, options: RequestInit) => {
    const call = JSON.parse(options.body as string).params;
    calls.push(call);
    if (call.name === "get_memory_node") return got({ title: store.title, body: store.body, updatedAt: store.updatedAt });
    if (call.name !== "update_memory_node") throw new Error(`unexpected ${call.name}`);
    const { title, body, expectedUpdatedAt } = call.arguments;
    if (title === store.title && body === store.body) {
      return updated("unchanged", store.body, { title: store.title, updatedAt: store.updatedAt });
    }
    if (expectedUpdatedAt !== store.updatedAt) return rpc({ isError: true, content: [{ text: "updated_at_conflict" }] });
    store.title = title; store.body = body; store.updatedAt = `2026-09-2${++clock}T00:00:00.000Z`;
    return updated("updated", store.body, { title: store.title, updatedAt: store.updatedAt });
  });
  return { store, calls, fetcher };
}

it("accepts a resend whose first answer was lost, even though the Garden has already moved on", async () => {
  const garden = fakeGarden();
  vi.stubGlobal("fetch", garden.fetcher);
  const at = Date.now() - 1000;
  const body = update({ at, observation: "投票と呼ぶのが一番わかりやすい" });

  // First attempt really lands: the Garden applies it and its updatedAt advances past our baseline.
  const first = await worker.fetch(request(body), env as never, {} as never);
  expect(await first.json()).toMatchObject({ synced: true, operation: "updated" });
  const applied = garden.store.updatedAt;
  expect(applied).not.toBe(BASELINE);

  // That answer never reached the Gateway, so it retries with the same stale baseline and same body.
  const retry = await worker.fetch(request(body), env as never, {} as never);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual({ synced: true, operation: "unchanged", updatedAt: applied, nodeId: NODE_ID });
  // It reached the update tool rather than stopping at a conflict, and wrote nothing new.
  expect(garden.calls.filter(c => c.name === "update_memory_node")).toHaveLength(2);
  expect(garden.store.updatedAt).toBe(applied);

  // A third retry is still idempotent.
  const again = await worker.fetch(request(body), env as never, {} as never);
  expect(await again.json()).toMatchObject({ synced: true, operation: "unchanged", updatedAt: applied });
  expect(garden.store.updatedAt).toBe(applied);
});
it("still refuses to overwrite when the Garden moved because a person rewrote it", async () => {
  const garden = fakeGarden();
  vi.stubGlobal("fetch", garden.fetcher);
  const at = Date.now() - 1000;

  // Our update lands, then a person edits the node afterwards.
  await worker.fetch(request(update({ at, observation: "投票と呼ぶのが一番わかりやすい" })), env as never, {} as never);
  garden.store.body = "店長が全部書き直した本文";
  garden.store.updatedAt = "2026-09-25T00:00:00.000Z";
  const before = { ...garden.store };

  // A retry of our own revision must not resolve that by overwriting.
  const result = await worker.fetch(request(update({ at, observation: "投票と呼ぶのが一番わかりやすい" })), env as never, {} as never);
  expect(result.status).toBe(409);
  expect(await result.json()).toEqual({ synced: false, status: "conflict" });
  expect(garden.store).toEqual(before);
  // It stopped at the read and never asked the Garden to write.
  expect(garden.calls.filter(c => c.name === "update_memory_node")).toHaveLength(1);
});
