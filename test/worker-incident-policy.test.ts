import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import worker, { formatIncidentRecoveryForOps, shouldOpenIncidentIssue } from "../src/worker/index.js";

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
    const incident = {
      id: "incident-1", kind: "mention_llm_waiting", source: "gateway-202",
      summary: "スーのメンション返答がLLM待ち行列で遅延しています", count: 1,
      first_seen_at: "2026-09-19T12:00:00.000Z", last_seen_at: "2026-09-19T12:00:00.000Z",
    };
    let statement = 0;
    const prepare = (sql: string) => {
      statement += 1;
      if (sql.includes("SELECT id, kind")) {
        return { bind: (dedupeKey: unknown) => {
          expect(dedupeKey).toBe("gateway-202:mention_llm_waiting");
          return { first: async () => incident };
        } };
      }
      expect(sql).toContain("status = 'resolved'");
      return { bind: (_resolvedAt: unknown, id: unknown) => {
        expect(id).toBe("incident-1");
        return { run: async () => ({ meta: { changes: 1 } }) };
      } };
    };
    const notify = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 200 }));
    try {
      const response = await worker.fetch(new Request("https://worker.test/internal/incidents/resolve", {
        method: "POST",
        headers: { "x-nexa-timestamp": timestamp, "x-nexa-signature": signature },
        body: raw,
      }), {
        INTERNAL_SHARED_SECRET: secret,
        OPS_CHANNEL_ID: "ops-channel",
        DISCORD_BOT_TOKEN: "fixture-token",
        DB: { prepare },
      } as never, {} as never);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, resolved: 1 });
      expect(statement).toBe(2);
      expect(notify).toHaveBeenCalledOnce();
      const [url, init] = notify.mock.calls[0]!;
      expect(url).toContain("/channels/ops-channel/messages");
      const notification = JSON.parse(String((init as RequestInit).body));
      expect(notification.content).toContain("復帰しました");
      expect(notification.enforce_nonce).toBe(true);
      expect(notification.nonce).toBe("incident1");
    } finally {
      notify.mockRestore();
    }
  });

  it("makes recovery status explicit for the operator channel", () => {
    const content = formatIncidentRecoveryForOps({
      id: "incident-1", kind: "maintenance_failed", source: "gateway-202",
      summary: "夜間の保守処理の実行に失敗", count: 50,
      first_seen_at: "2026-09-18T03:03:00.000Z", last_seen_at: "2026-09-18T07:08:00.000Z",
    }, "2026-09-18T07:13:00.000Z");
    expect(content).toContain("復帰しました");
    expect(content).toContain("maintenance_failed");
    expect(content).toContain("検知回数: 50");
    expect(content).toContain("状態: `resolved`");
    expect(content).toContain("4時間10分");
  });
});
