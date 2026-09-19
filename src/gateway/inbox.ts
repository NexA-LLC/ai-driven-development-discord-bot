import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
export interface InboxItem {
  channelId: string;
  messageId: string;
  attempts: number;
  nextAttemptAt: number;
  noticeMessageId?: string;
  lastError?: string;
  toolReceipts?: Record<string, unknown>;
}
interface State { pending: InboxItem[]; completed: string[]; deadLetters: InboxItem[]; onlineAt: number }
export class Inbox {
  private state: State;
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const stored = JSON.parse(readFileSync(path, "utf8")) as Partial<State> & { pending?: Array<Partial<InboxItem>> };
      this.state = {
        pending: (stored.pending ?? []).flatMap(item => item.channelId && item.messageId ? [{
          channelId: item.channelId,
          messageId: item.messageId,
          attempts: item.attempts ?? 0,
          nextAttemptAt: item.nextAttemptAt ?? 0,
          ...(item.noticeMessageId ? { noticeMessageId: item.noticeMessageId } : {}),
          ...(item.lastError ? { lastError: item.lastError } : {}),
          ...(item.toolReceipts && typeof item.toolReceipts === "object" ? { toolReceipts: item.toolReceipts } : {}),
        }] : []),
        completed: stored.completed ?? [],
        deadLetters: stored.deadLetters ?? [],
        onlineAt: stored.onlineAt ?? Date.now(),
      };
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = { pending: [], completed: [], deadLetters: [], onlineAt: Date.now() };
    }
  }
  get size(): number { return this.state.pending.length; }
  get deadLetterSize(): number { return this.state.deadLetters.length; }
  get onlineAt(): number { return this.state.onlineAt; }
  heartbeat(): void { this.state.onlineAt = Date.now(); this.save(); }
  items(now = Date.now()): InboxItem[] {
    return this.state.pending.filter(item => item.nextAttemptAt <= now)
      .sort((a, b) => a.messageId.localeCompare(b.messageId));
  }
  add(channelId: string, messageId: string): void {
    if (this.state.completed.includes(messageId) || this.state.pending.some(x => x.messageId === messageId) ||
      this.state.deadLetters.some(x => x.messageId === messageId)) return;
    this.state.pending.push({ channelId, messageId, attempts: 0, nextAttemptAt: 0 }); this.save();
  }
  defer(messageId: string, options: { delayMs: number; noticeMessageId?: string; error?: string; countAttempt?: boolean }): void {
    const item = this.state.pending.find(candidate => candidate.messageId === messageId);
    if (!item) return;
    if (options.countAttempt !== false) item.attempts += 1;
    item.nextAttemptAt = Date.now() + options.delayMs;
    if (options.noticeMessageId) item.noticeMessageId = options.noticeMessageId;
    if (options.error) item.lastError = options.error.slice(0, 500);
    this.save();
  }
  fail(messageId: string, error?: string): void {
    const item = this.state.pending.find(candidate => candidate.messageId === messageId);
    if (!item) return;
    this.state.pending = this.state.pending.filter(candidate => candidate.messageId !== messageId);
    this.state.deadLetters.push({ ...item, ...(error ? { lastError: error.slice(0, 500) } : {}) });
    this.state.deadLetters = this.state.deadLetters.slice(-1_000);
    this.save();
  }
  requeueDeadLetters(limit = 100): number {
    const selected = this.state.deadLetters.splice(0, limit);
    for (const item of selected) {
      this.state.pending.push({ ...item, nextAttemptAt: 0 });
    }
    if (selected.length > 0) this.save();
    return selected.length;
  }
  toolReceipt(messageId: string, key: string): { found: boolean; value?: unknown } {
    const item = this.state.pending.find(candidate => candidate.messageId === messageId);
    if (!item?.toolReceipts || !Object.hasOwn(item.toolReceipts, key)) return { found: false };
    return { found: true, value: item.toolReceipts[key] };
  }
  recordToolReceipt(messageId: string, key: string, value: unknown): void {
    const item = this.state.pending.find(candidate => candidate.messageId === messageId);
    if (!item) return;
    item.toolReceipts ??= {};
    item.toolReceipts[key] = value;
    this.save();
  }
  remove(messageId: string): void {
    this.state.pending = this.state.pending.filter(x => x.messageId !== messageId);
    this.state.completed.push(messageId);
    this.state.completed = this.state.completed.slice(-10000); this.save();
  }
  private save(): void {
    writeFileSync(this.path + ".tmp", JSON.stringify(this.state), { mode: 0o600 });
    renameSync(this.path + ".tmp", this.path);
  }
}
export const inbox = new Inbox(join(process.env.SU_STATE_DIR ?? join(homedir(), ".local/state/su-gateway"), "inbox.json"));
