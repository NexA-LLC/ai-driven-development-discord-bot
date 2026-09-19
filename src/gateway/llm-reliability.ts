import { randomUUID } from "node:crypto";

export type LlmPriority = "interactive" | "background";
export type LlmCircuitState = "healthy" | "degraded" | "open" | "half_open";

export class LlmRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(message: string, options: { code: string; retryable: boolean; status?: number; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LlmRequestError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

export function llmHttpError(status: number): LlmRequestError {
  return new LlmRequestError(`LLM API returned ${status}`, {
    code: `http_${status}`,
    retryable: status === 408 || status === 409 || status === 425 || status === 429 || status >= 500,
    status,
  });
}

export function normalizeLlmError(error: unknown): LlmRequestError {
  if (error instanceof LlmRequestError) return error;
  const candidate = error as { name?: string; message?: string; cause?: { code?: string }; code?: string };
  const code = candidate.cause?.code ?? candidate.code ?? candidate.name ?? "unknown";
  // A timeout/reset can happen after the server accepted the prompt. Retrying it
  // immediately would duplicate inference and make a saturated model worse.
  // Only failures that establish no connection are safe for an immediate retry.
  const retryable = ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"].includes(code);
  const ambiguousTimeout = candidate.name === "TimeoutError" || candidate.name === "AbortError" ||
    ["ECONNRESET", "ETIMEDOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(code);
  return new LlmRequestError(candidate.message ?? String(error), {
    code: ambiguousTimeout ? "ambiguous_timeout" : retryable ? code : "request_failed",
    retryable,
    cause: error,
  });
}

export interface LlmRunContext {
  signal: AbortSignal;
  attempt: number;
  requestId: string;
}

export interface LlmRunOptions {
  priority: LlmPriority;
  requestId?: string;
  maxAttempts?: number;
  attemptTimeoutMs?: number;
  totalTimeoutMs?: number;
}

export interface LlmReliabilitySnapshot {
  state: LlmCircuitState;
  active: number;
  queuedInteractive: number;
  queuedBackground: number;
  consecutiveFailures: number;
  openedUntil: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
}

interface ReliabilityOptions {
  maxConcurrency: number;
  maxQueue: number;
  maxAttempts: number;
  attemptTimeoutMs: number;
  totalTimeoutMs: number;
  retryDelayMs: number;
  circuitFailureThreshold: number;
  circuitCooldownMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Waiter {
  resolve: () => void;
}

export class LlmReliability {
  private active = 0;
  private readonly interactiveQueue: Waiter[] = [];
  private readonly backgroundQueue: Waiter[] = [];
  private consecutiveFailures = 0;
  private openedUntil = 0;
  private halfOpenInFlight = false;
  private lastSuccessAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastFailureCode: string | null = null;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly options: ReliabilityOptions) {
    this.now = options.now ?? Date.now;
    this.wait = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  snapshot(): LlmReliabilitySnapshot {
    const now = this.now();
    let state: LlmCircuitState;
    if (this.openedUntil > now) state = "open";
    else if (this.openedUntil > 0 && this.halfOpenInFlight) state = "half_open";
    else if (this.consecutiveFailures > 0) state = "degraded";
    else state = "healthy";
    return {
      state,
      active: this.active,
      queuedInteractive: this.interactiveQueue.length,
      queuedBackground: this.backgroundQueue.length,
      consecutiveFailures: this.consecutiveFailures,
      openedUntil: this.openedUntil > now ? new Date(this.openedUntil).toISOString() : null,
      lastSuccessAt: this.lastSuccessAt === null ? null : new Date(this.lastSuccessAt).toISOString(),
      lastFailureAt: this.lastFailureAt === null ? null : new Date(this.lastFailureAt).toISOString(),
      lastFailureCode: this.lastFailureCode,
    };
  }

  async run<T>(operation: (context: LlmRunContext) => Promise<T>, runOptions: LlmRunOptions): Promise<T> {
    const requestId = runOptions.requestId ?? randomUUID();
    const totalTimeoutMs = runOptions.totalTimeoutMs ?? this.options.totalTimeoutMs;
    const attemptTimeoutMs = runOptions.attemptTimeoutMs ?? this.options.attemptTimeoutMs;
    const maxAttempts = runOptions.maxAttempts ?? this.options.maxAttempts;
    let halfOpen = false;

    if (this.openedUntil > this.now()) {
      throw new LlmRequestError("LLM circuit is open", { code: "circuit_open", retryable: true });
    }
    if (this.openedUntil > 0) {
      if (this.halfOpenInFlight) {
        throw new LlmRequestError("LLM circuit half-open probe is already running", { code: "circuit_half_open", retryable: true });
      }
      this.halfOpenInFlight = true;
      halfOpen = true;
    }

    try {
      await this.acquire(runOptions.priority);
    } catch (error) {
      if (halfOpen) this.halfOpenInFlight = false;
      throw error;
    }

    try {
      // Queueing is intentional backpressure, not part of the inference timeout.
      const startedAt = this.now();
      let lastError = new LlmRequestError("LLM request did not run", { code: "not_run", retryable: true });
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const remaining = totalTimeoutMs - (this.now() - startedAt);
        if (remaining <= 0) {
          lastError = new LlmRequestError("LLM total timeout exceeded", { code: "total_timeout", retryable: true });
          break;
        }

        const controller = new AbortController();
        const timeoutMs = Math.min(attemptTimeoutMs, remaining);
        const timer = setTimeout(() => controller.abort(new DOMException("LLM attempt timed out", "TimeoutError")), timeoutMs);
        try {
          const value = await operation({ signal: controller.signal, attempt, requestId });
          clearTimeout(timer);
          this.recordSuccess();
          return value;
        } catch (error) {
          clearTimeout(timer);
          lastError = normalizeLlmError(error);
          const retryBudget = totalTimeoutMs - (this.now() - startedAt);
          if (!lastError.retryable || attempt >= maxAttempts || retryBudget <= this.options.retryDelayMs) break;
          await this.wait(this.options.retryDelayMs);
        }
      }
      this.recordFailure(lastError);
      throw lastError;
    } finally {
      if (halfOpen) this.halfOpenInFlight = false;
      this.release();
    }
  }

  private async acquire(priority: LlmPriority): Promise<void> {
    if (this.active < this.options.maxConcurrency) {
      this.active += 1;
      return;
    }
    if (this.interactiveQueue.length + this.backgroundQueue.length >= this.options.maxQueue) {
      throw new LlmRequestError("LLM queue is full", { code: "queue_full", retryable: true });
    }
    await new Promise<void>((resolve) => {
      const waiter = { resolve };
      if (priority === "interactive") this.interactiveQueue.push(waiter);
      else this.backgroundQueue.push(waiter);
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.interactiveQueue.shift() ?? this.backgroundQueue.shift();
    if (next) {
      this.active += 1;
      next.resolve();
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedUntil = 0;
    this.lastSuccessAt = this.now();
    this.lastFailureCode = null;
  }

  private recordFailure(error: LlmRequestError): void {
    this.consecutiveFailures += 1;
    this.lastFailureAt = this.now();
    this.lastFailureCode = error.code;
    if (this.consecutiveFailures >= this.options.circuitFailureThreshold) {
      this.openedUntil = this.now() + this.options.circuitCooldownMs;
    }
  }
}
