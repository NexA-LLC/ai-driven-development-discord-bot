# AI Driven Development Discord Bot

AI Driven DevelopmentコミュニティのためのDiscord App / Bot基盤です。

> **Status — 2026-09-06:** TypeScript実装、migration、CIまでは成立しています。**Cloudflare/D1への本番・staging deploy、Discord Applicationへの接続、test Guild E2Eはまだ未完了**です。  
> 正確な現在地: [`docs/CURRENT_STATUS.md`](docs/CURRENT_STATUS.md)

目的はNexAを広告することではなく、参加者の「聞きたい・作りたい・見せたい・自分のAgentを試したい」を、その場で一段前へ進めることです。NexA製品や外部サービスは、明示的な目的がある場面だけ能力として接続します。

## Project control

- [Docs index](docs/INDEX.md)
- [Current status](docs/CURRENT_STATUS.md)
- [Product strategy / NexA value](docs/PRODUCT_STRATEGY.md)
- [User Install / Guild Install / Agent Dock](docs/CAPABILITY_AND_INSTALLATION_MODEL.md)
- [Roadmap and exit gates](docs/ROADMAP.md)
- [Operations runbook](docs/OPERATIONS_RUNBOOK.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Decision log](docs/DECISIONS.md)
- [Experiments](docs/EXPERIMENTS.md)
- [Community policy draft](docs/COMMUNITY_POLICY_DRAFT.md)
- [Machine-readable backlog](todos.jsonl)
- [`todos.jsonl` guide](docs/TODOS.md)

## このリポジトリが担う3つの役割

1. **Community AI**  
   `/ask`、`/pitch`、メンションへの回答。文章回答だけでなく、仕様・試作・紹介等の次Actionへ進める。

2. **Agent Dock / Bot Passport**  
   他の開発者のBot・Agentを、Discord Tokenを渡さずHTTPS経由で接続するための申請・安全評価・将来のdispatch基盤。

3. **Bot Warden**  
   Guild Install Botとして常時接続し、外部Botの異常連投やBot同士のループを検知して運営へ通知する。初期版は自動BANしない。

## Installation model

| 方式 | 主用途 | 常時監視 | 実行場所 |
|---|---|---:|---|
| User Install | 個人が`/ask`・`/pitch`を持ち歩く | No | Cloudflare Worker |
| NexA Guild Install | メンション、許可channel監視、Warden | Yes | Node Gateway |
| Agent Dock | 第三者Agentへ限定eventだけdispatch | 条件付き | Worker / future dispatcher |
| Third-party Native Bot | 例外的な専用機能 | Yes | 第三者運用。手動審査 |

同じDiscord ApplicationでUser InstallとGuild Installの両方を有効にします。InteractionはCloudflare WorkerのHTTP endpointで受け、Guild message eventはNode GatewayがDiscordへ直接outbound WebSocket接続して受けます。

## Current MVP code

### Commands

- `/ask prompt:<内容> [public:true|false]`
- `/pitch idea:<内容> [public:true|false]`
- `/agents`
- `/agent-submit manifest_url:<HTTPS URL>`
- `/about`

### Implemented foundations

- Discord Interaction Ed25519署名検証
- Gateway→Worker HMAC署名
- User/Guild installation context付きcommand payload
- Gateway listener
- Guild/Channel allowlist
- external bot rate alert
- Agent Manifest schema
- Passport scoring
- D1 migration
- metadata-only audit/incident
- no raw message table
- CI: typecheck / test / build

### Not yet live

- Cloudflare staging/production resources
- D1実DB
- Discord Application secrets/config
- Worker deploy
- Gateway常駐
- test Guild E2E
- Agent review UI
- Agent Dock dispatch
- Quarantine/revoke
- passive observation classifier
- Pitcheee/FlowAlign/RepoDeckの実操作

## Architecture

```text
Discord
├─ Interaction
│    └─ Cloudflare Worker /interactions
│          ├─ Community AI
│          ├─ Agent registry
│          └─ D1 control plane
│
└─ Gateway Events
     └─ Node Gateway process
          ├─ mention response -> Worker /internal/ask
          ├─ metadata event -> Worker /internal/events
          └─ Bot Warden -> operator alert

Third-party Agent
└─ HTTPS endpoint + agent-manifest.json
     └─ Agent Dock
          └─ future: scoped signed dispatch
```

詳細:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/SECURITY.md`](docs/SECURITY.md)
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)

## Local setup

```bash
npm install
cp .env.example .env
npm run typecheck
npm test
npm run build
```

Node.js 22.12以上を前提にしています。

### Local Worker / D1

```bash
npx wrangler d1 migrations apply ai-driven-development-discord --local
npm run dev:worker
```

### Command registration

```bash
DISCORD_APPLICATION_ID=... \
DISCORD_BOT_TOKEN=... \
DISCORD_GUILD_ID=... \
npm run commands:register
```

`DISCORD_GUILD_ID`を外すとglobal command登録です。最初はtest Guild限定で検証します。

### Gateway

```bash
DISCORD_BOT_TOKEN=... \
WORKER_INTERNAL_URL=http://127.0.0.1:8787 \
INTERNAL_SHARED_SECRET=... \
MONITORED_CHANNEL_IDS=123,456 \
WARDEN_ALERT_CHANNEL_ID=789 \
npm run dev:gateway
```

GatewayはDiscordへoutbound接続するため、通常は受信用ポート公開やCloudflare経由のWebSocket relayは不要です。

## Safe defaults

- `PASSIVE_OBSERVE=false`
- `ENABLE_MESSAGE_CONTENT_INTENT=false`
- `MONITORED_CHANNEL_IDS`は明示allowlist
- AIが他Botの発言へ自動返信しない
- raw message contentを永続保存しない
- 自動BAN/Kick/role変更なし
- high-risk permissionはPassportでblocked
- Discordデータのmodel trainingをblocked
- 外部manifest URLを申請時に自動fetchしない
- Pitcheee等への公開は明示操作後のみ
- `allowed_mentions`を無効化

## Agent Passport

Passportは安全認証ではなく、リスク比較です。

- `green`: Sandbox候補
- `yellow`: 追加確認
- `red`: 掲載のみ / Native Install非推奨
- `blocked`: 自動導入不可

表示時は、次を区別します。

- self-declared
- NexA-reviewed
- Gateway-enforced
- runtime-observed

## Development commands

```bash
npm run typecheck
npm test
npm run build
npm run dev:worker
npm run dev:gateway
npm run commands:register
```

## Immediate milestone

機能追加より先に、Issue #1の実Discord E2Eを通します。

```text
staging D1
  -> staging Worker
  -> Discord Application
  -> User Install / Guild Install
  -> Gateway host
  -> /ask /pitch /mention /Warden
  -> raw本文非保存を確認
```

実行順と依存関係は[`todos.jsonl`](todos.jsonl)を正本にします。

## License

Private repository. Copyright © NexA LLC.
