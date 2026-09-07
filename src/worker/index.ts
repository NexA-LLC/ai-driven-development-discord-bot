import { verifyKey } from "discord-interactions";
import {
  evaluateAgentManifest,
  type AgentPassport,
} from "../shared/agent-manifest.js";
import { discordCommands } from "../shared/commands.js";
import {
  ABOUT_TEXT,
  APP_DESCRIPTION,
  buildSystemPrompt,
  detectLanguage,
  type AskMode,
} from "../shared/persona.js";

interface Env {
  DB: D1Database;
  AI?: Ai;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APPLICATION_ID?: string;
  INTERNAL_SHARED_SECRET: string;
  /**
   * "gateway": queue /ask and /pitch for the Gateway process, which runs the
   *   in-house LLM and answers through the interaction webhook (default).
   * "workers-ai": answer from the Worker with the Cloudflare Workers AI binding.
   * "worker": call an OpenAI-compatible Chat Completions API from the Worker.
   */
  AI_PROVIDER?: string;
  AI_API_URL?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
  PITCHEEE_URL?: string;
  COMMUNITY_NAME?: string;
  /** Discord channel for operator notifications (店長室). */
  OPS_CHANNEL_ID?: string;
  /** Fine-grained GitHub token (issues:write on this repo) for incident issues. */
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  CASEFLOW_MCP_URL?: string;
  CASEFLOW_MCP_TOKEN?: string;
  CASEFLOW_PROJECT_ID?: string;
  DECISIONGARDEN_MCP_URL?: string;
  DECISIONGARDEN_MCP_TOKEN?: string;
  DECISIONGARDEN_GARDEN_ID?: string;
}

interface AiJobRow {
  id: string;
  mode: AskMode;
  input: string | null;
  language: string;
  application_id: string;
  interaction_token: string;
  ephemeral: number;
  guild_id: string | null;
  requester_user_id: string | null;
}

const JOB_TTL_SECONDS = 14 * 60; // Discord interaction tokens live 15 minutes.
const JOB_CLAIM_LIMIT = 5;

interface DiscordOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordOption[];
}

interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  user?: { id: string };
  member?: { user?: { id: string } };
  data?: {
    name?: string;
    options?: DiscordOption[];
  };
}

interface InternalEvent {
  eventId: string;
  eventType: string;
  guildId?: string;
  channelId?: string;
  messageId?: string;
  actorId?: string;
  actorIsBot?: boolean;
  occurredAt: string;
  reason?: string;
  count?: number;
  windowSeconds?: number;
  contentObserved?: boolean;
}

const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
} as const;

const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
} as const;

const EPHEMERAL_FLAG = 1 << 6;
const encoder = new TextEncoder();

export default {
  async fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "ai-driven-development-discord-bot",
        storage: "D1",
        rawMessageStorage: false,
      });
    }

    if (request.method === "GET" && url.pathname === "/api/agents") {
      return listApprovedAgents(request, env);
    }

    if (request.method === "POST" && url.pathname === "/interactions") {
      return handleDiscordInteraction(request, env, context);
    }

    if (request.method === "POST" && url.pathname === "/internal/ask") {
      return handleInternalAsk(request, env);
    }

    if (request.method === "POST" && url.pathname === "/internal/events") {
      return handleInternalEvent(request, env);
    }

    if (request.method === "POST" && url.pathname === "/internal/agents") {
      return handleInternalAgentSubmission(request, env);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/internal/register-commands"
    ) {
      return handleInternalRegisterCommands(request, env);
    }

    if (request.method === "POST" && url.pathname === "/internal/incidents") {
      return handleInternalIncident(request, env);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/internal/incidents/pending"
    ) {
      return handleInternalIncidentsPending(request, env);
    }

    if (request.method === "POST" && url.pathname === "/internal/incidents/ack") {
      return handleInternalIncidentsAck(request, env);
    }

    if (request.method === "POST" && url.pathname === "/internal/reply-logs") {
      return handleInternalReplyLog(request, env);
    }

    if (request.method === "POST" && url.pathname === "/internal/feedback") {
      return handleInternalFeedback(request, env);
    }

    if (request.method === "POST" && url.pathname === "/internal/profile") {
      return handleInternalProfile(request, env);
    }

    if (request.method === "POST" && url.pathname === "/internal/ai-test") {
      return handleInternalAiTest(request, env);
    }

    if (request.method === "POST" && url.pathname === "/internal/jobs/claim") {
      return handleInternalJobsClaim(request, env);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/internal/jobs/complete"
    ) {
      return handleInternalJobsComplete(request, env);
    }

    if (request.method === "POST" && url.pathname === "/internal/digest/run") {
      const rawBody = await request.text();
      if (!(await verifyInternalRequest(request, rawBody, env.INTERNAL_SHARED_SECRET))) {
        return json({ error: "invalid_internal_signature" }, 401);
      }
      let hours = 24;
      try {
        const parsed = JSON.parse(rawBody || "{}") as { hours?: unknown };
        if (typeof parsed.hours === "number" && parsed.hours > 0 && parsed.hours <= 24 * 30) {
          hours = parsed.hours;
        }
      } catch {
        // default window
      }
      await runImprovementDigest(env, hours);
      return json({ ok: true, hours });
    }

    return json({ error: "not_found" }, 404);
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ): Promise<void> {
    // Daily at 18:00 UTC = 03:00 JST: turn yesterday's feedback into proposals.
    context.waitUntil(runImprovementDigest(env, 24));
  },
};

async function handleDiscordInteraction(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");

  if (
    !signature ||
    !timestamp ||
    !(await verifyKey(rawBody, signature, timestamp, env.DISCORD_PUBLIC_KEY))
  ) {
    return json({ error: "invalid_request_signature" }, 401);
  }

  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(rawBody) as DiscordInteraction;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (interaction.type === InteractionType.PING) {
    return json({ type: InteractionResponseType.PONG });
  }

  if (interaction.type !== InteractionType.APPLICATION_COMMAND) {
    return interactionMessage("このInteraction種別には未対応です。", true);
  }

  const command = interaction.data?.name;

  switch (command) {
    case "ask": {
      const prompt = getStringOption(interaction, "prompt");
      const isPublic = getBooleanOption(interaction, "public") ?? false;

      if (!prompt) {
        return interactionMessage("`prompt` が必要です。", true);
      }

      return startAiJob(interaction, env, context, "ask", prompt, !isPublic);
    }

    case "pitch": {
      const idea = getStringOption(interaction, "idea");
      const isPublic = getBooleanOption(interaction, "public") ?? false;

      if (!idea) {
        return interactionMessage("`idea` が必要です。", true);
      }

      return startAiJob(interaction, env, context, "pitch", idea, !isPublic);
    }

    case "agents":
      return handleAgentsCommand(interaction, env);

    case "agent-submit":
      return handleAgentSubmitCommand(interaction, env);

    case "feedback":
      return handleFeedbackCommand(interaction, env);

    case "inquiry":
      return handleInquiryCommand(interaction, env, context);

    case "inquiry-status":
      return handleInquiryStatusCommand(interaction, env, context);

    case "about":
      return interactionMessage(ABOUT_TEXT, true);

    default:
      return interactionMessage("未知のコマンドです。", true);
  }
}

