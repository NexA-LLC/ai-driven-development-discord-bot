import { z } from "zod";
import { DurableState, statePath } from "./durable-state.js";

export const WELCOME_FALLBACK_ATTEMPT = 3;

const welcomeJobSchema = z.object({
  key: z.string().max(1200),
  guildId: z.string().max(1000),
  memberId: z.string().max(1000),
  joinedAt: z.number().int().nonnegative(),
  status: z.enum(["pending", "sent", "skipped"]),
  attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.number().int().nonnegative(),
  lastAttemptAt: z.number().int().nonnegative().nullable(),
  content: z.string().max(1800).nullable(),
  messageId: z.string().max(1000).nullable(),
  lastError: z.string().max(500).nullable(),
  completedAt: z.number().int().nonnegative().nullable(),
});
export type WelcomeJob = z.infer<typeof welcomeJobSchema>;

const stateSchema = z.object({ jobs: z.array(welcomeJobSchema).max(2000) });

const retryDelay = (attempts: number): number => {
  if (attempts <= 1) return 60_000;
  if (attempts === 2) return 5 * 60_000;
  if (attempts === 3) return 15 * 60_000;
  return 6 * 3600_000;
};

export class WelcomeQueue {
  private state: DurableState<z.infer<typeof stateSchema>>;
  constructor(path = statePath("welcome-queue.json")) {
    this.state = new DurableState(path, stateSchema, { jobs: [] });
  }
  get available(): boolean { return this.state.available; }
  enqueue(guildId: string, memberId: string, joinedAt: number, now = Date.now()): boolean {
    const key = `${guildId}:${memberId}:${joinedAt}`;
    if (!this.state.available || this.state.value.jobs.some(job => job.key === key)) return false;
    this.state.value.jobs.push({
      key, guildId, memberId, joinedAt, status: "pending", attempts: 0,
      nextAttemptAt: now, lastAttemptAt: null, content: null, messageId: null,
      lastError: null, completedAt: null,
    });
    this.compact(now);
    this.state.save();
    return true;
  }
  due(now = Date.now(), limit = 5): WelcomeJob[] {
    if (!this.state.available) return [];
    return this.state.value.jobs
      .filter(job => job.status === "pending" && job.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.joinedAt - b.joinedAt)
      .slice(0, limit)
      .map(job => ({ ...job }));
  }
  beginAttempt(key: string, now = Date.now()): number {
    const job = this.requirePending(key);
    job.attempts++;
    job.lastAttemptAt = now;
    this.state.save();
    return job.attempts;
  }
  rememberContent(key: string, content: string): void {
    const job = this.requirePending(key);
    job.content = content.slice(0, 1800);
    this.state.save();
  }
  defer(key: string, error: string, now = Date.now()): void {
    const job = this.requirePending(key);
    job.lastError = error.slice(0, 500);
    job.nextAttemptAt = now + retryDelay(job.attempts);
    this.state.save();
  }
  sent(key: string, messageId: string, now = Date.now()): void {
    const job = this.requirePending(key);
    job.status = "sent";
    job.messageId = messageId;
    job.lastError = null;
    job.completedAt = now;
    this.compact(now);
    this.state.save();
  }
  skipped(key: string, reason: string, now = Date.now()): void {
    const job = this.requirePending(key);
    job.status = "skipped";
    job.lastError = reason.slice(0, 500);
    job.completedAt = now;
    this.compact(now);
    this.state.save();
  }
  snapshot(now = Date.now()): { available: boolean; pending: number; due: number; sent: number; nextAttemptAt: string | null } {
    if (!this.state.available) return { available: false, pending: 0, due: 0, sent: 0, nextAttemptAt: null };
    const pending = this.state.value.jobs.filter(job => job.status === "pending");
    const next = pending.reduce<number | null>((value, job) => value === null || job.nextAttemptAt < value ? job.nextAttemptAt : value, null);
    return {
      available: true,
      pending: pending.length,
      due: pending.filter(job => job.nextAttemptAt <= now).length,
      sent: this.state.value.jobs.filter(job => job.status === "sent").length,
      nextAttemptAt: next === null ? null : new Date(next).toISOString(),
    };
  }
  hasEscalatedPending(): boolean {
    return this.state.available && this.state.value.jobs.some(job =>
      job.status === "pending" && job.attempts >= WELCOME_FALLBACK_ATTEMPT);
  }
  private requirePending(key: string): WelcomeJob {
    if (!this.state.available) throw new Error("Welcome queue unavailable");
    const job = this.state.value.jobs.find(item => item.key === key && item.status === "pending");
    if (!job) throw new Error("Welcome job is not pending");
    return job;
  }
  private compact(now: number): void {
    const cutoff = now - 30 * 86400_000;
    this.state.value.jobs = this.state.value.jobs
      .filter(job => job.status === "pending" || (job.completedAt ?? job.joinedAt) >= cutoff)
      .slice(-2000);
  }
}

export function fallbackWelcome(name: string, language: "ja" | "en"): string {
  if (language === "ja") {
    return `いらっしゃいませ、${name}さん。夜の店員のスーです。分からないことや気になることがあれば、いつでも声をかけてください。`;
  }
  return `Welcome in, ${name}. I'm Su, the night-shift clerk here. If anything is unclear or catches your interest, you can call me anytime.`;
}
