# AI Driven Development Discord Bot「スー」

AI駆動開発コミュニティ（Discord）のための Discord App / Bot 基盤です。Bot の人格は KyaraFlip のキャラクター「スー（Su Myat Thiri）」で、Discord サーバーを「深夜のコンビニ」に見立てて動きます。人格の正本は [`docs/character/su.md`](docs/character/su.md)、Bot への投影（プロンプト）は `src/shared/persona.ts` です。挙動は if 文ではなくプロンプトで管理します。

皆で作る Bot です。Issue / PR 歓迎。改善の議論は DecisionGarden「スーの秘密日記」に残します。

> **Status — 2026-09-06:** Worker と D1 は本番に deploy 済み、Discord Application「スー」は AI駆動開発サーバーにインストール済みで、slash command も登録済みです。**Gateway の常駐（社内LLMでの回答）と test channel での E2E はこれから**です。  
> 現在地の詳細: [`docs/CURRENT_STATUS.md`](docs/CURRENT_STATUS.md)

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

### Live (2026-09-06)

- Cloudflare Worker + D1（本番）、migration 0001/0002 適用済み
- Discord Application「スー」: Interactions endpoint 検証済み、AI駆動開発サーバーにインストール済み、guild command 登録済み
- test channel `#スーのレジ-test`

### Not yet live

- Gateway常駐（社内LLMでの回答、mention、Warden）
- test channel E2E（/ask の往復）
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
│          ├─ D1: policy / registry / audit metadata / ai_jobs (注文キュー)
│          └─ AI_PROVIDER=gateway: /ask, /pitch を ai_jobs に積む（既定）
│             AI_PROVIDER=worker : OpenAI互換APIを Worker から直接呼ぶ
│
└─ Gateway events (guild-installed bot, 社内ネットワークで常駐)
     └─ Node Gateway process
          ├─ /internal/jobs/claim で注文を取り、社内LLM (OpenAI互換) で回答
          │    └─ Discord interaction webhook で follow-up
          ├─ mention response -> 社内LLM で直接回答
          ├─ safe event metadata -> Worker /internal/events
          └─ Bot Warden -> moderator alert（自動BANなし）

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

### Worker secrets

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put INTERNAL_SHARED_SECRET
npx wrangler secret put AI_API_KEY       # AIを使う場合のみ
```

既定（`AI_PROVIDER=gateway`）では Worker は LLM を呼びません。/ask と /pitch は D1 の `ai_jobs` に積まれ、Gateway が社内 LLM で答えます。Worker から直接 OpenAI 互換 API を呼びたい場合だけ `AI_PROVIDER=worker` にし、`AI_API_URL` / `AI_MODEL` を vars、`AI_API_KEY` を secret に入れます。

### Command registration

```bash
npm run commands:register
```

登録は Worker の `/internal/register-commands` 経由で行うので、開発機に Bot トークンは不要です。`.env` の `WORKER_INTERNAL_URL` と `INTERNAL_SHARED_SECRET` を使い、`DISCORD_GUILD_ID` があればそのGuildだけに（即時反映）、なければグローバルに登録します。コマンド定義は `src/shared/commands.ts` です。

### Gateway

```bash
cp .env.example .env   # DISCORD_BOT_TOKEN, WORKER_INTERNAL_URL, INTERNAL_SHARED_SECRET, LLM_API_URL などを記入
npm run dev:gateway
```

Gateway は Discord へ外向き WebSocket 接続し、Worker の注文キューを `JOB_POLL_SECONDS` ごとに取りに行き、`LLM_API_URL`（OpenAI 互換 Chat Completions。社内の LM Studio など）で回答します。受信用ポートの公開は不要で、社内ネットワークの常駐機で動かせます。`LLM_API_URL` が空のときは /ask の注文はキューに残ったままになります。

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

## 人格と改善の記録

- 人格の正本: [`docs/character/su.md`](docs/character/su.md)
- Live Card: https://kyaraflip.com/api/public/artifacts/398db834-8191-4f02-92d1-2432ea940488
- 改善の議論: DecisionGarden「スーの秘密日記」（team で編集、埋め込みで公開）

## License

MIT License. Copyright © 2026 NexA LLC and contributors. See [LICENSE](LICENSE).

## MCP（外部からスーを動かす）

Worker が `POST /api/mcp`（JSON-RPC、`Authorization: Bearer <SU_MCP_TOKEN>`）を提供します。Codex / Claude などから登録して使えます。

| tool | 何をするか |
|---|---|
| `su_muse` | 今すぐ独り言を1本（`topic` で材料指定可）。Gateway が社内LLMで生成して投稿 |
| `su_say` | 与えた文面をそのまま `musings` / `ops` チャンネルへ投稿（LLMなし） |
| `su_status` | 直近の返答、待機中の注文、未解決 incident |
| `su_incidents` / `su_resolve_incident` | incident 一覧・解決 |
| `su_feedback_recent` | 直近のフィードバック |
| `su_run_digest` | 改善ダイジェストを今すぐ実行 |

```bash
curl -s https://<worker>/api/mcp -H "authorization: Bearer $SU_MCP_TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"su_muse","arguments":{"topic":"今日は雨"}}}'
```
