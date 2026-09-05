import { verifyKey } from "discord-interactions";
import {
  evaluateAgentManifest,
  type AgentPassport,
} from "../shared/agent-manifest.js";

interface Env {
  DB: D1Database;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  INTERNAL_SHARED_SECRET: string;
  AI_API_URL?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
  PITCHEEE_URL?: string;
  COMMUNITY_NAME?: string;
}

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

    return json({ error: "not_found" }, 404);
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

      context.waitUntil(
        generateAndFollowUp(interaction, env, "ask", prompt, !isPublic),
      );
      return deferInteraction(!isPublic);
    }

    case "pitch": {
      const idea = getStringOption(interaction, "idea");
      const isPublic = getBooleanOption(interaction, "public") ?? false;

      if (!idea) {
        return interactionMessage("`idea` が必要です。", true);
      }

      context.waitUntil(
        generateAndFollowUp(interaction, env, "pitch", idea, !isPublic),
      );
      return deferInteraction(!isPublic);
    }

    case "agents":
      return handleAgentsCommand(interaction, env);

    case "agent-submit":
      return handleAgentSubmitCommand(interaction, env);

    case "about": {
      const community = env.COMMUNITY_NAME || "AI Driven Development";
      return interactionMessage(
        [
          `**${community} Community AI**`,
          "質問、設計、15秒ピッチ、外部Agent申請を扱います。",
          "会話本文はデフォルトでは保存せず、外部公開やサービス連携は明示操作後だけ行います。",
          "基盤の実装・運用支援: NexA",
        ].join("\n"),
        true,
      );
    }

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

  let body: { prompt?: unknown };
  try {
    body = JSON.parse(rawBody) as { prompt?: unknown };
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

  const text = await callAi(env, "ask", body.prompt);
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
): Promise<string> {
  if (!env.AI_API_URL || !env.AI_API_KEY || !env.AI_MODEL) {
    return fallbackResponse(mode, input, env.PITCHEEE_URL);
  }

  const pitcheeeInstruction = env.PITCHEEE_URL
    ? `Pitcheee is an optional publication route at ${env.PITCHEEE_URL}. Mention it only when the user explicitly wants to publish, show a project, or recruit collaborators.`
    : "No external publication route is configured.";

  const systemPrompt =
    mode === "pitch"
      ? [
          "You create a concise Japanese 15-second pitch.",
          "Return: title, one short pitch, and one concrete next action.",
          "Do not claim that anything was published.",
          pitcheeeInstruction,
        ].join(" ")
      : [
          "You are the neutral AI member of an AI Driven Development community.",
          "Answer the request directly, produce something usable, and end with at most three concrete next actions.",
          "Do not advertise NexA. Do not claim external execution unless it actually happened.",
          "Be honest about constraints and permissions.",
          pitcheeeInstruction,
        ].join(" ");

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
      temperature: 0.3,
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

  return text.trim();
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
