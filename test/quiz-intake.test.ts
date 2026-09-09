import { expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import worker from "../src/worker/index.js";

it.each([undefined, "   ", "claude, codex どれがはやる?"])("checks signed Discord topic input before queueing: %j", async topic => {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  const body = JSON.stringify({ id: "test", application_id: "test-app", type: 2, token: "test-token", data: { name: "quiz", options: topic === undefined ? [] : [{ name: "topic", type: 3, value: topic }] } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), keys.privateKey).toString("hex");
  const run = vi.fn().mockResolvedValue({ success: true });
  const bind = vi.fn().mockReturnValue({ run });
  const prepare = vi.fn().mockReturnValue({ bind });
  const response = await worker.fetch(new Request("https://test/interactions", { method: "POST", headers: { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp }, body }), { DISCORD_PUBLIC_KEY: publicKey, AI_PROVIDER: "gateway", DB: { prepare } } as never, {} as never);
  const result = await response.json() as { type: number; data?: { content: string } };
  if (!topic?.trim()) {
    expect(result.type).toBe(4);
    expect(result.data?.content).toContain("topic");
    expect(prepare).not.toHaveBeenCalled();
  } else {
    expect(result.type).toBe(5);
    expect(bind.mock.calls[0]?.[2]).toContain(topic);
    expect(run).toHaveBeenCalledOnce();
  }
});