async function handleAgentsCommand(
  interaction: DiscordInteraction,
  env: Env,
): Promise<Response> {
  const guildId = interaction.guild_id;
  if (!guildId) {
    return interactionMessage("このコマンドはサーバー内で利用してください。", true);
  }

  const result = await env.DB.prepare(
    `SELECT agent_id, name, description, passport_band
       FROM agent_submissions
      WHERE guild_id = ? AND status = 'approved' AND agent_id IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 10`,
  )
    .bind(guildId)
    .all<{
      agent_id: string;
      name: string | null;
      description: string | null;
      passport_band: string | null;
    }>();

  if (result.results.length === 0) {
    return interactionMessage(
      "承認済みAgentはまだありません。`/agent-submit` から申請できます。",
      true,
    );
  }

  const lines = result.results.map(
    (row) =>
      `• **${row.name ?? row.agent_id}** [${row.passport_band ?? "unrated"}]\n  ${row.description ?? "説明なし"}`,
  );

  return interactionMessage(
    `**承認済みAgent**\n${lines.join("\n")}`,
    true,
  );
}

async function handleAgentSubmitCommand(
  interaction: DiscordInteraction,
  env: Env,
): Promise<Response> {
  const guildId = interaction.guild_id;
  const manifestUrl = getStringOption(interaction, "manifest_url");
  const submitterUserId =
    interaction.member?.user?.id ?? interaction.user?.id ?? "unknown";

  if (!guildId) {
    return interactionMessage("Agent申請はサーバー内で行ってください。", true);
  }

  if (!manifestUrl || !isSafeManifestUrl(manifestUrl)) {
    return interactionMessage(
      "公開HTTPS URLの `agent-manifest.json` を指定してください。",
      true,
    );
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO agent_submissions
      (id, guild_id, submitter_user_id, manifest_url, status)
     VALUES (?, ?, ?, ?, 'pending')`,
  )
    .bind(id, guildId, submitterUserId, manifestUrl)
    .run();

  return interactionMessage(
    [
      `申請を受け付けました: \`${id}\``,
      "manifestはこの時点では自動取得しません。運営の検査経路で取得し、権限・保存方針・外部LLM・レートをPassport化します。",
    ].join("\n"),
    true,
  );
}

