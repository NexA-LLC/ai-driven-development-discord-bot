#!/usr/bin/env node
// Forwards スー's incidents from the Worker (D1) to Nexa Chat's loopback
// channel gateway on 205. Runs as a launchd job next to nexa-chat itself.
// Env: WORKER_INTERNAL_URL, INTERNAL_SHARED_SECRET (from the bot .env),
//      NEXA_CHAT_CHANNEL_GATEWAY_TOKEN (from nexa-chat/.secrets/gateway.env),
//      NEXA_CHAT_URL (default http://127.0.0.1:8094), RELAY_POLL_SECONDS (60).
import { createHmac } from "node:crypto";

const workerUrl = required("WORKER_INTERNAL_URL");
const secret = required("INTERNAL_SHARED_SECRET");
const chatUrl = (process.env.NEXA_CHAT_URL || "http://127.0.0.1:8094").replace(/\/$/, "");
const chatToken = process.env.NEXA_CHAT_CHANNEL_GATEWAY_TOKEN || process.env.NEXA_CHAT_GATEWAY_TOKEN || "";
const pollMs = Number(process.env.RELAY_POLL_SECONDS || 60) * 1000;
const once = process.argv.includes("--once");

if (!chatToken) {
  console.warn("[su-relay] NEXA_CHAT_CHANNEL_GATEWAY_TOKEN is empty; relay is dormant (nothing is sent)");
}

async function signed(path, payload) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  const response = await fetch(new URL(path, workerUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "x-nexa-timestamp": timestamp, "x-nexa-signature": signature },
    body,
  });
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

function toChatEvent(incident) {
  const when = incident.last_seen_at.includes("T") ? incident.last_seen_at : `${incident.last_seen_at.replace(" ", "T")}Z`;
  const dedupeKey = `su-incident:${incident.dedupe_key}:${incident.count}`;
  const badge = { info: "ℹ️", warning: "⚠️", error: "🔴", critical: "🚨" }[incident.severity] || "⚠️";
  const lines = [
    `${badge} スー incident: ${incident.summary}`,
    `kind=${incident.kind} severity=${incident.severity} source=${incident.source} count=${incident.count}`,
    `first=${incident.first_seen_at} last=${incident.last_seen_at}`,
  ];
  if (incident.detail) lines.push("", String(incident.detail).slice(0, 800));
  if (incident.issue_url) lines.push("", `Issue: ${incident.issue_url}`);
  return {
    schemaVersion: 1,
    connectorAccount: { connector: "nexa_agent", accountId: "su-incidents", displayName: "スー incidents" },
    conversation: { externalId: "su-incidents", externalIdConfidence: "derived", title: "スー incidents", type: "channel" },
    kind: "message_created",
    revision: 1,
    message: {
      externalId: dedupeKey,
      externalIdConfidence: "content_hash",
      direction: "incoming",
      sender: { displayName: incident.source, identityConfidence: "strong" },
      sentAt: when,
      text: lines.join("\n"),
      attachments: [],
    },
    sourceLocator: {
      origin: "ai-driven-development-discord-bot/ops/relay/su-incident-relay.mjs",
      url: incident.issue_url || `${workerUrl.replace(/\/$/, "")}/health`,
      selectorEvidence: [],
      observedAt: new Date().toISOString(),
    },
    dedupeKey,
    capabilities: { receive: true, send: "none", readReceipts: false, history: false, backfill: false, revisions: false, deletions: false },
  };
}

async function postToChat(event) {
  const response = await fetch(`${chatUrl}/api/channel-gateway/events`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${chatToken}` },
    body: JSON.stringify(event),
  });
  if (!response.ok) throw new Error(`nexa-chat -> ${response.status}: ${(await response.text()).slice(0, 200)}`);
}

async function tick() {
  const { incidents } = await signed("/internal/incidents/pending", {});
  if (!incidents.length) return;
  const acked = [];
  for (const incident of incidents) {
    try {
      if (chatToken) await postToChat(toChatEvent(incident));
      acked.push(incident.id);
      console.log(`[su-relay] relayed ${incident.kind} x${incident.count} (${incident.id})`);
    } catch (error) {
      console.error(`[su-relay] failed ${incident.id}:`, error.message);
    }
  }
  if (acked.length) await signed("/internal/incidents/ack", { ids: acked });
}

for (;;) {
  try {
    await tick();
  } catch (error) {
    console.error("[su-relay] tick failed:", error.message);
  }
  if (once) break;
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
