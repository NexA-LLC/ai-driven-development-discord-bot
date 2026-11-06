import type { GatewayCommand, GatewayJob, GatewayWorkBatch } from "../shared/gateway-work.js";

type JobRow = GatewayJob & { created_at: string };
type CommandRow = { id: string; kind: string; payload_json: string; created_at: string };

function fifo(a: { created_at: string; id: string }, b: { created_at: string; id: string }): number {
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

/** Both queues commit together. A failed statement rolls back the D1 batch. */
export async function claimGatewayWork(
  db: D1Database,
  now = new Date().toISOString(),
): Promise<GatewayWorkBatch> {
  const results = await db.batch([
    db.prepare(`UPDATE ai_jobs
      SET status = 'expired', input = NULL, completed_at = ?
      WHERE status IN ('pending', 'claimed') AND expires_at < ?`).bind(now, now),
    db.prepare(`UPDATE gateway_commands
      SET status = 'expired', completed_at = ?
      WHERE status = 'pending' AND expires_at < ?`).bind(now, now),
    db.prepare(`UPDATE ai_jobs SET status = 'claimed', claimed_at = ?
      WHERE status = 'pending' AND id IN (
        SELECT id FROM ai_jobs WHERE status = 'pending'
        ORDER BY created_at ASC, id ASC LIMIT 5
      )
      RETURNING id, mode, input, language, application_id, interaction_token,
        ephemeral, guild_id, requester_user_id, created_at`).bind(now),
    db.prepare(`UPDATE gateway_commands SET status = 'claimed', claimed_at = ?
      WHERE status = 'pending' AND id IN (
        SELECT id FROM gateway_commands WHERE status = 'pending'
        ORDER BY created_at ASC, id ASC LIMIT 5
      )
      RETURNING id, kind, payload_json, created_at`).bind(now),
  ]);
  if (results.length !== 4 || results.some(result => !result.success)) {
    throw new Error("Combined work claim did not return a complete successful batch");
  }
  // SQLite RETURNING order is unspecified even though the subquery is ordered.
  const jobs = (results[2]!.results as JobRow[]).sort(fifo).map(({ created_at: _at, ...job }) => job);
  const commands = (results[3]!.results as CommandRow[]).sort(fifo).map((row): GatewayCommand => {
    try {
      const payload: unknown = JSON.parse(row.payload_json);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Command payload must be an object");
      }
      return { id: row.id, kind: row.kind, payload: payload as Record<string, unknown> };
    } catch {
      // Do not lose jobs or other commands after their claims have committed.
      // The Gateway acknowledges this item as failed without sending anything.
      return { id: row.id, kind: row.kind, payload: {}, payloadError: "invalid_command_payload" };
    }
  });
  return { jobs, commands };
}
