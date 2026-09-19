# スー incident relay (205)

`su-incident-relay.mjs` polls the Worker for un-relayed incidents and posts them to
Nexa Chat's loopback channel gateway (`POST /api/channel-gateway/events`) as
receive-only `nexa_agent` events, then acks them. It runs on the same Mac as
nexa-chat (205) because that gateway is loopback-only.

Env file (mode 600, outside the repo):

```
WORKER_INTERNAL_URL=https://<worker>.workers.dev
INTERNAL_SHARED_SECRET=<same as the bot .env>
NEXA_CHAT_CHANNEL_GATEWAY_TOKEN=<from nexa-chat/.secrets/gateway.env>
```

launchd: mirror `com.nexa.nexa-chat.plist` (single `.command` in ProgramArguments,
`ProcessType Interactive`, logs under the repo). `--once` runs a single tick.

Incident sources:

- Gateway: `llm_unreachable`, `mention_unanswered`, `followup_failed`, `welcome_failed`,
  `musing_failed`, `discord_disconnected`, `discord_client_error`, `llm_not_configured`
- Worker: `gateway_unanswered` (Workers AI fallback fired)

Repeats of one `dedupeKey` within 60 minutes fold into one row. The Worker posts to
the operator channel (`OPS_CHANNEL_ID`) on the 1st/3rd/10th/50th occurrence and opens a
GitHub issue labeled `incident` at the 3rd when `GITHUB_TOKEN` is set (Repo Deck picks
those up).
