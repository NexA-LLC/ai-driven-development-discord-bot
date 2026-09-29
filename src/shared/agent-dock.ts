// Agent Dock v1 (ADD-030 / Issue #3): signed dispatch to third-party Agents.
//
// Third-party Agents never receive the Discord token. The Worker sends them a
// scoped, HMAC-signed event envelope and relays their sanitized text back to
// the Gateway, which posts it with mentions disabled. Everything here is pure
// (fetch and clock are injected) so the policy can be tested without D1.

import { z } from "zod";
import type { AgentManifest } from "./agent-manifest.js";

/** Only these triggers may be dispatched in v1. */
export const DISPATCHABLE_EVENTS = ["direct_mention", "opted_in_thread"] as const;
export type DispatchableEvent = (typeof DISPATCHABLE_EVENTS)[number];

export const AGENT_REQUESTS_PER_MINUTE_CAP = 10;
export const AGENT_ATTEMPT_TIMEOUT_MS = 4_500;
export const AGENT_MAX_ATTEMPTS = 2; // Total wall time stays under 10 seconds.
export const AGENT_OUTPUT_MAX_CHARS = 1_900;
export const AGENT_MAX_HANDOFF_DEPTH = 1;
export const CIRCUIT_FAILURE_THRESHOLD = 3;
export const CIRCUIT_COOLDOWN_MS = 60_000;
const MAX_EVENT_CONTENT_CHARS = 4_000;

const snowflake = z.string().regex(/^\d{5,25}$/);

export const agentScopeSchema = z
  .object({
    events: z.array(z.enum(DISPATCHABLE_EVENTS)).min(1).max(2),
    channelIds: z.array(snowflake).min(1).max(25),
    threadIds: z.array(snowflake).max(50).default([]),
  })
  .strict();
export type AgentScope = z.infer<typeof agentScopeSchema>;

export const agentDockEventSchema = z
  .object({
    eventId: z.string().min(1).max(100),
    eventType: z.enum(DISPATCHABLE_EVENTS),
    guildId: snowflake,
    channelId: snowflake,
    threadId: snowflake.optional(),
    messageId: snowflake,
    actorId: snowflake,
    actorIsBot: z.boolean().default(false),
    content: z.string().max(MAX_EVENT_CONTENT_CHARS),
    handoffDepth: z.number().int().min(0).max(8).default(0),
  })
  .strict();
export type AgentDockEvent = z.infer<typeof agentDockEventSchema>;

const agentResponseSchema = z.object({
  content: z.string().min(1).max(20_000),
  handoff: z.object({ agentId: z.string().min(3).max(64) }).optional(),
});

/**
 * Differences between what the Passport (manifest) declared and the scope an
 * operator is granting. Any entry means the grant exceeds the declaration.
 */
export function diffPassportScope(
  manifest: Pick<AgentManifest, "installationMode" | "triggers" | "endpoint">,
  scope: Pick<AgentScope, "events">,
): string[] {
  const drift: string[] = [];
  if (manifest.installationMode !== "agent_dock") {
    drift.push(`installationMode ${manifest.installationMode} is not agent_dock`);
  }
  if (!manifest.endpoint) {
    drift.push("manifest has no endpoint");
  }
  for (const event of scope.events) {
    if (!manifest.triggers.includes(event)) {
      drift.push(`event ${event} is not declared in manifest triggers`);
    }
  }
  return drift;
}

export type ScopeDecision =
  | { ok: true }
  | { ok: false; reason: "bot_origin" | "event_not_in_scope" | "channel_not_in_scope" | "thread_not_in_scope" | "handoff_too_deep" };

/** Decide whether an event may leave NexA for this Agent. */
export function checkEventScope(event: AgentDockEvent, scope: AgentScope): ScopeDecision {
  if (event.actorIsBot) return { ok: false, reason: "bot_origin" };
  if (event.handoffDepth > AGENT_MAX_HANDOFF_DEPTH) return { ok: false, reason: "handoff_too_deep" };
  if (!scope.events.includes(event.eventType)) return { ok: false, reason: "event_not_in_scope" };
  if (!scope.channelIds.includes(event.channelId)) return { ok: false, reason: "channel_not_in_scope" };
  if (event.eventType === "opted_in_thread") {
    if (!event.threadId || !scope.threadIds.includes(event.threadId)) {
      return { ok: false, reason: "thread_not_in_scope" };
    }
  }
  return { ok: true };
}

export function agentRateLimit(manifestRequestsPerMinute: number): number {
  return Math.max(1, Math.min(AGENT_REQUESTS_PER_MINUTE_CAP, manifestRequestsPerMinute));
}

export interface CircuitState {
  consecutiveFailures: number;
  openedAtMs: number | null;
}

export type CircuitDecision = "closed" | "open" | "half_open";

export function circuitDecision(state: CircuitState, nowMs: number): CircuitDecision {
  if (state.openedAtMs === null) return "closed";
  return nowMs - state.openedAtMs >= CIRCUIT_COOLDOWN_MS ? "half_open" : "open";
}

