import { z } from "zod";

const httpsUrlSchema = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === "https:", {
    message: "HTTPS URL is required",
  });

const installationModeSchema = z.enum([
  "user_install",
  "guild_install",
  "agent_dock",
]);

const triggerSchema = z.enum([
  "direct_mention",
  "slash_command",
  "opted_in_thread",
  "manual_dispatch",
]);

const actionSchema = z.enum([
  "reply",
  "add_reaction",
  "create_thread",
  "create_issue",
  "create_pitch",
  "request_handoff",
]);

const privilegedIntentSchema = z.enum([
  "MESSAGE_CONTENT",
  "GUILD_MEMBERS",
  "GUILD_PRESENCES",
]);

export const agentManifestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, {
        message: "id must be lowercase kebab-case",
      }),
    name: z.string().min(2).max(64),
    description: z.string().min(10).max(500),
    installationMode: installationModeSchema,
    endpoint: httpsUrlSchema.optional(),
    triggers: z.array(triggerSchema).min(1).max(8),
    actions: z.array(actionSchema).min(1).max(12),
    requestedPermissions: z
      .array(z.string().regex(/^[A-Z_]+$/))
      .max(32)
      .default([]),
    privilegedIntents: z.array(privilegedIntentSchema).max(3).default([]),
    data: z
      .object({
        storesMessageContent: z.boolean(),
        retentionDays: z.number().int().min(0).max(365),
        modelProviders: z.array(z.string().min(1).max(100)).max(10).default([]),
        trainingWithDiscordData: z.boolean(),
        deletionUrl: httpsUrlSchema.optional(),
      })
      .strict(),
    limits: z
      .object({
        requestsPerMinute: z.number().int().min(1).max(60),
        maxContextMessages: z.number().int().min(0).max(50),
        maxOutputChars: z.number().int().min(100).max(8_000),
      })
      .strict(),
    contact: z
      .object({
        developer: z.string().min(2).max(100),
        supportUrl: httpsUrlSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.installationMode === "agent_dock" && !manifest.endpoint) {
      context.addIssue({
        code: "custom",
        path: ["endpoint"],
        message: "Agent Dock requires an HTTPS endpoint",
      });
    }

    if (
      manifest.installationMode === "agent_dock" &&
      manifest.requestedPermissions.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["requestedPermissions"],
        message: "Agent Dock must not request Discord permissions",
      });
    }

    if (
      manifest.installationMode === "user_install" &&
      manifest.privilegedIntents.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["privilegedIntents"],
        message: "User-installed apps cannot request Gateway intents",
      });
    }
  });

export type AgentManifest = z.infer<typeof agentManifestSchema>;
export type PassportBand = "green" | "yellow" | "red" | "blocked";

export interface AgentPassport {
  manifest: AgentManifest | null;
  score: number;
  band: PassportBand;
  eligibleForAutomaticSandbox: boolean;
  reasons: string[];
}

const blockedPermissions = new Set([
  "ADMINISTRATOR",
  "MANAGE_GUILD",
  "MANAGE_ROLES",
  "MANAGE_CHANNELS",
  "MANAGE_WEBHOOKS",
  "BAN_MEMBERS",
  "KICK_MEMBERS",
  "MODERATE_MEMBERS",
  "MENTION_EVERYONE",
]);

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

export function evaluateAgentManifest(input: unknown): AgentPassport {
  const parsed = agentManifestSchema.safeParse(input);

  if (!parsed.success) {
    return {
      manifest: null,
      score: 0,
      band: "blocked",
      eligibleForAutomaticSandbox: false,
      reasons: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`,
      ),
    };
  }

  const manifest = parsed.data;
  const reasons: string[] = [];
  const blockers: string[] = [];
  let score = 100;

  for (const permission of manifest.requestedPermissions) {
    if (blockedPermissions.has(permission)) {
      blockers.push(`permission ${permission} is not allowed for auto-install`);
    }
  }

  if (manifest.data.trainingWithDiscordData) {
    blockers.push("training with Discord data is not allowed");
  }

  if (manifest.privilegedIntents.includes("MESSAGE_CONTENT")) {
    score -= 20;
    reasons.push("uses MESSAGE_CONTENT privileged intent (-20)");
  }

  if (manifest.privilegedIntents.includes("GUILD_MEMBERS")) {
    score -= 12;
    reasons.push("uses GUILD_MEMBERS privileged intent (-12)");
  }

  if (manifest.privilegedIntents.includes("GUILD_PRESENCES")) {
    score -= 8;
    reasons.push("uses GUILD_PRESENCES privileged intent (-8)");
  }

  if (manifest.data.storesMessageContent) {
    score -= 15;
    reasons.push("stores message content (-15)");
  }

  if (manifest.data.retentionDays > 30) {
    score -= 20;
    reasons.push("retention exceeds 30 days (-20)");
  } else if (manifest.data.retentionDays > 7) {
    score -= 10;
    reasons.push("retention exceeds 7 days (-10)");
  } else if (manifest.data.retentionDays > 0) {
    score -= 5;
    reasons.push("retains data after request completion (-5)");
  }

  if (manifest.data.retentionDays > 0 && !manifest.data.deletionUrl) {
    score -= 10;
    reasons.push("retains data without a deletion URL (-10)");
  }

  if (manifest.limits.requestsPerMinute > 30) {
    score -= 10;
    reasons.push("high request rate limit (-10)");
  }

  if (!manifest.contact.supportUrl) {
    score -= 5;
    reasons.push("no public support URL (-5)");
  }

  score = clampScore(score);
  reasons.unshift(...blockers);

  let band: PassportBand;
  if (blockers.length > 0) {
    band = "blocked";
  } else if (score >= 85) {
    band = "green";
  } else if (score >= 65) {
    band = "yellow";
  } else {
    band = "red";
  }

  return {
    manifest,
    score,
    band,
    eligibleForAutomaticSandbox: band === "green",
    reasons: reasons.length > 0 ? reasons : ["no material risks declared"],
  };
}