async function handleInternalAsk(
  request: Request,
  env: Env,
): Promise<Response> {
  const rawBody = await request.text();
  if (
    !(await verifyInternalRequest(
      request,
      rawBody,
      env.INTERNAL_SHARED_SECRET,
    ))
  ) {
    return json({ error: "invalid_internal_signature" }, 401);
  }

  let body: { prompt?: unknown; provider?: unknown };
  try {
    body = JSON.parse(rawBody) as { prompt?: unknown; provider?: unknown };
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (
    typeof body.prompt !== "string" ||
    body.prompt.length < 1 ||
    body.prompt.length > 8_000
  ) {
    return json({ error: "invalid_prompt" }, 400);
  }

  const provider =
    body.provider === "workers-ai" && env.AI ? "workers-ai" : undefined;
  const text = await callAi(env, "ask", body.prompt, provider);
  return json({ text: truncate(text, 1_900) });
}

async function handleInternalEvent(
  request: Request,
  env: Env,
): Promise<Response> {
  const rawBody = await request.text();
  if (
    !(await verifyInternalRequest(
      request,
      rawBody,
      env.INTERNAL_SHARED_SECRET,
    ))
  ) {
    return json({ error: "invalid_internal_signature" }, 401);
  }

  let event: InternalEvent;
  try {
    event = JSON.parse(rawBody) as InternalEvent;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (
    typeof event.eventId !== "string" ||
    typeof event.eventType !== "string" ||
    typeof event.occurredAt !== "string"
  ) {
    return json({ error: "invalid_event" }, 400);
  }

  // Intentionally excludes message content. Audit is metadata-only by default.
  const safeDetail = JSON.stringify({
    actorIsBot: Boolean(event.actorIsBot),
    reason: event.reason,
    count: event.count,
    windowSeconds: event.windowSeconds,
    contentObserved: Boolean(event.contentObserved),
  });

  await env.DB.prepare(
    `INSERT OR IGNORE INTO audit_events
      (id, event_type, guild_id, channel_id, message_id, actor_id, detail_json, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      event.eventId,
      event.eventType,
      event.guildId ?? null,
      event.channelId ?? null,
      event.messageId ?? null,
      event.actorId ?? null,
      safeDetail,
      event.occurredAt,
    )
    .run();

  if (event.eventType === "bot_rate_exceeded") {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO incidents
        (id, guild_id, channel_id, subject_id, incident_type, evidence_json, status)
       VALUES (?, ?, ?, ?, 'bot_rate_exceeded', ?, 'open')`,
    )
      .bind(
        event.eventId,
        event.guildId ?? null,
        event.channelId ?? null,
        event.actorId ?? null,
        safeDetail,
      )
      .run();
  }

  return json({ ok: true });
}

async function handleInternalAgentSubmission(
  request: Request,
  env: Env,
): Promise<Response> {
  const rawBody = await request.text();
  if (
    !(await verifyInternalRequest(
      request,
      rawBody,
      env.INTERNAL_SHARED_SECRET,
    ))
  ) {
    return json({ error: "invalid_internal_signature" }, 401);
  }

  let body: {
    guildId?: unknown;
    submitterUserId?: unknown;
    manifestUrl?: unknown;
    manifest?: unknown;
  };

  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (
    typeof body.guildId !== "string" ||
    typeof body.submitterUserId !== "string"
  ) {
    return json({ error: "guildId_and_submitterUserId_are_required" }, 400);
  }

  const passport = evaluateAgentManifest(body.manifest);
  const id = crypto.randomUUID();
  const manifest = passport.manifest;
  const status = passport.band === "blocked" ? "rejected" : "pending";

  await env.DB.prepare(
    `INSERT INTO agent_submissions
      (id, guild_id, submitter_user_id, agent_id, name, description,
       installation_mode, manifest_url, endpoint, manifest_json, status,
       passport_score, passport_band, passport_reasons_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      body.guildId,
      body.submitterUserId,
      manifest?.id ?? null,
      manifest?.name ?? null,
      manifest?.description ?? null,
      manifest?.installationMode ?? null,
      typeof body.manifestUrl === "string" ? body.manifestUrl : null,
      manifest?.endpoint ?? null,
      JSON.stringify(body.manifest),
      status,
      passport.score,
      passport.band,
      JSON.stringify(passport.reasons),
    )
    .run();

  return json({ id, status, passport });
}

async function listApprovedAgents(
  request: Request,
  env: Env,
): Promise<Response> {
  const guildId = new URL(request.url).searchParams.get("guild_id");
  if (!guildId) {
    return json({ error: "guild_id_is_required" }, 400);
  }

  const result = await env.DB.prepare(
    `SELECT agent_id, name, description, installation_mode,
            endpoint, passport_score, passport_band, updated_at
       FROM agent_submissions
      WHERE guild_id = ? AND status = 'approved' AND agent_id IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 100`,
  )
    .bind(guildId)
    .all();

  return json({ agents: result.results });
}

async function generateAndFollowUp(
  interaction: DiscordInteraction,
  env: Env,
  mode: "ask" | "pitch",
  input: string,
  ephemeral: boolean,
): Promise<void> {
  let text: string;
  try {
    text = await callAi(env, mode, input);
  } catch (error) {
    console.error("AI generation failed", error);
    text =
      "AI処理に失敗しました。内容は外部公開していません。時間を置いて再実行するか、運営へ知らせてください。";
  }

  await sendFollowUp(interaction, truncate(text, 1_900), ephemeral);
}

async function callAi(
  env: Env,
  mode: "ask" | "pitch",
  input: string,
  providerOverride?: string,
): Promise<string> {
  const systemPrompt = buildSystemPrompt(mode, detectLanguage(input), {
    pitcheeeUrl: env.PITCHEEE_URL,
  });

  const provider = (providerOverride ?? env.AI_PROVIDER ?? "gateway")
    .trim()
    .toLowerCase();
  if (provider === "workers-ai") {
    if (!env.AI) {
      return fallbackResponse(mode, input, env.PITCHEEE_URL);
    }
    const model = (env.AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast") as Parameters<
      Ai["run"]
    >[0];
    const result = (await env.AI.run(model, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: input },
      ],
      max_tokens: 900,
      temperature: 0.4,
    } as never)) as {
      response?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw =
      result.response ?? result.choices?.[0]?.message?.content ?? "";
    const text = stripReasoning(raw).trim();
    if (!text) {
      throw new Error(
        `Workers AI returned no text: ${JSON.stringify(result).slice(0, 400)}`,
      );
    }
    return text;
  }

  if (!env.AI_API_URL || !env.AI_API_KEY || !env.AI_MODEL) {
    return fallbackResponse(mode, input, env.PITCHEEE_URL);
  }

  const response = await fetch(env.AI_API_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.AI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.AI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: input },
      ],
      temperature: 0.4,
      max_tokens: 900,
    }),
  });

  if (!response.ok) {
    throw new Error(`AI API returned ${response.status}`);
  }

  const body = (await response.json()) as {
    output_text?: string;
    choices?: Array<{ message?: { content?: string } }>;
  };

  const text = body.output_text ?? body.choices?.[0]?.message?.content;
  if (!text || text.trim().length === 0) {
    throw new Error("AI API returned no text");
  }

  return stripReasoning(text).trim();
}

/** Some models echo their reasoning in <think>…</think>; never show it. */
function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<\/?think>/g, "");
}

function fallbackResponse(
  mode: "ask" | "pitch",
  input: string,
  pitcheeeUrl?: string,
): string {
  if (mode === "pitch") {
    const normalized = input.replace(/\s+/g, " ").trim();
    const optionalRoute = pitcheeeUrl
      ? `\n\n公開したくなった場合だけ、掲載先として Pitcheee を選べます: ${pitcheeeUrl}`
      : "";

    return [
      "**15秒ピッチ（仮）**",
      `「${truncate(normalized, 180)}」を、まず1人が試せる最小版にします。使った人の反応から、次に作る機能を決めます。`,
      "",
      "**次の一手**: 対象ユーザー、最初の1機能、成功条件を1行ずつ決める。",
      optionalRoute,
    ].join("\n");
  }

  return [
    "できます。ただしAI接続がまだ設定されていないため、今は実行可能な入口だけ返します。",
    "",
    `対象: ${truncate(input.replace(/\s+/g, " ").trim(), 300)}`,
    "",
    "次に進める形: ①仕様にする ②最小実装に分解する ③15秒ピッチにする",
  ].join("\n");
}

async function sendFollowUp(
  interaction: DiscordInteraction,
  content: string,
  ephemeral: boolean,
): Promise<void> {
  const response = await fetch(
    `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content,
        flags: ephemeral ? EPHEMERAL_FLAG : 0,
        allowed_mentions: { parse: [] },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Discord follow-up returned ${response.status}`);
  }
}

function getStringOption(
  interaction: DiscordInteraction,
  name: string,
): string | undefined {
  const value = interaction.data?.options?.find(
    (option) => option.name === name,
  )?.value;
  return typeof value === "string" ? value : undefined;
}

function getBooleanOption(
  interaction: DiscordInteraction,
  name: string,
): boolean | undefined {
  const value = interaction.data?.options?.find(
    (option) => option.name === name,
  )?.value;
  return typeof value === "boolean" ? value : undefined;
}

function deferInteraction(ephemeral: boolean): Response {
  return json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: ephemeral ? EPHEMERAL_FLAG : 0 },
  });
}

function interactionMessage(content: string, ephemeral: boolean): Response {
  return json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: truncate(content, 1_900),
      flags: ephemeral ? EPHEMERAL_FLAG : 0,
      allowed_mentions: { parse: [] },
    },
  });
}

function isSafeManifestUrl(value: string): boolean {
  if (value.length > 2_048) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hostname !== "localhost"
    );
  } catch {
    return false;
  }
}

async function startAiJob(
  interaction: DiscordInteraction,
  env: Env,
  context: ExecutionContext,
  mode: AskMode,
  input: string,
  ephemeral: boolean,
): Promise<Response> {
  const provider = (env.AI_PROVIDER ?? "gateway").trim().toLowerCase();

  if (provider === "worker" || provider === "workers-ai") {
    context.waitUntil(
      generateAndFollowUp(interaction, env, mode, input, ephemeral),
    );
    return deferInteraction(ephemeral);
  }

  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + JOB_TTL_SECONDS * 1_000).toISOString();
  const requesterUserId =
    interaction.member?.user?.id ?? interaction.user?.id ?? null;

  await env.DB.prepare(
    `INSERT INTO ai_jobs
      (id, mode, input, language, application_id, interaction_token,
       ephemeral, guild_id, requester_user_id, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(
      id,
      mode,
      input,
      detectLanguage(input),
      interaction.application_id,
      interaction.token,
      ephemeral ? 1 : 0,
      interaction.guild_id ?? null,
      requesterUserId,
      expiresAt,
    )
    .run();

  return deferInteraction(ephemeral);
}

async function handleInternalRegisterCommands(
  request: Request,
  env: Env,
): Promise<Response> {
  const rawBody = await request.text();
  if (
    !(await verifyInternalRequest(
      request,
      rawBody,
      env.INTERNAL_SHARED_SECRET,
    ))
  ) {
    return json({ error: "invalid_internal_signature" }, 401);
  }

  let body: { guildId?: unknown };
  try {
    body = rawBody ? (JSON.parse(rawBody) as typeof body) : {};
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const applicationId = env.DISCORD_APPLICATION_ID?.trim();
  if (!applicationId) {
    return json({ error: "DISCORD_APPLICATION_ID_is_not_configured" }, 500);
  }

  const guildId =
    typeof body.guildId === "string" && /^\d{10,25}$/.test(body.guildId)
      ? body.guildId
      : null;

  const endpoint = guildId
    ? `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${applicationId}/commands`;

  const response = await fetch(endpoint, {
    method: "PUT",
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(discordCommands),
  });

  const responseText = await response.text();
  if (!response.ok) {
    return json(
      {
        error: "discord_rejected_commands",
        status: response.status,
        detail: responseText.slice(0, 1_000),
      },
      502,
    );
  }

  const registered = JSON.parse(responseText) as Array<{ name: string }>;
  return json({
    ok: true,
    scope: guildId ? `guild:${guildId}` : "global",
    commands: registered.map((command) => command.name),
  });
}


type IncidentSeverity = "info" | "warning" | "error" | "critical";

interface IncidentInput {
  kind: string;
  severity: IncidentSeverity;
  source: string;
  summary: string;
  detail?: string | undefined;
  dedupeKey?: string | undefined;
}

const INCIDENT_DEDUPE_WINDOW_MS = 60 * 60 * 1_000;
const INCIDENT_ISSUE_THRESHOLD = 3;
const INCIDENT_RENOTIFY_COUNTS = new Set([1, 3, 10, 50]);

/**
 * Record an incident, folding repeats of the same dedupeKey within the window
 * into one row. Notifies the operator channel on the 1st/3rd/10th/50th
 * occurrence and opens a GitHub issue (for Repo Deck) at the 3rd.
 */
async function recordIncident(
  env: Env,
  input: IncidentInput,
): Promise<{ id: string; count: number; issueUrl: string | null }> {
  const now = new Date();
  const nowIso = now.toISOString();
  const dedupeKey = input.dedupeKey ?? `${input.source}:${input.kind}`;
  const detail = input.detail ? truncate(input.detail, 1_500) : null;
  const summary = truncate(input.summary, 300);

  const existing = await env.DB.prepare(
    `SELECT id, count, last_seen_at, issue_url FROM su_incidents
      WHERE dedupe_key = ? AND status = 'open'
      ORDER BY last_seen_at DESC LIMIT 1`,
  )
    .bind(dedupeKey)
    .first<{ id: string; count: number; last_seen_at: string; issue_url: string | null }>();

  let id: string;
  let count: number;
  let issueUrl: string | null = null;

  if (
    existing &&
    now.getTime() - new Date(existing.last_seen_at).getTime() < INCIDENT_DEDUPE_WINDOW_MS
  ) {
    id = existing.id;
    count = existing.count + 1;
    issueUrl = existing.issue_url;
    await env.DB.prepare(
      `UPDATE su_incidents SET count = ?, last_seen_at = ?, detail = ?, severity = ?, relayed_at = NULL
        WHERE id = ?`,
    )
      .bind(count, nowIso, detail, input.severity, id)
      .run();
  } else {
    id = crypto.randomUUID();
    count = 1;
    await env.DB.prepare(
      `INSERT INTO su_incidents (id, dedupe_key, kind, severity, source, summary, detail, count, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(id, dedupeKey, input.kind, input.severity, input.source, summary, detail, nowIso, nowIso)
      .run();
  }

  if (!issueUrl && count >= INCIDENT_ISSUE_THRESHOLD && env.GITHUB_TOKEN) {
    issueUrl = await openIncidentIssue(env, {
      ...input,
      id,
      dedupeKey,
      count,
      summary,
      detail: detail ?? undefined,
    });
    if (issueUrl) {
      await env.DB.prepare(`UPDATE su_incidents SET issue_url = ? WHERE id = ?`).bind(issueUrl, id).run();
    }
  }

  if (INCIDENT_RENOTIFY_COUNTS.has(count) && env.OPS_CHANNEL_ID) {
    const notified = await notifyOps(
      env,
      formatIncidentForOps({ ...input, summary, detail: detail ?? undefined }, count, issueUrl),
    );
    if (notified) {
      await env.DB.prepare(`UPDATE su_incidents SET notified_ops_at = ? WHERE id = ?`).bind(nowIso, id).run();
    }
  }

  return { id, count, issueUrl };
}

function formatIncidentForOps(
  input: IncidentInput,
  count: number,
  issueUrl: string | null,
): string {
  const badge = { info: "ℹ️", warning: "⚠️", error: "🔴", critical: "🚨" }[input.severity];
  const lines = [
    `${badge} **店長さん、報告です** — ${input.summary}`,
    `種別: \`${input.kind}\` / 発生元: ${input.source} / 回数: ${count}`,
  ];
  if (input.detail) {
    lines.push(`\`\`\`\n${truncate(input.detail, 600)}\n\`\`\``);
  }
  if (issueUrl) {
    lines.push(`Repo Deck 向け Issue: ${issueUrl}`);
  }
  lines.push("私では直せないので、見てもらえますか。");
  return lines.join("\n");
}

async function notifyOps(env: Env, content: string): Promise<boolean> {
  if (!env.OPS_CHANNEL_ID) {
    return false;
  }
  const response = await fetch(
    `https://discord.com/api/v10/channels/${env.OPS_CHANNEL_ID}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content: truncate(content, 1_900), allowed_mentions: { parse: [] } }),
    },
  );
  if (!response.ok) {
    console.error("ops notify failed", response.status, (await response.text()).slice(0, 200));
  }
  return response.ok;
}

async function openIncidentIssue(
  env: Env,
  incident: IncidentInput & { id: string; dedupeKey: string; count: number },
): Promise<string | null> {
  const repo = env.GITHUB_REPO || "NexA-LLC/ai-driven-development-discord-bot";
  const title = `[incident] ${incident.summary}`.slice(0, 200);
  const body = [
    `スー（Discord Bot）が同じ障害を ${incident.count} 回検知しました。Repo Deck / 運営で調査・修正をお願いします。`,
    "",
    `- kind: \`${incident.kind}\``,
    `- severity: \`${incident.severity}\``,
    `- source: \`${incident.source}\``,
    `- dedupeKey: \`${incident.dedupeKey}\``,
    `- incident id: \`${incident.id}\``,
    "",
    "## 最新の詳細",
    "```",
    incident.detail ?? "(no detail)",
    "```",
    "",
    "## 期待する作業",
    "1. 原因の切り分け（Gateway / LLM ホスト / Discord / Worker）",
    "2. 再発防止の実装（再試行、フォールバック、監視、設定）",
    "3. 直したら `incidents` の該当行を resolved にする（`/internal/incidents/ack` は relay 用、resolve は手動）",
    "",
    "_opened automatically by the Worker incident loop_",
  ].join("\n");

  const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN ?? ""}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "su-discord-bot-incident-loop",
    },
    body: JSON.stringify({ title, body, labels: ["incident", "su"] }),
  });
  if (!response.ok) {
    console.error("github issue failed", response.status, (await response.text()).slice(0, 300));
    return null;
  }
  const issue = (await response.json()) as { html_url?: string };
  return issue.html_url ?? null;
}

async function handleInternalIncident(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  if (!(await verifyInternalRequest(request, rawBody, env.INTERNAL_SHARED_SECRET))) {
    return json({ error: "invalid_internal_signature" }, 401);
  }
  let body: Partial<IncidentInput>;
  try {
    body = JSON.parse(rawBody) as Partial<IncidentInput>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (typeof body.kind !== "string" || typeof body.summary !== "string") {
    return json({ error: "kind_and_summary_are_required" }, 400);
  }
  const severity: IncidentSeverity = (["info", "warning", "error", "critical"] as const).includes(
    body.severity as IncidentSeverity,
  )
    ? (body.severity as IncidentSeverity)
    : "warning";
  const result = await recordIncident(env, {
    kind: body.kind,
    severity,
    source: typeof body.source === "string" ? body.source : "gateway",
    summary: body.summary,
    detail: typeof body.detail === "string" ? body.detail : undefined,
    dedupeKey: typeof body.dedupeKey === "string" ? body.dedupeKey : undefined,
  });
  return json({ ok: true, ...result });
}

async function handleInternalIncidentsPending(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  if (!(await verifyInternalRequest(request, rawBody, env.INTERNAL_SHARED_SECRET))) {
    return json({ error: "invalid_internal_signature" }, 401);
  }
  const rows = await env.DB.prepare(
    `SELECT id, dedupe_key, kind, severity, source, summary, detail, count,
            first_seen_at, last_seen_at, issue_url
       FROM su_incidents
      WHERE relayed_at IS NULL
      ORDER BY last_seen_at ASC
      LIMIT 20`,
  ).all();
  return json({ incidents: rows.results });
}

async function handleInternalIncidentsAck(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  if (!(await verifyInternalRequest(request, rawBody, env.INTERNAL_SHARED_SECRET))) {
    return json({ error: "invalid_internal_signature" }, 401);
  }
  let body: { ids?: unknown };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === "string").slice(0, 50) : [];
  const now = new Date().toISOString();
  for (const id of ids) {
    await env.DB.prepare(`UPDATE su_incidents SET relayed_at = ? WHERE id = ?`).bind(now, id).run();
  }
  return json({ ok: true, acked: ids.length });
}

async function handleInternalReplyLog(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  if (!(await verifyInternalRequest(request, rawBody, env.INTERNAL_SHARED_SECRET))) {
    return json({ error: "invalid_internal_signature" }, 401);
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO reply_logs (id, event, guild_id, channel_id, message_id, requester_user_id,
                             provider, model, latency_ms, ok, reply_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      str(body.event) ?? "unknown",
      str(body.guildId),
      str(body.channelId),
      str(body.messageId),
      str(body.requesterUserId),
      str(body.provider),
      str(body.model),
      typeof body.latencyMs === "number" ? Math.round(body.latencyMs) : null,
      body.ok === false ? 0 : 1,
      str(body.replyText) ? truncate(str(body.replyText) as string, 4_000) : null,
    )
    .run();
  return json({ ok: true, id });
}

async function handleInternalFeedback(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();
  if (!(await verifyInternalRequest(request, rawBody, env.INTERNAL_SHARED_SECRET))) {
    return json({ error: "invalid_internal_signature" }, 401);
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const kind = body.kind === "reaction" || body.kind === "command" ? body.kind : "reply";
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO feedback_logs (id, kind, guild_id, channel_id, message_id, in_reply_to_message_id, user_id, content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      kind,
      str(body.guildId),
      str(body.channelId),
      str(body.messageId),
      str(body.inReplyToMessageId),
      str(body.userId),
      str(body.content) ? truncate(str(body.content) as string, 2_000) : null,
    )
    .run();
  return json({ ok: true, id });
}


// ---------------------------------------------------------------------------
// MCP clients (CaseFlow, DecisionGarden) — JSON-RPC over HTTPS with a bearer.
// ---------------------------------------------------------------------------

async function mcpCall(
  url: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": "su-discord-bot",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  let text = await response.text();
  if (text.includes("data:")) {
    text = text.split("\n").filter((l) => l.startsWith("data:")).pop()?.slice(5) ?? "";
  }
  if (!response.ok) {
    throw new Error(`MCP ${name} -> ${response.status}: ${text.slice(0, 200)}`);
  }
  const envelope = JSON.parse(text) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
    error?: { message?: string };
  };
  if (envelope.error) {
    throw new Error(`MCP ${name}: ${envelope.error.message ?? "error"}`);
  }
  const payload = envelope.result?.content?.[0]?.text ?? "";
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return payload;
  }
}

function caseflow(env: Env): { url: string; token: string } | null {
  if (!env.CASEFLOW_MCP_TOKEN) {
    return null;
  }
  return {
    url: env.CASEFLOW_MCP_URL || "https://caseflow.nex-a.net/api/mcp?tenantId=nexa",
    token: env.CASEFLOW_MCP_TOKEN,
  };
}

function decisiongarden(env: Env): { url: string; token: string; gardenId: string } | null {
  if (!env.DECISIONGARDEN_MCP_TOKEN || !env.DECISIONGARDEN_GARDEN_ID) {
    return null;
  }
  return {
    url: env.DECISIONGARDEN_MCP_URL || "https://decisiongarden.nex-a.net/api/mcp",
    token: env.DECISIONGARDEN_MCP_TOKEN,
    gardenId: env.DECISIONGARDEN_GARDEN_ID,
  };
}

// ---------------------------------------------------------------------------
// /feedback, /inquiry, /inquiry-status
// ---------------------------------------------------------------------------

async function handleFeedbackCommand(
  interaction: DiscordInteraction,
  env: Env,
): Promise<Response> {
  const message = getStringOption(interaction, "message");
  const userId = interaction.member?.user?.id ?? interaction.user?.id ?? null;
  if (!message || message.trim().length === 0) {
    return interactionMessage("`message` が必要です。", true);
  }
  await env.DB.prepare(
    `INSERT INTO feedback_logs (id, kind, guild_id, channel_id, message_id, in_reply_to_message_id, user_id, content)
     VALUES (?, 'command', ?, NULL, ?, NULL, ?, ?)`,
  )
    .bind(crypto.randomUUID(), interaction.guild_id ?? null, interaction.id, userId, truncate(message, 2_000))
    .run();
  return interactionMessage(
    "ありがとうございます。レジの下のノートに書きました。……次の夜勤までに、少し直せるように考えます。",
    true,
  );
}

async function handleInquiryCommand(
  interaction: DiscordInteraction,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const message = getStringOption(interaction, "message");
  if (!message || message.trim().length < 10) {
    return interactionMessage("お問い合わせは10文字以上でお願いします。", true);
  }
  const cf = caseflow(env);
  if (!cf) {
    return interactionMessage(
      "すみません、今は店長への取り次ぎ（CaseFlow）がつながっていません。店長室に直接お願いします。",
      true,
    );
  }
  context.waitUntil(fileInquiry(interaction, env, cf, message));
  return deferInteraction(true);
}

async function fileInquiry(
  interaction: DiscordInteraction,
  env: Env,
  cf: { url: string; token: string },
  message: string,
): Promise<void> {
  const userId = interaction.member?.user?.id ?? interaction.user?.id ?? "unknown";
  let text: string;
  try {
    const result = (await mcpCall(cf.url, cf.token, "create_case", {
      projectId: env.CASEFLOW_PROJECT_ID || undefined,
      source: "discord:su",
      title: truncate(message.replace(/\s+/g, " "), 60),
      detail: message,
      reporterName: `discord:${userId}`,
      reporterUserId: `discord:${userId}`,
      locale: "ja",
      metadata: {
        channel: "su-discord",
        guildId: interaction.guild_id ?? null,
        interactionId: interaction.id,
      },
    })) as { caseNumber?: string; caseId?: string; case?: { caseNumber?: string; caseId?: string } };
    const caseNumber = result.caseNumber ?? result.case?.caseNumber;
    const caseId = result.caseId ?? result.case?.caseId;
    if (!caseNumber) {
      throw new Error("create_case returned no caseNumber");
    }
    text = [
      `店長に渡しました。受付番号は **${caseNumber}** です。`,
      `状況は \`/inquiry-status ${caseNumber}\` で確認できます。`,
      "返事があったら、この店（サーバー）でお知らせします。",
    ].join("\n");
    if (env.OPS_CHANNEL_ID) {
      await notifyOps(
        env,
        [
          `📮 **お問い合わせを受け付けました** — ${caseNumber}`,
          `from <@${userId}>`,
          `CaseFlow: https://caseflow.nex-a.net/ja/cases/${caseId ?? ""}`,
          `> ${truncate(message.replace(/\s+/g, " "), 200)}`,
        ].join("\n"),
      );
    }
  } catch (error) {
    console.error("inquiry failed", error);
    await recordIncident(env, {
      kind: "inquiry_failed",
      severity: "error",
      source: "worker",
      summary: "お問い合わせの CaseFlow 起票に失敗",
      detail: String(error),
    });
    text = "すみません、店長への取り次ぎに失敗しました。内容は外に出していません。少し時間を置いて、もう一度お願いします。";
  }
  await sendFollowUp(interaction, truncate(text, 1_900), true);
}

async function handleInquiryStatusCommand(
  interaction: DiscordInteraction,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const caseNumber = getStringOption(interaction, "case_number")?.trim().toUpperCase();
  if (!caseNumber || !/^CF-\d{8}-[A-Z0-9]{4,8}$/.test(caseNumber)) {
    return interactionMessage("受付番号は `CF-20260906-78X0` の形でお願いします。", true);
  }
  const cf = caseflow(env);
  if (!cf) {
    return interactionMessage("すみません、今は CaseFlow がつながっていません。", true);
  }
  const requesterId = interaction.member?.user?.id ?? interaction.user?.id ?? "unknown";
  context.waitUntil(
    (async () => {
      let text: string;
      try {
        const result = (await mcpCall(cf.url, cf.token, "get_case", { caseNumber })) as {
          case?: { status?: string; updatedAt?: string; reporterUserId?: string; title?: string; comments?: unknown[] };
          status?: string;
          updatedAt?: string;
          reporterUserId?: string;
          title?: string;
          comments?: unknown[];
        };
        const c = result.case ?? result;
        // Only the reporter (or operators via 店長室) may read status details.
        if (c.reporterUserId && c.reporterUserId !== `discord:${requesterId}`) {
          text = `受付番号 ${caseNumber} は、別のお客さんの分です。ご本人だけ確認できます。`;
        } else {
          const comments = Array.isArray(c.comments) ? c.comments.length : 0;
          text = [
            `**${caseNumber}** — 状況: ${c.status ?? "不明"}`,
            c.updatedAt ? `最終更新: ${c.updatedAt}` : null,
            `店長からの返信: ${comments} 件`,
          ]
            .filter(Boolean)
            .join("\n");
        }
      } catch (error) {
        console.error("inquiry status failed", error);
        text = "すみません、今は状況を確認できませんでした。少し時間を置いて、もう一度お願いします。";
      }
      await sendFollowUp(interaction, truncate(text, 1_900), true);
    })(),
  );
  return deferInteraction(true);
}

// ---------------------------------------------------------------------------
// Improvement loop: daily digest of feedback -> DecisionGarden seed + issue
// ---------------------------------------------------------------------------

interface DigestFinding {
  theme: string;
  evidence: string[];
  severity: "low" | "medium" | "high";
  proposal: string;
}

async function runImprovementDigest(env: Env, hours = 24): Promise<void> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1_000).toISOString().replace("T", " ").slice(0, 19);
  const feedback = await env.DB.prepare(
    `SELECT kind, content, created_at FROM feedback_logs WHERE created_at >= ? ORDER BY created_at ASC LIMIT 200`,
  )
    .bind(since)
    .all<{ kind: string; content: string | null; created_at: string }>();
  const replies = await env.DB.prepare(
    `SELECT event, ok, latency_ms, provider FROM reply_logs WHERE created_at >= ?`,
  )
    .bind(since)
    .all<{ event: string; ok: number; latency_ms: number | null; provider: string | null }>();
  const incidents = await env.DB.prepare(
    `SELECT kind, count, summary FROM su_incidents WHERE last_seen_at >= ? AND status = 'open'`,
  )
    .bind(since)
    .all<{ kind: string; count: number; summary: string }>();

  const textual = feedback.results.filter((f) => f.kind !== "reaction" && f.content && f.content.trim().length > 0);
  const reactions = feedback.results.filter((f) => f.kind === "reaction");
  const total = replies.results.length;
  const failed = replies.results.filter((r) => r.ok === 0).length;
  const avgLatency = total
    ? Math.round(replies.results.reduce((a, r) => a + (r.latency_ms ?? 0), 0) / total)
    : 0;

  if (textual.length === 0 && incidents.results.length === 0) {
    console.log("digest: nothing to analyse");
    return;
  }

  let findings: DigestFinding[] = [];
  if (env.AI && textual.length > 0) {
    const prompt = [
      "あなたはDiscord Bot「スー」の改善担当です。以下は直近のユーザーからの返信・感想（スー宛のもの）です。",
      "この中から「返答がおかしい」「違和感がある」「こうしてほしい」という不満・要望・繰り返される指摘を抽出し、JSON配列で返してください。",
      '各要素: {"theme": 一言, "evidence": [根拠となる発言の短い引用（最大3件）], "severity": "low"|"medium"|"high", "proposal": 具体的な改善案（プロンプト/実装のどこを直すか）}',
      "不満や要望が無ければ [] を返してください。JSON以外は出力しないこと。",
      "",
      ...textual.map((f) => `- [${f.kind} ${f.created_at}] ${f.content?.replace(/\s+/g, " ").slice(0, 300)}`),
    ].join("\n");
    try {
      const result = (await env.AI.run(
        (env.AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast") as Parameters<Ai["run"]>[0],
        {
          messages: [
            { role: "system", content: "You extract user complaints and turn them into concrete improvement proposals. Output JSON only." },
            { role: "user", content: prompt },
          ],
          max_tokens: 1_200,
          temperature: 0.2,
        } as never,
      )) as { response?: string; choices?: Array<{ message?: { content?: string } }> };
      const raw = (result.response ?? result.choices?.[0]?.message?.content ?? "").trim();
      const jsonText = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
      const parsed = JSON.parse(jsonText) as unknown;
      if (Array.isArray(parsed)) {
        findings = parsed
          .filter((f): f is DigestFinding => typeof f === "object" && f !== null && typeof (f as DigestFinding).theme === "string")
          .slice(0, 8);
      }
    } catch (error) {
      console.error("digest analysis failed", error);
    }
  }

  const dateJst = new Date(Date.now() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  const statsLine = `返答 ${total} 件（失敗 ${failed}、平均 ${avgLatency}ms）、感想・返信 ${textual.length} 件、リアクション ${reactions.length} 件、未解決 incident ${incidents.results.length} 種`;

  // DecisionGarden: one memory node per day (idempotent via sourceKey), one seed per high finding.
  const dg = decisiongarden(env);
  if (dg) {
    try {
      await mcpCall(dg.url, dg.token, "save_memory_node", {
        gardenId: dg.gardenId,
        sourceKey: `su-digest:${dateJst}`,
        source: "ai-driven-development-discord-bot/worker improvement digest",
        kind: "knowledge",
        state: "active",
        visibility: "garden",
        title: `スー 日次ダイジェスト ${dateJst}`,
        body: [
          statsLine,
          "",
          ...(findings.length
            ? findings.map((f) => `- [${f.severity}] ${f.theme}: ${f.proposal}`)
            : ["不満・要望の抽出なし"]),
          ...(incidents.results.length
            ? ["", "incident:", ...incidents.results.map((i) => `- ${i.kind} x${i.count}: ${i.summary}`)]
            : []),
        ].join("\n"),
      });
      for (const f of findings.filter((x) => x.severity === "high")) {
        await mcpCall(dg.url, dg.token, "save_decision_seed", {
          gardenId: dg.gardenId,
          projectKey: "ai-driven-development-discord-bot",
          decisionQuestion: `スーの改善: ${f.theme}`,
          customerProblem: f.evidence.join(" / "),
          hypothesis: f.proposal,
          evidence: f.evidence.slice(0, 3).map((e) => ({ checkedAt: dateJst, source: "discord feedback_logs", fact: e })),
          nextStep: "persona.ts か実装を直す PR を出し、次の1週間の feedback で再評価する",
          status: "open",
        });
      }
    } catch (error) {
      console.error("digest -> decisiongarden failed", error);
    }
  }

  // GitHub: one improvement issue per high finding (Repo Deck picks it up).
  if (env.GITHUB_TOKEN) {
    for (const f of findings.filter((x) => x.severity === "high")) {
      await openImprovementIssue(env, f, dateJst);
    }
  }

  // Ops: short summary so humans see the loop turning.
  if (env.OPS_CHANNEL_ID) {
    await notifyOps(
      env,
      [
        `📝 **今日のレジ裏ノート（${dateJst}）**`,
        statsLine,
        ...(findings.length ? findings.map((f) => `- [${f.severity}] ${f.theme} → ${f.proposal}`) : ["- 不満・要望の抽出なし"]),
      ].join("\n"),
    );
  }
}

async function openImprovementIssue(env: Env, f: DigestFinding, dateJst: string): Promise<void> {
  const repo = env.GITHUB_REPO || "NexA-LLC/ai-driven-development-discord-bot";
  const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN ?? ""}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "su-discord-bot-improvement-loop",
    },
    body: JSON.stringify({
      title: `[improve] ${f.theme}`.slice(0, 200),
      labels: ["improvement", "su"],
      body: [
        `ユーザーの返信・感想から抽出した改善点です（${dateJst}、severity: ${f.severity}）。`,
        "",
        "## 根拠（ユーザーの発言）",
        ...f.evidence.map((e) => `- ${e}`),
        "",
        "## 提案",
        f.proposal,
        "",
        "## 期待する作業",
        "1. `src/shared/persona.ts`（口調・場面）か実装のどこを直すか決める",
        "2. PR を出す（main は PR 必須）",
        "3. 次の1週間の feedback_logs で再評価する",
        "",
        "_opened automatically by the Worker improvement loop_",
      ].join("\n"),
    }),
  });
  if (!response.ok) {
    console.error("improvement issue failed", response.status, (await response.text()).slice(0, 200));
  }
}

