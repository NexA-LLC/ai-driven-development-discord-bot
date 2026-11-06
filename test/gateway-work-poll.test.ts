import { describe, expect, it, vi } from "vitest";
import { Lifecycle } from "../src/gateway/lifecycle.js";
import { runWorkPollCycle } from "../src/gateway/work-poll.js";
import type { GatewayJob, GatewayCommand, GatewayWorkBatch } from "../src/shared/gateway-work.js";
const job = (id: string) => ({ id, mode: "ask", input: "hello", language: "ja", application_id: "app", interaction_token: "token", ephemeral: 1, guild_id: null, requester_user_id: null }) as GatewayJob;
const command = (id: string): GatewayCommand => ({ id, kind: "say", payload: { text: "hi" } });
function setup(batch: GatewayWorkBatch = { jobs: [job("j1"), job("j2")], commands: [command("c1"), command("c2")] }) {
  return { lifecycle: new Lifecycle(), claim: vi.fn(async () => batch), processJob: vi.fn(async (_job: GatewayJob) => {}), processCommand: vi.fn(async (_command: GatewayCommand) => {}), onItemError: vi.fn() };
}
describe("combined work poll cycle", () => {
  it("claims once and processes both queues sequentially under active tracking", async () => {
    const options = setup(); const seen: string[] = [];
    options.claim.mockImplementation(async () => { expect(options.lifecycle.active).toBe(1); return { jobs: [job("j")], commands: [command("c")] }; });
    options.processJob.mockImplementation(async item => { expect(options.lifecycle.active).toBeGreaterThan(0); seen.push(item.id); });
    options.processCommand.mockImplementation(async item => { expect(options.lifecycle.active).toBeGreaterThan(0); seen.push(item.id); });
    await runWorkPollCycle(options);
    expect(seen).toEqual(["j", "c"]); expect(options.claim).toHaveBeenCalledTimes(1); expect(options.lifecycle.active).toBe(0);
  });
  it("does not acquire work while draining", async () => {
    const options = setup(); options.lifecycle.drain(); await runWorkPollCycle(options);
    expect(options.claim).not.toHaveBeenCalled(); expect(options.processJob).not.toHaveBeenCalled(); expect(options.lifecycle.active).toBe(0);
  });
  it("draining during claim still finishes every returned item but prevents another claim", async () => {
    const options = setup(); const batch = await options.claim(); options.claim.mockClear();
    options.claim.mockImplementation(async () => { options.lifecycle.drain(); return batch; });
    await runWorkPollCycle(options); await runWorkPollCycle(options);
    expect(options.claim).toHaveBeenCalledTimes(1); expect(options.processJob).toHaveBeenCalledTimes(2); expect(options.processCommand).toHaveBeenCalledTimes(2); expect(options.lifecycle.active).toBe(0);
  });
  it("draining in the first job does not abandon later jobs or commands", async () => {
    const options = setup(); options.processJob.mockImplementationOnce(async () => { options.lifecycle.drain(); });
    await runWorkPollCycle(options);
    expect(options.processJob).toHaveBeenCalledTimes(2); expect(options.processCommand).toHaveBeenCalledTimes(2);
  });
  it("isolates job and command failures, including failed acknowledgements", async () => {
    const options = setup(); const error = new Error("completion network failure");
    options.processJob.mockRejectedValueOnce(error); options.processCommand.mockRejectedValueOnce(error);
    await runWorkPollCycle(options);
    expect(options.processJob).toHaveBeenCalledTimes(2); expect(options.processCommand).toHaveBeenCalledTimes(2);
    expect(options.onItemError.mock.calls).toEqual([["job", "j1", error], ["command", "c1", error]]);
    expect(options.lifecycle.active).toBe(0);
  });
  it.each(["timeout after server commit", "Worker returned 500", "unsupported route 404", "invalid JSON response"])("does not retry or fall back after %s", async message => {
    const options = setup(); options.claim.mockRejectedValue(new Error(message));
    await expect(runWorkPollCycle(options)).rejects.toThrow(message);
    expect(options.claim).toHaveBeenCalledTimes(1); expect(options.processJob).not.toHaveBeenCalled(); expect(options.processCommand).not.toHaveBeenCalled(); expect(options.lifecycle.active).toBe(0);
  });
  it.each([null, {}, { jobs: [] }, { jobs: [job("j")], commands: null }, { jobs: {}, commands: [] }])("rejects malformed batch before processing anything: %j", async batch => {
    const options = setup(); options.claim.mockResolvedValue(batch as GatewayWorkBatch);
    await expect(runWorkPollCycle(options)).rejects.toThrow();
    expect(options.processJob).not.toHaveBeenCalled(); expect(options.processCommand).not.toHaveBeenCalled(); expect(options.claim).toHaveBeenCalledTimes(1); expect(options.lifecycle.active).toBe(0);
  });
});
