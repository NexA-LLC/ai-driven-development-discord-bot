import { expect, it, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import worker from "../src/worker/index.js";

afterEach(() => vi.unstubAllGlobals());
const env = { INTERNAL_SHARED_SECRET: "fixture-secret", DECISIONGARDEN_MCP_TOKEN: "fixture-token", DECISIONGARDEN_GARDEN_ID: "garden" };
const threadId = "a".repeat(64);
const sourceKey = `su-experience:${threadId}`;
function request(body: unknown, path = "/internal/experiences/sync", signed = true) {
  const raw = JSON.stringify(body); const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://worker.test" + path, { method: "POST", body: raw, headers: { "x-nexa-timestamp": timestamp,
    "x-nexa-signature": signed ? createHmac("sha256", env.INTERNAL_SHARED_SECRET).update(`${timestamp}.${raw}`).digest("hex") : "invalid" } });
}
const data = (overrides: Record<string, unknown> = {}) => ({
  id: threadId, revision: 1, at: Date.now() - 1000, topic: "quiz_terminology",
  observation: "正解のない4択は用語を分けた方がよい", takeaway: "クイズと投票を区別して説明したい", ...overrides,
});
const rpc = (result: unknown) => Response.json({ result });
const structured = (value: unknown) => rpc({ structuredContent: value });
const saved = () => structured({ operation: "created", memoryNode: { id: "node-1", gardenId: "garden", sourceKey } });
const listed = (nodes: unknown[]) => structured({ memoryNodes: nodes });
const gardenNode = (overrides: Record<string, unknown> = {}) => ({ id: "node-1", gardenId: "garden", sourceKey, kind: "knowledge", state: "active",
  visibility: "garden", source: "ai-driven-development-discord-bot/gateway experience", body: "出来事: もとの本文", updatedAt: "2026-09-17T00:00:00.000Z", ...overrides });
const args = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.map(c => JSON.parse((c[1] as RequestInit).body as string).params);

it("creates one Garden node for the first revision and never files an experience as a TODO", async () => {
  const fetcher = vi.fn().mockResolvedValue(saved());
  vi.stubGlobal("fetch", fetcher);
  const result = await worker.fetch(request(data()), env as never, {} as never);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ synced: true, operation: "created" });
  const [call] = args(fetcher);
  expect(call.name).toBe("save_memory_node");
  expect(call.arguments).toMatchObject({ sourceKey, kind: "knowledge", state: "active", visibility: "garden" });
  expect(JSON.stringify(call.arguments)).toContain("正解のない4択");
  expect(JSON.stringify(call.arguments)).not.toContain("sourceId");
});
// DecisionGarden contract (webapp-decisiongarden update_memory_node): required expectedUpdatedAt,
// strict arg set, immutable provenance/lifecycle, and a memoryNode receipt echoing the stored content.
const updateReceipt = (operation: "updated" | "unchanged", body: string, overrides: Record<string, unknown> = {}) =>
  structured({ operation, expectedUpdatedAtMatched: operation === "updated",
    memoryNode: { ...gardenNode(), body, title: "スーの経験: 正解のない4択の呼び方", ...overrides } });