/**
 * Update the bot's own presentation (avatar, application icon, guild nickname)
 * using the bot token that lives in Worker secrets, so no token is needed on
 * a developer machine.
 */
async function handleInternalProfile(
  request: Request,
  env: Env,
): Promise<Response> {
  const rawBody = await request.text();
  if (
    !(await verifyInternalRequest(
      request,
      rawBody,
      env.INTERNAL_SHARED_SECRET,
    ))
  ) {
    return json({ error: "invalid_internal_signature" }, 401);
  }

  let body: {
    avatarDataUrl?: unknown;
    iconDataUrl?: unknown;
    nick?: unknown;
    guildId?: unknown;
    description?: unknown;
  };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const isDataUrl = (value: unknown): value is string =>
    typeof value === "string" &&
    /^data:image\/(png|jpeg|gif|webp);base64,/.test(value);
  const headers = {
    authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
    "content-type": "application/json",
  };
  const results: Record<string, { status: number; detail?: string }> = {};

  if (isDataUrl(body.avatarDataUrl)) {
    const response = await fetch("https://discord.com/api/v10/users/@me", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ avatar: body.avatarDataUrl }),
    });
    results.avatar = {
      status: response.status,
      ...(response.ok ? {} : { detail: (await response.text()).slice(0, 300) }),
    };
  }

  const appPatch: Record<string, string> = {};
  if (isDataUrl(body.iconDataUrl)) {
    appPatch.icon = body.iconDataUrl;
  }
  if (body.description === true) {
    appPatch.description = APP_DESCRIPTION;
  } else if (typeof body.description === "string") {
    appPatch.description = body.description.slice(0, 400);
  }
  if (Object.keys(appPatch).length > 0) {
    const response = await fetch(
      "https://discord.com/api/v10/applications/@me",
      {
        method: "PATCH",
        headers,
        body: JSON.stringify(appPatch),
      },
    );
    results.application = {
      status: response.status,
      ...(response.ok ? {} : { detail: (await response.text()).slice(0, 300) }),
    };
  }

  if (
    typeof body.nick === "string" &&
    typeof body.guildId === "string" &&
    /^\d{10,25}$/.test(body.guildId)
  ) {
    const response = await fetch(
      `https://discord.com/api/v10/guilds/${body.guildId}/members/@me`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ nick: body.nick.slice(0, 32) }),
      },
    );
    results.nick = {
      status: response.status,
      ...(response.ok ? {} : { detail: (await response.text()).slice(0, 300) }),
    };
  }

  return json({ ok: true, results });
}

