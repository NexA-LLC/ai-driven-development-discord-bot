import { describe, expect, it } from "vitest";
import { evaluateAgentManifest } from "../src/shared/agent-manifest.js";

const safeManifest = {
  schemaVersion: "1",
  id: "safe-reviewer",
  name: "Safe Reviewer",
  description: "Reviews code only after an explicit user request in an opted-in thread.",
  installationMode: "agent_dock",
  endpoint: "https://agent.example.com/events",
  triggers: ["direct_mention"],
  actions: ["reply"],
  requestedPermissions: [],
  privilegedIntents: [],
  data: {
    storesMessageContent: false,
    retentionDays: 0,
    modelProviders: ["example"],
    trainingWithDiscordData: false,
  },
  limits: {
    requestsPerMinute: 10,
    maxContextMessages: 5,
    maxOutputChars: 1900,
  },
  contact: {
    developer: "Example Developer",
    supportUrl: "https://agent.example.com/support",
  },
} as const;

describe("evaluateAgentManifest", () => {
  it("marks a least-privilege Agent Dock manifest green", () => {
    const passport = evaluateAgentManifest(safeManifest);

    expect(passport.band).toBe("green");
    expect(passport.score).toBe(100);
    expect(passport.eligibleForAutomaticSandbox).toBe(true);
  });

  it("blocks administrator permission", () => {
    const passport = evaluateAgentManifest({
      ...safeManifest,
      installationMode: "guild_install",
      endpoint: undefined,
      requestedPermissions: ["ADMINISTRATOR"],
    });

    expect(passport.band).toBe("blocked");
    expect(passport.eligibleForAutomaticSandbox).toBe(false);
    expect(passport.reasons.join(" ")).toContain("ADMINISTRATOR");
  });

  it("blocks Discord data training", () => {
    const passport = evaluateAgentManifest({
      ...safeManifest,
      data: {
        ...safeManifest.data,
        trainingWithDiscordData: true,
      },
    });

    expect(passport.band).toBe("blocked");
  });

  it("rejects privileged intents on a user-installed app", () => {
    const passport = evaluateAgentManifest({
      ...safeManifest,
      installationMode: "user_install",
      endpoint: undefined,
      privilegedIntents: ["MESSAGE_CONTENT"],
    });

    expect(passport.band).toBe("blocked");
    expect(passport.manifest).toBeNull();
  });
});
