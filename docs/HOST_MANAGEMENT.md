# Host-managed Gateway

Placement: `dev205` (`ant`). Fixed label:
`net.nex-a.ai-driven-development-discord-gateway`.

NexA Registry `registry/host-runtimes/dev205.json` is the service inventory.
The Gateway is registered **disabled**, with its missing prerequisites recorded.
NexA Host now supervises this inventory; disabled is not a claim of deployment.

The fixed entrypoint is `scripts/run-host-gateway.mjs`. It loads only the owner's
0600 `~/Library/Application Support/AI Development Discord/gateway.env`, rejects
symlinks and missing credentials, and imports the product bundle from
`runtime/current/dist/gateway/index.js`. launchd receives only the Node path and
this launcher path. It receives no credential values or arbitrary commands.

Required existing inputs: Discord Application ID, test Guild ID, Bot token,
deployed HTTPS Worker URL and matching internal shared secret. The launcher
`--check` validates local prerequisites without logging in or sending a message.
It never claims configuration means Discord readiness. Deployment also needs
the product dependencies beside the bundle (`--packages=external`).

Enable the Registry entry only after Worker health, the selected test Guild,
credential provisioning and one authorized Discord readiness/response check.
There is no automatic public command registration or external message on install.
The Host supervisor must not bootstrap this disabled target while prerequisites
are missing. The Cloudflare Worker remains Cloudflare-owned; Host owns only the
machine-local Gateway lifecycle.

## dev202 managed rollout (2026-09-08)

The live スー runtime is on `10.1.0.202`, user `buildman`. The legacy dev205
entry above is disabled and does not describe this live placement.

`scripts/supervise-gateway.py` checks `origin/main` every 60 seconds and stages
an immutable Git archive under `~/service-runners/su-managed/releases/<sha>`.
It runs `npm ci`, typecheck and gateway build before touching the old process.
Only descendant commits activate. SIGUSR2 stops queue claims and scheduled work;
complete claimed batches, Discord delivery and acknowledgements remain tracked.
There is no forced drain timeout. A stuck operation defers deployment.
After exit, the candidate must report its own PID/SHA, Discord readiness and
inbox recovery within 120 seconds, otherwise the supervisor drains it and starts
the previous release. A failed SHA is not retried until supervisor restart.

Cloudflare continues accepting HTTP `/ask`, `/pitch` and MCP commands into its
existing D1 queues during restart. This does not extend Discord interaction-token
expiry. Received human messages are stored as IDs (no message content) in a
0600 local inbox; monitored channels and the musings channel are backfilled
from Discord history after downtime. Read Message History permission is required.
Direct mentions outside those channels, reactions and member-join events during
disconnection are not backfilled. Normal restarts finish active work; an abrupt
crash between Discord delivery and local acknowledgement can cause duplicate
replay. This is not an exactly-once or crash-recovery guarantee for claimed D1 jobs.

State lives outside releases at `~/service-runners/su-managed/state`. Scheduled
musing/digest slots and successful quiz posts persist across restart to suppress
same-slot repeats. Musing/digest completion slots now advance only after success;
failures remain retryable. Event sends have a separate durable pending/unknown
reservation to prevent resending an uncertain delivery. See EXPERIENCE_AND_EVENTS.md.

The launchd label is `net.nex-a.su.gateway-managed`. Its SSH loopback entrypoint
preserves the host's local-network permission workaround. A dedicated SSH identity
is restricted to localhost and a fixed supervisor command; shell and forwarding
are disabled, and authentication is preflighted before stopping the old process. The supervisor
is a service-specific updater; NexA Host fleet inventory integration is separate.
Use loopback `/readiness` on the configured `READINESS_PORT` (202: 8791) to inspect `activeWork`, `draining`,
`startupReady`, `queuedMessages`, `deadLetterMessages`, `llm`, `release` and `pid`. `llm` exposes the
single-flight queue, circuit state, last success/failure and configured-model preflight result without prompt content.
`decision=degraded` means the process is alive but the provider is not ready for normal replies. Send SIGUSR2 to that PID for
a graceful same-release restart. Never use `kill -9` for planned updates.

Model availability is not established by HTTP 200 alone. The configured model must appear in `/v1/models`, and a recovery
probe must produce non-empty final text after hidden reasoning is removed. The probe uses enough completion budget for a
reasoning model; an empty `content`, even with `finish_reason=stop`, remains `empty_response` and cannot close the circuit or
requeue dead letters. The same final-text validation applies to mentions, voice replies and experience analysis. The Gateway
runs this real-generation probe on startup and every `LLM_HEALTH_PROBE_SECONDS` (default 300 seconds). Failures open
`llm_health_probe_failed`; a later valid final answer resolves it and emits the normal one-time recovery notice. A healthy-state
periodic probe is independent of the production circuit, runs only while the Gateway LLM queue is idle, and cannot open that
circuit by itself. While a circuit cooldown is already active, the watcher waits instead of reporting `circuit_open` as a new
provider failure. After cooldown, one real final answer through the half-open circuit establishes recovery.

Direct mentions remain in the 0600 inbox until they are answered. They enter the interactive LLM queue ahead of
musings and experience analysis. After 15 seconds, the Gateway posts one generation-in-progress message and edits that
message into the final answer. Slow but active generation is status, not an incident and not described as queueing. An
ambiguous timeout/reset is not immediately retried because the model may already have accepted
the prompt; the circuit cools down before the durable Discord item is resumed. User-visible LLM failures create an
incident improvement issue on their first occurrence. Requests carry `x-nexa-client` and `x-nexa-request-id` so the
Gateway and model-host logs can be correlated without logging prompt content.

The model host exposes two batched sessions. The Gateway uses at most two concurrent requests but permits only one
background request, reserving the other session for mentions and voice. Scheduled musings and Knowledge analysis use a
separate 120-second attempt / 180-second total budget by default. Their failures are reported by their own feature path
but do not open the customer-request circuit. This keeps background work bounded while avoiding false global outages
from the local model's observed 40-second-plus tail latency.

On `10.1.0.204`, launchd label `net.nex-a.ds4-health` runs `scripts/monitor-llm-health.py` every five minutes and appends
content-free evidence to `~/Library/Logs/ds4-health.jsonl`. Each row records configured-model presence, model count,
generation HTTP status, final-content/reasoning lengths, finish reason, latency and a bounded error class/status. It never
records either prompt or generated text. This monitor complements the Gateway incident path; it does not replace durable
stdout/stderr capture when the model server itself is next restarted under a proper supervisor.

When a previously open incident is resolved, the Worker posts one recovery notice to the operator channel with the
incident kind, source, occurrence count and elapsed time. A repeated resolve of an already-resolved incident is silent.
Gateway success paths explicitly resolve recoverable LLM wait/failure, model availability, Discord reconnect, nightly
maintenance, welcome, musing and follow-up incidents, so the operator channel distinguishes current failures from history.
