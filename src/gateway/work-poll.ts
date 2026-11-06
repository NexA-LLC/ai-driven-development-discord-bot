import type { GatewayCommand, GatewayJob, GatewayWorkBatch } from "../shared/gateway-work.js";
import type { Lifecycle } from "./lifecycle.js";

interface WorkPollOptions {
  lifecycle: Lifecycle;
  claim: () => Promise<GatewayWorkBatch>;
  processJob: (job: GatewayJob) => Promise<void>;
  processCommand: (command: GatewayCommand) => Promise<void>;
  onItemError: (kind: "job" | "command", id: string, error: unknown) => void;
}

/** One non-overlapping claim, tracked through every delivery and acknowledgement. */
export async function runWorkPollCycle(options: WorkPollOptions): Promise<void> {
  if (options.lifecycle.draining) return;
  await options.lifecycle.run(async () => {
    const batch = await options.claim();
    if (!batch || !Array.isArray(batch.jobs) || !Array.isArray(batch.commands)) {
      throw new Error("Invalid combined work claim response");
    }
    // Drain can begin during the claim. All already-claimed items must still run.
    // No retry/fallback here: a lost response may already have committed claims.
    for (const job of batch.jobs) {
      try { await options.processJob(job); }
      catch (error) { options.onItemError("job", job.id, error); }
    }
    for (const command of batch.commands) {
      try { await options.processCommand(command); }
      catch (error) { options.onItemError("command", command.id, error); }
    }
  });
}
