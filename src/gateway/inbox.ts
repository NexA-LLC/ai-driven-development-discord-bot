import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
interface Item { channelId: string; messageId: string }
interface State { pending: Item[]; completed: string[]; onlineAt: number }
export class Inbox {
  private state: State;
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { this.state = JSON.parse(readFileSync(path, "utf8")) as State; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = { pending: [], completed: [], onlineAt: Date.now() };
    }
  }
  get size(): number { return this.state.pending.length; }
  get onlineAt(): number { return this.state.onlineAt; }
  heartbeat(): void { this.state.onlineAt = Date.now(); this.save(); }
  items(): Item[] { return [...this.state.pending].sort((a, b) => a.messageId.localeCompare(b.messageId)); }
  add(channelId: string, messageId: string): void {
    if (this.state.completed.includes(messageId) || this.state.pending.some(x => x.messageId === messageId)) return;
    this.state.pending.push({ channelId, messageId }); this.save();
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
