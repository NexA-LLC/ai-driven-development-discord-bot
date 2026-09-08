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
same-slot repeats. A musing/digest failure after reservation skips that slot.

The launchd label is `net.nex-a.su.gateway-managed`. Its SSH loopback entrypoint
preserves the existing host's local-network permission workaround. The supervisor
is a service-specific updater; NexA Host fleet inventory integration is separate.
Use loopback `/readiness` on the configured `READINESS_PORT` (202: 8791) to inspect `activeWork`, `draining`,
`startupReady`, `queuedMessages`, `release` and `pid`. Send SIGUSR2 to that PID for
a graceful same-release restart. Never use `kill -9` for planned updates.
