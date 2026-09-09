import { appendFileSync, chmodSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface AuditEntry {
  id: string;
  event: string;
  phase: string;
  tool?: string;
  userId: string | null;
  guildId: string | null;
  channelId?: string;
  messageId?: string;
  input?: string | null;
  response?: string;
  ok?: boolean;
}

export function writeAudit(entry: AuditEntry, directory: string, now = new Date()): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const cutoff = new Date(now.getTime() - 30 * 86400_000).toISOString().slice(0, 10);
  for (const name of readdirSync(directory)) {
    if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) <= cutoff) {
      unlinkSync(join(directory, name));
    }
  }
  const path = join(directory, `${now.toISOString().slice(0, 10)}.jsonl`);
  appendFileSync(path, JSON.stringify({ ...entry, timestamp: now.toISOString() }) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function auditConversation(entry: AuditEntry): void {
  try {
    writeAudit(entry, join(process.env.SU_STATE_DIR ?? join(homedir(), ".local/state/su-gateway"), "conversation-audit"));
  } catch {
    // Never put message bodies or credentials in the process log on failure.
    console.error(`conversation audit write failed id=${entry.id} phase=${entry.phase}`);
  }
}

// Expire files even when no conversations arrive.
const cleanupTimer = setInterval(() => {
  const directory = join(process.env.SU_STATE_DIR ?? join(homedir(), ".local/state/su-gateway"), "conversation-audit");
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  try {
    for (const name of readdirSync(directory)) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) <= cutoff) unlinkSync(join(directory, name));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("conversation audit cleanup failed");
  }
}, 3600_000);
cleanupTimer.unref();
