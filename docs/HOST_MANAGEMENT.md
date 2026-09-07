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
