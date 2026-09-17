import { expect, it, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import worker from "../src/worker/index.js";

afterEach(() => vi.unstubAllGlobals());
const env = { INTERNAL_SHARED_SECRET: "fixture-secret", DECISIONGARDEN_MCP_TOKEN: "fixture-token", DECISIONGARDEN_GARDEN_ID: "garden" };
function request(body: unknown, path = "/internal/experiences/sync", signed = true) {
  const raw = JSON.stringify(body); const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://worker.test" + path, { method: "POST", body: raw, headers: { "x-nexa-timestamp": timestamp,
    "x-nexa-signature": signed ? createHmac("sha256", env.INTERNAL_SHARED_SECRET).update(`${timestamp}.${raw}`).digest("hex") : "invalid" } });
}
const data = () => ({ id: "a".repeat(64), at: Date.now() - 1000, topic: "quiz_terminology" });
it("live signed Worker route upserts one sourceKey and never reports MCP errors as completion", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ result: { isError: true, content: [{ text: "failure" }] } }))
    .mockResolvedValueOnce(Response.json({ result: { content: [{ text: '{"ok":false}' }] } }))
    .mockResolvedValue(Response.json({ result: { structuredContent: { operation: "existing", memoryNode: { id: "node", gardenId: "garden", sourceKey: `su-experience:${"a".repeat(64)}` } } } }));
  vi.stubGlobal("fetch", fetcher);
  for (const expected of [502, 502, 200]) {
    const result = await worker.fetch(request(data()), env as never, {} as never); expect(result.status).toBe(expected);
    expect((await result.json() as any).synced).toBe(expected === 200);
  }
  const calls = fetcher.mock.calls.map(c => JSON.parse(c[1].body).params.arguments);
  expect(new Set(calls.map(c => c.sourceKey)).size).toBe(1);
  expect(calls[0].body).not.toContain("sourceId");
});
it("does not treat an accepted-only or mismatched memory receipt as a saved node", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ result: { content: [{ text: '{"ok":true}' }] } }))
    .mockResolvedValueOnce(Response.json({ result: { structuredContent: { memoryNode: { id: "node", gardenId: "other", sourceKey: "other" } } } })));
  for (let i = 0; i < 2; i++) expect((await worker.fetch(request(data()), env as never, {} as never)).status).toBe(502);
});
it("rejects unsigned, stale, or arbitrary public prose and reports missing DG configuration explicitly", async () => {
  for (const req of [request(data(), undefined, false), request({ ...data(), quote: "secret" }), request({ ...data(), at: 1 })]) {
    expect((await worker.fetch(req, env as never, {} as never)).status).toBeGreaterThanOrEqual(400);
  }
  const result = await worker.fetch(request(data()), { INTERNAL_SHARED_SECRET: env.INTERNAL_SHARED_SECRET } as never, {} as never);
  expect(await result.json()).toEqual({ synced: false, status: "not_configured" });
});
it("operational digest reports analysis elsewhere and propagates DG failure instead of claiming no findings", async () => {
  const first = vi.fn().mockResolvedValue({ total: 3, failed: 0 });
  const db = { prepare: () => ({ bind: () => ({ first }) }) };
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("DG timeout")));
  const result = await worker.fetch(request({}, "/internal/digest/run"), { ...env, DB: db } as never, {} as never);
  expect(result.status).toBe(502); expect(await result.json()).toEqual({ ok: false, status: "failed" });
  const noDG = await worker.fetch(request({}, "/internal/digest/run"), { INTERNAL_SHARED_SECRET: env.INTERNAL_SHARED_SECRET, DB: db } as never, {} as never);
  expect(await noDG.json()).toMatchObject({ analysis: "not_run", analysisLocation: "gateway", statsSynced: false });
});