it("updates the same node in place for a later revision, guarded by expectedUpdatedAt", async () => {
  const sent: string[] = [];
  const fetcher = vi.fn()
    .mockResolvedValueOnce(listed([gardenNode({ sourceKey: "su-experience:" + "b".repeat(64) }), gardenNode()]))
    .mockImplementationOnce(async (_url: unknown, options: RequestInit) => {
      const call = JSON.parse(options.body as string).params.arguments;
      sent.push(call.body);
      return updateReceipt("updated", call.body);
    });
  vi.stubGlobal("fetch", fetcher);
  const result = await worker.fetch(request(data({ revision: 2, observation: "投票と呼ぶのが一番わかりやすい" })), env as never, {} as never);
  expect(await result.json()).toEqual({ synced: true, operation: "updated" });
  const calls = args(fetcher);
  expect(calls.map(c => c.name)).toEqual(["list_memory_nodes", "update_memory_node"]);
  expect(calls[1].arguments).toMatchObject({ nodeId: "node-1", expectedUpdatedAt: "2026-09-17T00:00:00.000Z" });
  expect(sent[0]).toContain("投票と呼ぶのが一番わかりやすい");
  // Strict schema: provenance and lifecycle fields are rejected by the Garden, so they are never sent.
  expect(Object.keys(calls[1].arguments).sort()).toEqual(["body", "expectedUpdatedAt", "nodeId", "title"]);
  // save_memory_node is create-only; it is never used to fake an update.
  expect(calls.some(c => c.name === "save_memory_node")).toBe(false);
});
it("accepts operation=unchanged as the applied-retry answer, and rejects a mismatched update receipt", async () => {
  // A retry of an update that already landed: stale token, no write, still genuinely synced.
  let body = "";
  const ok = vi.fn().mockResolvedValueOnce(listed([gardenNode()]))
    .mockImplementationOnce(async (_url: unknown, options: RequestInit) => {
      body = JSON.parse(options.body as string).params.arguments.body;
      return structured({ operation: "unchanged", expectedUpdatedAtMatched: false,
        memoryNode: { ...gardenNode(), body, title: "スーの経験: 正解のない4択の呼び方" } });
    });
  vi.stubGlobal("fetch", ok);
  expect(await (await worker.fetch(request(data({ revision: 2 })), env as never, {} as never)).json())
    .toEqual({ synced: true, operation: "unchanged" });

  // An acknowledgement that does not prove our content is stored is not a completed sync.
  for (const bad of [
    structured({ operation: "updated" }),
    structured({ operation: "updated", memoryNode: { ...gardenNode(), body: "誰かが書き換えた別の本文", title: "別" } }),
    structured({ operation: "updated", memoryNode: { ...gardenNode(), gardenId: "other", body } }),
    structured({ memoryNode: { ...gardenNode(), body } }),
  ]) {
    const fetcher = vi.fn().mockResolvedValueOnce(listed([gardenNode()])).mockResolvedValueOnce(bad);
    vi.stubGlobal("fetch", fetcher);
    const result = await worker.fetch(request(data({ revision: 2 })), env as never, {} as never);
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({ synced: false, status: "failed" });
  }
});
it("holds on a missing scope or Garden write role instead of retrying it as a transient failure", async () => {
  for (const denial of ["forbidden", "insufficient_scope", "personal_token_required", "provenance_immutable"]) {
    const fetcher = vi.fn().mockResolvedValueOnce(listed([gardenNode()]))
      .mockResolvedValueOnce(rpc({ isError: true, content: [{ text: denial }] }));
    vi.stubGlobal("fetch", fetcher);
    const result = await worker.fetch(request(data({ revision: 2 })), env as never, {} as never);
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
    const fetcher = vi.fn().mockResolvedValueOnce(listed([gardenNode()])).mockResolvedValueOnce(unsupported);
    vi.stubGlobal("fetch", fetcher);
    const result = await worker.fetch(request(data({ revision: 2 })), env as never, {} as never);
    expect(await result.json()).toEqual({ synced: false, status: "update_unsupported" });
    expect(args(fetcher).some(c => c.name === "save_memory_node")).toBe(false);
  }
});
it("surfaces source_key_conflict and version conflict instead of a silent no_change success", async () => {
  const conflict = rpc({ isError: true, content: [{ text: "source_key_conflict" }] });
  const fetcher = vi.fn().mockResolvedValueOnce(conflict)
    .mockResolvedValueOnce(listed([gardenNode()]))
    .mockResolvedValueOnce(rpc({ isError: true, content: [{ text: "updated_at_conflict" }] }));
  vi.stubGlobal("fetch", fetcher);
  for (const body of [data(), data({ revision: 4 })]) {
    const result = await worker.fetch(request(body), env as never, {} as never);
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ synced: false, status: "conflict" });
  }
});
it("does not treat an accepted-only or mismatched memory receipt as a saved node", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(rpc({ content: [{ text: '{"ok":true}' }] }))
    .mockResolvedValueOnce(structured({ memoryNode: { id: "node", gardenId: "other", sourceKey: "other" } })));
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
it("retracts an expired copy by archiving it private, and treats an absent node as already retracted", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(listed([gardenNode()])).mockResolvedValueOnce(structured({ operation: "updated", memoryNode: { id: "node-1" } }))
    .mockResolvedValueOnce(listed([]));
  vi.stubGlobal("fetch", fetcher);
  const archived = await worker.fetch(request({ threadId }, "/internal/experiences/retract"), env as never, {} as never);
  expect(await archived.json()).toEqual({ retracted: true, status: "archived" });
  expect(args(fetcher)[1]).toMatchObject({ name: "set_memory_node_lifecycle", arguments: { nodeId: "node-1", state: "archived", visibility: "private" } });
  const absent = await worker.fetch(request({ threadId }, "/internal/experiences/retract"), env as never, {} as never);
  expect(await absent.json()).toEqual({ retracted: true, status: "absent" });
  expect((await worker.fetch(request({ threadId: "nope" }, "/internal/experiences/retract"), env as never, {} as never)).status).toBe(400);
});
it("reads back only active garden-visible notes for the requested threads", async () => {
  const foreign = "c".repeat(64);
  const fetcher = vi.fn().mockResolvedValue(listed([
    gardenNode({ body: "店長の補足: 投票で統一" }),
    gardenNode({ id: "n2", sourceKey: `su-experience:${"d".repeat(64)}`, body: "頼んでいないスレッド" }),
    gardenNode({ id: "n3", sourceKey: `su-experience:${foreign}`, state: "archived", body: "アーカイブ済みの古い日次報告" }),
    gardenNode({ id: "n4", sourceKey: `su-experience:${foreign}`, visibility: "private", body: "運営の秘密TODO" }),
    gardenNode({ id: "n5", sourceKey: `su-experience:${foreign}`, source: "manual", body: "別システムのノード" }),
  ]));
  vi.stubGlobal("fetch", fetcher);
  const result = await worker.fetch(request({ threadIds: [threadId, foreign] }, "/internal/experiences/pull"), env as never, {} as never);
  const body = await result.json() as { status: string; notes: Array<{ threadId: string; body: string }> };
  expect(body.status).toBe("ok");
  expect(body.notes).toEqual([{ threadId, body: "店長の補足: 投票で統一", updatedAt: "2026-09-17T00:00:00.000Z" }]);
  expect(JSON.stringify(body)).not.toContain("秘密TODO");
  expect(JSON.stringify(body)).not.toContain("アーカイブ済み");
  expect((await worker.fetch(request({ threadIds: [] }, "/internal/experiences/pull"), env as never, {} as never)).status).toBe(400);
});
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
