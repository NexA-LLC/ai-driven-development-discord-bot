import { describe, expect, it } from "vitest";
import { LlmReliability, LlmRequestError } from "../src/gateway/llm-reliability.js";
import { completionText } from "../src/gateway/llm-completion.js";

function controller(overrides: Partial<ConstructorParameters<typeof LlmReliability>[0]> = {}) {
  return new LlmReliability({
    maxConcurrency: 1,
    maxQueue: 10,
    maxAttempts: 2,
    attemptTimeoutMs: 1_000,
    totalTimeoutMs: 5_000,
    retryDelayMs: 0,
    circuitFailureThreshold: 2,
    circuitCooldownMs: 60_000,
    sleep: async () => {},
    ...overrides,
  });
}

describe("LLM reliability controller", () => {
  it("retries a transient failure within a bounded attempt count", async () => {
    const reliability = controller();
    let attempts = 0;
    const result = await reliability.run(async ({ attempt, requestId }) => {
      attempts += 1;
      expect(requestId).toBeTruthy();
      if (attempt === 1) throw new LlmRequestError("busy", { code: "http_503", retryable: true });
      return "ok";
    }, { priority: "interactive" });
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
    expect(reliability.snapshot().state).toBe("healthy");
  });

  it("does not retry a permanent request or model error", async () => {
    const reliability = controller();
    let attempts = 0;
    await expect(reliability.run(async () => {
      attempts += 1;
      throw new LlmRequestError("model not found", { code: "http_400", retryable: false });
    }, { priority: "interactive" })).rejects.toMatchObject({ code: "http_400" });
    expect(attempts).toBe(1);
  });

  it("does not duplicate an inference after an ambiguous timeout", async () => {
    const reliability = controller();
    let attempts = 0;
    await expect(reliability.run(async () => {
      attempts += 1;
      throw new DOMException("timed out after dispatch", "TimeoutError");
    }, { priority: "interactive" })).rejects.toMatchObject({ retryable: false });
    expect(attempts).toBe(1);
  });

  it("does not degrade customer-request circuit state when a synthetic probe fails", async () => {
    const reliability = controller({ circuitFailureThreshold: 1 });
    await expect(reliability.probe(async () => {
      throw new DOMException("probe timed out", "TimeoutError");
    })).rejects.toMatchObject({ code: "ambiguous_timeout" });
    expect(reliability.snapshot()).toMatchObject({ state: "healthy", consecutiveFailures: 0 });
  });

  it("queues interactive work ahead of background work", async () => {
    const reliability = controller({ maxAttempts: 1 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const first = reliability.run(async () => { order.push("first"); await gate; }, { priority: "background" });
    await Promise.resolve();
    const background = reliability.run(async () => { order.push("background"); }, { priority: "background" });
    const interactive = reliability.run(async () => { order.push("interactive"); }, { priority: "interactive" });
    release();
    await Promise.all([first, background, interactive]);
    expect(order).toEqual(["first", "interactive", "background"]);
  });

  it("opens the circuit after repeated final failures and recovers with one half-open request", async () => {
    let now = 1_000;
    const reliability = controller({ now: () => now, maxAttempts: 1, circuitCooldownMs: 500 });
    const fail = () => reliability.run(async () => {
      throw new LlmRequestError("timeout", { code: "timeout", retryable: true });
    }, { priority: "interactive" });
    await expect(fail()).rejects.toBeInstanceOf(LlmRequestError);
    await expect(fail()).rejects.toBeInstanceOf(LlmRequestError);
    expect(reliability.snapshot().state).toBe("open");
    await expect(reliability.run(async () => "blocked", { priority: "interactive" }))
      .rejects.toMatchObject({ code: "circuit_open" });

    now += 501;
    await expect(reliability.run(async () => "recovered", { priority: "interactive" })).resolves.toBe("recovered");
    expect(reliability.snapshot().state).toBe("healthy");
  });
});

describe("LLM completion validation", () => {
  it("accepts final text and strips echoed reasoning", () => {
    expect(completionText({ choices: [{ message: { content: "<think>secret reasoning</think>\nOK" }, finish_reason: "stop" }] })).toBe("OK");
  });

  it("rejects HTTP-success-shaped responses without final text", () => {
    expect(() => completionText({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }))
      .toThrowError(expect.objectContaining({ code: "empty_response", retryable: true }));
  });

  it("classifies reasoning-budget exhaustion as a retryable empty response", () => {
    expect(() => completionText({ choices: [{ message: { content: "" }, finish_reason: "length" }] }))
      .toThrow("whole token budget");
  });
});
