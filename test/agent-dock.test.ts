import { describe, expect, it, vi } from "vitest";
import {
  AGENT_ATTEMPT_TIMEOUT_MS,
  AGENT_MAX_ATTEMPTS,
  CIRCUIT_COOLDOWN_MS,
  agentDockEventSchema,
  agentRateLimit,
  agentScopeSchema,
  checkEventScope,
  circuitDecision,
  deriveAgentSecret,
  diffPassportScope,
  dispatchToAgent,
  nextCircuitState,
  sanitizeAgentOutput,
  signAgentEnvelope,
  type AgentDockEvent,
} from "../src/shared/agent-dock.js";

const scope = agentScopeSchema.parse({
  events: ["direct_mention", "opted_in_thread"],
  channelIds: ["100000000000000001"],
  threadIds: ["100000000000000009"],
});

function event(overrides: Partial<AgentDockEvent> = {}): AgentDockEvent {
  return agentDockEventSchema.parse({
    eventId: "evt-1",
    eventType: "direct_mention",
    guildId: "100000000000000000",
    channelId: "100000000000000001",
    messageId: "100000000000000002",
    actorId: "100000000000000003",
    content: "レビューして",
    ...overrides,
  });
}

const manifest = {
  installationMode: "agent_dock" as const,
  endpoint: "https://agent.example.com/events",
  triggers: ["direct_mention" as const],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function dispatchInput(fetchImpl: typeof fetch, overrides: Partial<Parameters<typeof dispatchToAgent>[0]> = {}) {
  return {
    agentId: "safe-reviewer",
    endpoint: "https://agent.example.com/events",
    secret: "s3cret",
    event: event(),
    maxOutputChars: 1900,
    nonce: "nonce-1",
    now: () => new Date("2026-09-29T00:00:00Z"),
    fetchImpl,
    ...overrides,
  };
}

describe("scope", () => {
  it("rejects scope events outside direct_mention / opted_in_thread", () => {
    expect(agentScopeSchema.safeParse({ events: ["manual_dispatch"], channelIds: ["100000000000000001"] }).success).toBe(false);
  });

  it("detects grants that exceed the Passport", () => {
    expect(diffPassportScope(manifest, { events: ["direct_mention"] })).toEqual([]);
    expect(diffPassportScope(manifest, { events: ["direct_mention", "opted_in_thread"] })).toEqual([
      "event opted_in_thread is not declared in manifest triggers",
    ]);
    expect(diffPassportScope({ ...manifest, installationMode: "guild_install" }, { events: ["direct_mention"] })).toHaveLength(1);
  });

  it("only lets allowlisted events out", () => {
    expect(checkEventScope(event(), scope)).toEqual({ ok: true });
    expect(checkEventScope(event({ channelId: "100000000000000099" }), scope)).toEqual({ ok: false, reason: "channel_not_in_scope" });
    expect(checkEventScope(event({ actorIsBot: true }), scope)).toEqual({ ok: false, reason: "bot_origin" });
    expect(checkEventScope(event({ eventType: "opted_in_thread" }), scope)).toEqual({ ok: false, reason: "thread_not_in_scope" });
    expect(checkEventScope(event({ eventType: "opted_in_thread", threadId: "100000000000000009" }), scope)).toEqual({ ok: true });
    expect(checkEventScope(event({ handoffDepth: 2 }), scope)).toEqual({ ok: false, reason: "handoff_too_deep" });
    expect(checkEventScope(event(), { ...scope, events: ["opted_in_thread"] })).toEqual({ ok: false, reason: "event_not_in_scope" });
  });

  it("caps the rate at 10 requests per minute", () => {
    expect(agentRateLimit(60)).toBe(10);
    expect(agentRateLimit(3)).toBe(3);
  });
});

describe("sanitizeAgentOutput", () => {
  it("neutralizes mass, role and user mentions", () => {
    const out = sanitizeAgentOutput("@everyone @HERE <@&123456> <@!42> <@42> ok");
    expect(out).not.toMatch(/@(everyone|here)/i);
    expect(out).not.toMatch(/<@/);
    expect(out).toContain("@role");
    expect(out.endsWith("ok")).toBe(true);
  });

  it("never exceeds 1900 characters", () => {
    expect(sanitizeAgentOutput("a".repeat(5000))).toHaveLength(1900);
    expect(sanitizeAgentOutput("a".repeat(5000), 8000)).toHaveLength(1900);
    expect(sanitizeAgentOutput("a".repeat(500), 100)).toHaveLength(100);
  });
});

describe("circuit breaker", () => {
  it("opens after consecutive failures and half-opens after cooldown", () => {
    let state = { consecutiveFailures: 0, openedAtMs: null as number | null };
    state = nextCircuitState(state, false, 1_000);
    state = nextCircuitState(state, false, 2_000);
    expect(circuitDecision(state, 2_000)).toBe("closed");
    state = nextCircuitState(state, false, 3_000);
    expect(circuitDecision(state, 3_001)).toBe("open");
    expect(circuitDecision(state, 3_000 + CIRCUIT_COOLDOWN_MS)).toBe("half_open");

    const reopened = nextCircuitState(state, false, 3_000 + CIRCUIT_COOLDOWN_MS);
    expect(circuitDecision(reopened, 3_001 + CIRCUIT_COOLDOWN_MS)).toBe("open");
    expect(nextCircuitState(state, true, 99_999)).toEqual({ consecutiveFailures: 0, openedAtMs: null });
  });
});

describe("credentials", () => {
  it("derives distinct per-Agent secrets and revokes by version bump", async () => {
    const v1 = await deriveAgentSecret("master", "agent-a", 1);
    expect(v1).toMatch(/^[0-9a-f]{64}$/);
    expect(await deriveAgentSecret("master", "agent-a", 2)).not.toBe(v1);
    expect(await deriveAgentSecret("master", "agent-b", 1)).not.toBe(v1);
  });
});

describe("dispatchToAgent", () => {
  it("sends a signed envelope the Agent can verify, without any Discord token", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = String(init?.body);
      const timestamp = headers.get("x-nexa-agent-timestamp")!;
      expect(headers.get("x-nexa-agent-signature")).toBe(await signAgentEnvelope("s3cret", timestamp, body));
      expect(headers.get("authorization")).toBeNull();
      expect(body).not.toMatch(/token/i);
      expect(JSON.parse(body)).toMatchObject({ version: "1", agentId: "safe-reviewer", nonce: "nonce-1", event: { eventType: "direct_mention" } });
      expect(init?.redirect).toBe("manual");
      return jsonResponse({ content: "@everyone 見ました", handoff: { agentId: "other-agent" } });
    });

    const outcome = await dispatchToAgent(dispatchInput(fetchImpl as unknown as typeof fetch));
    expect(outcome).toMatchObject({ ok: true, attempts: 1, handoff: { agentId: "other-agent" } });
    expect(outcome.ok && outcome.content).not.toMatch(/@everyone/);
  });

  it("drops handoffs beyond one hop", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ content: "ok", handoff: { agentId: "third-agent" } }));
    const outcome = await dispatchToAgent(dispatchInput(fetchImpl as unknown as typeof fetch, { event: event({ handoffDepth: 1 }) }));
    expect(outcome).toMatchObject({ ok: true, handoff: null });
  });

  it("retries 5xx up to the ceiling", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503));
    const outcome = await dispatchToAgent(dispatchInput(fetchImpl as unknown as typeof fetch));
    expect(outcome).toEqual({ ok: false, reason: "http_5xx", attempts: AGENT_MAX_ATTEMPTS, httpStatus: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(AGENT_MAX_ATTEMPTS);
    expect(AGENT_ATTEMPT_TIMEOUT_MS * AGENT_MAX_ATTEMPTS).toBeLessThan(10_000);
  });

  it("does not retry timeouts or 4xx", async () => {
    const timeout = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(await dispatchToAgent(dispatchInput(timeout as unknown as typeof fetch))).toMatchObject({ ok: false, reason: "timeout", attempts: 1 });
    expect(timeout).toHaveBeenCalledTimes(1);

    const notFound = vi.fn(async () => jsonResponse({}, 404));
    expect(await dispatchToAgent(dispatchInput(notFound as unknown as typeof fetch))).toMatchObject({ ok: false, reason: "http_4xx", attempts: 1 });
  });

  it("rejects responses that do not match the output schema", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ text: "wrong field" }));
    expect(await dispatchToAgent(dispatchInput(fetchImpl as unknown as typeof fetch))).toMatchObject({ ok: false, reason: "invalid_response" });
  });
});
