# Architecture

## Product boundary

The repository is intentionally not a generic chat-log collector and not a NexA advertising bot.

It is a community runtime with three surfaces:

1. **Community AI** — explicit questions, idea shaping, and pitch generation.
2. **Agent Dock** — a controlled way to connect third-party agents without giving them a Discord bot token.
3. **Bot Warden** — metadata-only monitoring for bot floods and bot-to-bot loops.

## Why split HTTP interactions and Gateway events

```text
Discord Interaction
  -> HTTPS /interactions
  -> Cloudflare Worker
  -> optional LLM
  -> Discord interaction webhook

Discord Gateway
  <-> persistent WebSocket
  <-> Node Gateway process
  -> HMAC-signed internal Worker API
```

Cloudflare Worker is a good fit for the public HTTPS endpoint, signature validation, D1, and bursty command execution. The Node Gateway process exists because guild message events are delivered over Discord's persistent Gateway WebSocket.

The Gateway process opens an outbound connection to Discord. It does not require Cloudflare to relay that WebSocket and normally does not require an inbound port.

## Install modes

### User Install

Used for `/ask`, `/pitch`, and `/about`.

- The user installs the application to their account.
- The app responds only to an explicit Interaction.
- It cannot be the server-wide passive observer.
- `public=false` is the default to reduce channel noise.

### Guild Install

Used for:

- bot mentions in allowlisted channels;
- passive observation only when explicitly enabled;
- external bot rate monitoring;
- moderator alerts.

The initial permission target is:

- View Channel on selected channels;
- Send Messages;
- Read Message History only where required;
- Use Application Commands.

The initial runtime does not require Administrator, Manage Guild, Manage Roles, Ban Members, or Kick Members.

### Agent Dock

A third-party developer publishes an `agent-manifest.json` and an HTTPS endpoint.

The registry validates:

- declared triggers and actions;
- Discord permissions;
- privileged intents;
- message-content storage;
- retention;
- external model providers;
- training use;
- deletion URL;
- rate and context limits.

The initial code registers and scores manifests. Production event dispatch is deliberately deferred until per-agent credentials, output filtering, timeout, retry, and revocation are implemented.

## Storage

D1 stores:

- guild policies;
- agent submissions and Passport results;
- installation state;
- audit metadata;
- incidents.

D1 does **not** initially store raw Discord messages.

Message content used for `/ask` or a direct mention is transient input to the configured LLM endpoint. A later decision to persist content must be implemented as a new migration and must include retention and deletion behavior.

## HMAC boundary

The Node Gateway signs internal requests:

```text
signature = HMAC_SHA256(secret, unix_timestamp + "." + raw_json_body)
```

The Worker rejects:

- missing signatures;
- signatures that do not match;
- timestamps more than five minutes away.

This protects the internal routes from unauthenticated public callers. It does not replace TLS, secret rotation, or per-agent credentials.

## Suggested rollout

### Phase 0 — local

- Worker local D1;
- `/ask` fallback response;
- command registration in a test Guild;
- Gateway mention response;
- Warden alert channel.

### Phase 1 — community beta

- one allowlisted public channel;
- no passive observe;
- no raw message storage;
- `/agent-submit`;
- human approval in D1/admin tooling;
- one Agent Dock reference implementation.

### Phase 2 — opt-in threads

- thread-level consent;
- scoped context;
- per-agent HMAC keys;
- output scanning;
- timeouts and circuit breakers;
- operator Quarantine button.

### Phase 3 — NexA capabilities

Only after explicit user intent:

- convert discussion to a FlowAlign action;
- request RepoDeck implementation;
- turn a project into a Pitcheee pitch;
- hand a qualified implementation request to a human.

The UI should show user goals such as “整理する / 作る / 紹介する”, not a wall of NexA product names.