async function handleInternalAiTest(
  request: Request,
  env: Env,
): Promise<Response> {
  const rawBody = await request.text();
  if (
    !(await verifyInternalRequest(
      request,
      rawBody,
      env.INTERNAL_SHARED_SECRET,
    ))
  ) {
    return json({ error: "invalid_internal_signature" }, 401);
  }

  let body: { mode?: unknown; input?: unknown };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (typeof body.input !== "string" || body.input.trim().length === 0) {
    return json({ error: "input_is_required" }, 400);
  }

  const mode: AskMode = body.mode === "pitch" ? "pitch" : "ask";
  const startedAt = Date.now();
  try {
    const text = await callAi(env, mode, body.input);
    return json({
      provider: (env.AI_PROVIDER ?? "gateway").trim().toLowerCase(),
      model: env.AI_MODEL || null,
      durationMs: Date.now() - startedAt,
      text,
    });
  } catch (error) {
    return json(
      {
        error: "ai_failed",
        detail: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      },
      502,
    );
  }
}

async function handleInternalJobsClaim(
  request: Request,
  env: Env,
): Promise<Response> {
  const rawBody = await request.text();
  if (
    !(await verifyInternalRequest(
      request,
      rawBody,
      env.INTERNAL_SHARED_SECRET,
    ))
  ) {
    return json({ error: "invalid_internal_signature" }, 401);
  }

  const now = new Date().toISOString();

  // Expire stale orders first so their prompt text does not linger.
  await env.DB.prepare(
    `UPDATE ai_jobs
        SET status = 'expired', input = NULL, completed_at = ?
      WHERE status IN ('pending', 'claimed') AND expires_at < ?`,
  )
    .bind(now, now)
    .run();

  const pending = await env.DB.prepare(
    `SELECT id, mode, input, language, application_id, interaction_token,
            ephemeral, guild_id, requester_user_id
       FROM ai_jobs
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?`,
  )
    .bind(JOB_CLAIM_LIMIT)
    .all<AiJobRow>();

  const claimed: AiJobRow[] = [];
  for (const job of pending.results) {
    const result = await env.DB.prepare(
      `UPDATE ai_jobs SET status = 'claimed', claimed_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
      .bind(now, job.id)
      .run();
    if ((result.meta.changes ?? 0) > 0) {
      claimed.push(job);
    }
  }

  return json({ jobs: claimed });
}

async function handleInternalJobsComplete(
  request: Request,
  env: Env,
): Promise<Response> {
  const rawBody = await request.text();
  if (
    !(await verifyInternalRequest(
      request,
      rawBody,
      env.INTERNAL_SHARED_SECRET,
    ))
  ) {
    return json({ error: "invalid_internal_signature" }, 401);
  }

  let body: {
    id?: unknown;
    ok?: unknown;
    answered?: unknown;
    error?: unknown;
  };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (typeof body.id !== "string") {
    return json({ error: "id_is_required" }, 400);
  }

  let succeeded = body.ok !== false;
  let errorText = succeeded ? null : truncate(String(body.error ?? "unknown"), 500);
  let fallback: "workers-ai" | "apology" | null = null;

  // The Gateway could not answer (LLM host down, etc.). Answer from here with
  // Workers AI so the customer still hears back, or at least apologise.
  if (!succeeded && body.answered === false) {
    const job = await env.DB.prepare(
      `SELECT id, mode, input, language, application_id, interaction_token,
              ephemeral, guild_id, requester_user_id
         FROM ai_jobs WHERE id = ? AND status = 'claimed'`,
    )
      .bind(body.id)
      .first<AiJobRow>();

    if (job) {
      const interaction: DiscordInteraction = {
        id: job.id,
        application_id: job.application_id,
        type: InteractionType.APPLICATION_COMMAND,
        token: job.interaction_token,
      };
      let text: string | null = null;
      if (env.AI && job.input) {
        try {
          text = await callAi(env, job.mode, job.input, "workers-ai");
          fallback = "workers-ai";
          succeeded = true;
          errorText = truncate(`gateway: ${String(body.error ?? "unknown")}; answered by workers-ai`, 500);
        } catch (error) {
          console.error("workers-ai fallback failed", error);
        }
        await recordIncident(env, {
          kind: "gateway_unanswered",
          severity: fallback ? "warning" : "error",
          source: "worker",
          summary: fallback
            ? "Gateway が答えられず、Workers AI で代替回答しました"
            : "Gateway も Workers AI も答えられませんでした",
          detail: String(body.error ?? "unknown"),
          dedupeKey: `worker:gateway_unanswered`,
        });
      }
      if (!text) {
        text =
          "すみません、今、答えが作れませんでした。内容は外に出していません。少し時間を置いて、もう一度お願いします。";
        fallback = "apology";
      }
      try {
        await sendFollowUp(interaction, truncate(text, 1_900), job.ephemeral === 1);
      } catch (error) {
        console.error("fallback follow-up failed", error);
      }
    }
  }

  await env.DB.prepare(
    `UPDATE ai_jobs
        SET status = ?, input = NULL, completed_at = ?, error = ?
      WHERE id = ? AND status = 'claimed'`,
  )
    .bind(
      succeeded ? "done" : "failed",
      new Date().toISOString(),
      errorText,
      body.id,
    )
    .run();

  return json({ ok: true, fallback });
}

async function verifyInternalRequest(
  request: Request,
  body: string,
  secret: string,
): Promise<boolean> {
  if (!secret) {
    return false;
  }

  const timestamp = request.headers.get("x-nexa-timestamp");
  const receivedSignature = request.headers.get("x-nexa-signature");

  if (!timestamp || !receivedSignature) {
    return false;
  }

  const timestampNumber = Number(timestamp);
  if (
    !Number.isFinite(timestampNumber) ||
    Math.abs(Date.now() / 1_000 - timestampNumber) > 300
  ) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${body}`),
  );
  const expectedSignature = toHex(new Uint8Array(signatureBuffer));

  return constantTimeEqual(expectedSignature, receivedSignature);
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

// Keep the type imported and checked at compile time without exporting internals.
void (null as AgentPassport | null);