export function nextCircuitState(state: CircuitState, succeeded: boolean, nowMs: number): CircuitState {
  if (succeeded) return { consecutiveFailures: 0, openedAtMs: null };
  const consecutiveFailures = state.consecutiveFailures + 1;
  // A failed half-open trial reopens immediately; otherwise open at the threshold.
  const reopen = state.openedAtMs !== null || consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD;
  return { consecutiveFailures, openedAtMs: reopen ? nowMs : null };
}

/**
 * Neutralize anything that could ping people. The Gateway also posts with
 * `allowed_mentions: { parse: [] }`; this makes the text itself inert too.
 */
export function sanitizeAgentOutput(text: string, maxChars = AGENT_OUTPUT_MAX_CHARS): string {
  const limit = Math.max(1, Math.min(AGENT_OUTPUT_MAX_CHARS, maxChars));
  const cleaned = text
    .replace(/@(everyone|here)/gi, "@​$1")
    .replace(/<@&(\d+)>/g, "@role")
    .replace(/<@!?(\d+)>/g, "@user")
    .trim();
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit - 1)}…`;
}

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Per-Agent secret derived from the Dock master secret. Nothing secret is
 * stored in D1; bumping `secretVersion` revokes the old credential at once.
 */
export function deriveAgentSecret(masterSecret: string, agentId: string, secretVersion: number): Promise<string> {
  return hmacHex(masterSecret, `agent-dock:v1:${agentId}:${secretVersion}`);
}

/** Signature an Agent verifies: hex HMAC-SHA256 over `${timestamp}.${body}`. */
export function signAgentEnvelope(secret: string, timestamp: string, body: string): Promise<string> {
  return hmacHex(secret, `${timestamp}.${body}`);
}

export interface AgentEnvelope {
  version: "1";
  agentId: string;
  nonce: string;
  sentAt: string;
  event: AgentDockEvent;
  limits: { maxOutputChars: number; timeoutMs: number };
}

export type DispatchOutcome =
  | { ok: true; content: string; handoff: { agentId: string } | null; attempts: number; httpStatus: number }
  | { ok: false; reason: "timeout" | "network" | "http_4xx" | "http_5xx" | "invalid_response"; attempts: number; httpStatus: number | null };

export interface DispatchInput {
  agentId: string;
  endpoint: string;
  secret: string;
  event: AgentDockEvent;
  maxOutputChars: number;
  nonce: string;
  now: () => Date;
  fetchImpl: typeof fetch;
}

/** Send one signed envelope with a bounded retry. Never throws. */
export async function dispatchToAgent(input: DispatchInput): Promise<DispatchOutcome> {
  const envelope: AgentEnvelope = {
    version: "1",
    agentId: input.agentId,
    nonce: input.nonce,
    sentAt: input.now().toISOString(),
    event: input.event,
    limits: { maxOutputChars: Math.min(AGENT_OUTPUT_MAX_CHARS, input.maxOutputChars), timeoutMs: AGENT_ATTEMPT_TIMEOUT_MS },
  };
  const body = JSON.stringify(envelope);

  let last: DispatchOutcome = { ok: false, reason: "network", attempts: 0, httpStatus: null };
  for (let attempt = 1; attempt <= AGENT_MAX_ATTEMPTS; attempt += 1) {
    const timestamp = String(Math.floor(input.now().getTime() / 1_000));
    const signature = await signAgentEnvelope(input.secret, timestamp, body);
    let response: Response;
    try {
      response = await input.fetchImpl(input.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-nexa-agent-id": input.agentId,
          "x-nexa-agent-timestamp": timestamp,
          "x-nexa-agent-signature": signature,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(AGENT_ATTEMPT_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      last = { ok: false, reason: timedOut ? "timeout" : "network", attempts: attempt, httpStatus: null };
      if (timedOut) return last; // A slow Agent does not get a second slow chance.
      continue;
    }

    if (response.status >= 500) {
      last = { ok: false, reason: "http_5xx", attempts: attempt, httpStatus: response.status };
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, reason: "http_4xx", attempts: attempt, httpStatus: response.status };
    }

    let parsed: z.infer<typeof agentResponseSchema>;
    try {
      const result = agentResponseSchema.safeParse(await response.json());
      if (!result.success) throw new Error("schema");
      parsed = result.data;
    } catch {
      return { ok: false, reason: "invalid_response", attempts: attempt, httpStatus: response.status };
    }

    const content = sanitizeAgentOutput(parsed.content, input.maxOutputChars);
    if (!content) {
      return { ok: false, reason: "invalid_response", attempts: attempt, httpStatus: response.status };
    }
    // Agent-to-Agent handoff is limited to one hop from the original event.
    const handoff = parsed.handoff && input.event.handoffDepth < AGENT_MAX_HANDOFF_DEPTH ? { agentId: parsed.handoff.agentId } : null;
    return { ok: true, content, handoff, attempts: attempt, httpStatus: response.status };
  }
  return last;
}
