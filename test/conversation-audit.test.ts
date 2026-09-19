import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAudit } from "../src/gateway/conversation-audit.js";

it("preserves multiline input and identity, restricts access and expires old logs", () => {
  const directory = mkdtempSync(join(tmpdir(), "su-audit-"));
  try {
    writeFileSync(join(directory, "2026-01-01.jsonl"), "old");
    writeAudit({ id: "job1", event: "quiz", phase: "received", userId: "user1", guildId: "guild1", input: "堀大輔\nについて" }, directory, new Date("2026-09-09T00:00:00Z"));
    const path = join(directory, "2026-09-09.jsonl");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ userId: "user1", input: "堀大輔\nについて" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(existsSync(join(directory, "2026-01-01.jsonl"))).toBe(false);
  } finally { rmSync(directory, { recursive: true }); }
});
