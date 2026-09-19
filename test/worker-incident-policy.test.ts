import { describe, expect, it } from "vitest";
import { shouldOpenIncidentIssue } from "../src/worker/index.js";

describe("incident improvement loop", () => {
  it("opens the Repo Deck improvement issue on the first user-visible LLM failure", () => {
    expect(shouldOpenIncidentIssue({ kind: "mention_llm_failed", severity: "error" }, 1)).toBe(true);
    expect(shouldOpenIncidentIssue({ kind: "llm_model_unavailable", severity: "critical" }, 1)).toBe(true);
  });

  it("keeps the noise threshold for lower-signal incidents", () => {
    expect(shouldOpenIncidentIssue({ kind: "maintenance_failed", severity: "warning" }, 1)).toBe(false);
    expect(shouldOpenIncidentIssue({ kind: "maintenance_failed", severity: "warning" }, 3)).toBe(true);
  });
});
