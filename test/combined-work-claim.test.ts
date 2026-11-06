import { createHmac } from "node:crypto";
import worker from "../src/worker/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimGatewayWork } from "../src/worker/queue-claims.js";
import { SqliteD1 } from "./helpers/sqlite-d1.js";

const now = "2026-11-06T12:00:00.000Z";
let db: SqliteD1;
const claim = () => claimGatewayWork(db as unknown as D1Database, now);
function job(id: string, status = "pending", expires = "2026-11-06T13:00:00.000Z", created = "2026-11-06 11:00:00") {
  db.rows("INSERT INTO ai_jobs (id,mode,input,application_id,interaction_token,status,expires_at,created_at) VALUES (?, 'ask', 'private prompt', 'app', 'token', ?, ?, ?)", id, status, expires, created);
}
function command(id: string, payload = '{"text":"hello"}', status = "pending", expires = "2026-11-06T13:00:00.000Z", created = "2026-11-06 11:00:00") {
  db.rows("INSERT INTO gateway_commands (id,kind,payload_json,status,expires_at,created_at) VALUES (?, 'say', ?, ?, ?, ?)", id, payload, status, expires, created);
}
beforeEach(() => { db = new SqliteD1(); });
afterEach(() => { db.close(); });
describe("combined work claim against actual SQLite", () => {
  it("returns empty queues in a single transaction", async () => {
    expect(await claim()).toEqual({ jobs: [], commands: [] });
    expect(db.batchCalls).toBe(1);
  });
  it("claims five of each in FIFO order, including deterministic timestamp ties", async () => {
    for (const id of ["g", "f", "e", "d", "c", "b", "a"]) { job(id); command(id); }
    const result = await claim();
    expect(result.jobs.map(j => j.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(result.commands.map(c => c.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(result.commands[0]?.payload).toEqual({ text: "hello" });
    expect(result.jobs[0]).toMatchObject({ mode: "ask", input: "private prompt", application_id: "app", interaction_token: "token", guild_id: null, requester_user_id: null });
    expect(db.rows("SELECT status, claimed_at FROM ai_jobs WHERE id='a'")[0]).toEqual({ status: "claimed", claimed_at: now });
    expect((await claim()).jobs.map(j => j.id)).toEqual(["f", "g"]);
  });
  it("honors creation time before the id tie-breaker", async () => {
    job("a", "pending", undefined, "2026-11-06 11:02:00"); job("z");
    command("a", undefined, "pending", undefined, "2026-11-06 11:02:00"); command("z");
    const result = await claim();
    expect(result.jobs.map(j => j.id)).toEqual(["z", "a"]);
    expect(result.commands.map(c => c.id)).toEqual(["z", "a"]);
  });
  it("preserves expiry semantics and clears expired job prompts", async () => {
    for (const status of ["pending", "claimed", "done"]) {
      job(status, status, "2026-11-06T11:00:00.000Z");
      command(status, undefined, status, "2026-11-06T11:00:00.000Z");
    }
    expect(await claim()).toEqual({ jobs: [], commands: [] });
    expect(db.rows("SELECT id,status,input,completed_at FROM ai_jobs WHERE id IN ('pending','claimed')")).toEqual(expect.arrayContaining([
      { id: "pending", status: "expired", input: null, completed_at: now },
      { id: "claimed", status: "expired", input: null, completed_at: now },
    ]));
    expect(db.rows("SELECT status FROM gateway_commands WHERE id='pending'")[0].status).toBe("expired");
    expect(db.rows("SELECT status FROM gateway_commands WHERE id='claimed'")[0].status).toBe("claimed");
    expect(db.rows("SELECT status,input FROM ai_jobs WHERE id='done'")[0]).toEqual({ status: "done", input: "private prompt" });
  });
  it("isolates invalid JSON and non-object payloads without losing jobs or other commands", async () => {
    job("j"); command("a", "{"); command("b", "null"); command("c", "[]"); command("d");
    const result = await claim();
    expect(result.jobs.map(j => j.id)).toEqual(["j"]);
    for (const item of result.commands.slice(0, 3)) {
      expect(item.payload).toEqual({}); expect(item.payloadError).toEqual(expect.any(String));
    }
    expect(result.commands[3]).toMatchObject({ id: "d", payload: { text: "hello" } });
    expect(result.commands[3]?.payloadError).toBeUndefined();
  });
  it("rolls back expiry and earlier claims if the final statement fails", async () => {
    job("pending"); job("old", "pending", "2026-11-06T11:00:00.000Z"); command("c");
    db.failBatchStatement = 3;
    await expect(claim()).rejects.toThrow("deliberately_missing_table");
    expect(db.rows("SELECT status,input,claimed_at FROM ai_jobs WHERE id='old'")[0]).toEqual({ status: "pending", input: "private prompt", claimed_at: null });
    expect(db.rows("SELECT status,claimed_at FROM ai_jobs WHERE id='pending'")[0]).toEqual({ status: "pending", claimed_at: null });
    expect(db.rows("SELECT status FROM gateway_commands WHERE id='c'")[0].status).toBe("pending");
  });
  it("makes concurrent combined claims exclusive", async () => {
    for (let i = 0; i < 8; i++) { job(String(i)); command(String(i)); }
    const results = await Promise.all([claim(), claim()]);
    for (const queue of ["jobs", "commands"] as const) {
      const ids = results.flatMap(r => r[queue].map(item => item.id));
      expect(ids).toHaveLength(8); expect(new Set(ids).size).toBe(8);
    }
  });
  it("does not reclaim rows claimed by legacy consumers and defeats stale legacy selections", async () => {
    job("legacy"); command("legacy"); job("new"); command("new");
    for (const table of ["ai_jobs", "gateway_commands"]) db.rows(`UPDATE ${table} SET status='claimed' WHERE id='legacy' AND status='pending'`);
    const result = await claim();
    expect(result.jobs.map(j => j.id)).toEqual(["new"]);
    expect(result.commands.map(c => c.id)).toEqual(["new"]);
    for (const table of ["ai_jobs", "gateway_commands"]) {
      const stale = await db.prepare(`UPDATE ${table} SET status='claimed' WHERE id='new' AND status='pending'`).run();
      expect(stale.meta.changes).toBe(0);
    }
  });
});


describe("combined claim HTTP authentication and compatibility", () => {
  const secret = "test-only-internal-secret";
  function request(path: string, signed: boolean) {
    const body = "{}";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    return new Request(`https://worker.test${path}`, { method: "POST", body,
      headers: signed ? { "x-nexa-timestamp": timestamp, "x-nexa-signature": createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex") } : {},
    });
  }
  it("rejects unsigned requests before touching storage", async () => {
    const prepare = vi.fn(() => { throw new Error("unauthorized DB access"); });
    const batch = vi.fn(() => { throw new Error("unauthorized DB access"); });
    const response = await worker.fetch(request("/internal/work/claim", false), { INTERNAL_SHARED_SECRET: secret, DB: { prepare, batch } } as never, {} as never);
    expect(response.status).toBe(401);
    expect(prepare).not.toHaveBeenCalled(); expect(batch).not.toHaveBeenCalled();
  });
  it.each(["/internal/work/claim", "/internal/jobs/claim", "/internal/commands/claim"])("serves signed %s without external side effects", async path => {
    const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected external request"));
    try {
      const response = await worker.fetch(request(path, true), { INTERNAL_SHARED_SECRET: secret, DB: db } as never, {} as never);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(path.includes("/work/") ? { jobs: [], commands: [] } : path.includes("/jobs/") ? { jobs: [] } : { commands: [] });
      expect(outbound).not.toHaveBeenCalled();
    } finally { outbound.mockRestore(); }
  });
});
