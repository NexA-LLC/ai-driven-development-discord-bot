import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import worker, { shouldOpenIncidentIssue } from "../src/worker/index.js";

describe("incident improvement loop", () => {
  it("opens the Repo Deck improvement issue on the first user-visible LLM failure", () => {
    expect(shouldOpenIncidentIssue({ kind: "mention_llm_failed", severity: "error" }, 1)).toBe(true);
    expect(shouldOpenIncidentIssue({ kind: "llm_model_unavailable", severity: "critical" }, 1)).toBe(true);
  });

  it("keeps the noise threshold for lower-signal incidents", () => {
    expect(shouldOpenIncidentIssue({ kind: "maintenance_failed", severity: "warning" }, 1)).toBe(false);
    expect(shouldOpenIncidentIssue({ kind: "maintenance_failed", severity: "warning" }, 3)).toBe(true);
  });

  it("resolves a recovered incident only through the signed internal route", async () => {
    const secret = "fixture-secret";
    const raw = JSON.stringify({ kind: "mention_llm_waiting", source: "gateway-202" });
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
    const run = async () => ({ meta: { changes: 1 } });
    const bind = (...values: unknown[]) => {
      expect(values[1]).toBe("gateway-202:mention_llm_waiting");
      return { run };
    };
    const prepare = (sql: string) => {
      expect(sql).toContain("status = 'resolved'");
      return { bind };
    };
    const response = await worker.fetch(new Request("https://worker.test/internal/incidents/resolve", {
      method: "POST",
      headers: { "x-nexa-timestamp": timestamp, "x-nexa-signature": signature },
      body: raw,
    }), { INTERNAL_SHARED_SECRET: secret, DB: { prepare } } as never, {} as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, resolved: 1 });
  });
});
