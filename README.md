# AI Driven Development Discord Bot

AI Driven Development コミュニティのための Discord App / Bot 基盤です。

目的は、NexAを広告することではなく、コミュニティ参加者の「聞きたい・作りたい・見せたい・他のAgentを試したい」を、その場で一段前へ進めることです。NexAの製品や外部サービスは、必要な場面だけ能力として接続します。

## このリポジトリが担う3つの役割

1. **Community AI** — `/ask`、`/pitch`、メンションへの回答。質問への文章回答だけでなく、次に取れる実行候補を返します。
2. **Agent Dock / Bot Passport** — 他の開発者のBot・Agentを、Discord Tokenを渡さずHTTP経由で接続するための申請・安全評価基盤です。
3. **Bot Warden** — サーバーインストール型Botとして常時接続し、外部Botの異常連投やBot同士のループを検知して運営へ通知します。初期版は自動BANせず、人間が停止・Kick・BANを判断します。

## ユーザーインストール型とサーバーインストール型

| 方式 | 初期用途 | 読める範囲 | このリポジトリでの担当 |
|---|---|---|---|
| User Install | 個人が `/ask` や `/pitch` を持ち歩く | 明示的なInteraction中心 | Cloudflare Worker (`src/worker`) |
| Guild Install | 常時監視、メンション応答、Bot Warden | 許可されたGuild/Channelイベント | Node Gateway (`src/gateway`) |
| Agent Dock | 第三者Agentを安全に試す | NexA Gatewayが渡した最小イベントだけ | Manifest / Passport / D1 Registry |

同じDiscord Applicationで User Install と Guild Install の両方を有効にします。InteractionはCloudflare WorkerのHTTP Endpointで受け、Gatewayプロセスはメッセージイベントだけを扱います。

## MVPで動くもの

- `/ask prompt:<内容> [public:true|false]`
- `/pitch idea:<内容> [public:true|false]`
- `/agents` — 承認済みAgent一覧
- `/agent-submit manifest_url:<HTTPS URL>` — 外部Agent申請（URLを保存し、サーバー側から自動fetchはしません）
- `/about` — 控えめな運営・データ方針表示
- Discord署名検証（Ed25519）
- GatewayからWorkerへのHMAC署名付き内部通信
- Guild / Channel allowlist
- Bot連投の検知と運営チャンネルへの通知
- Agent Manifestのスキーマ検証とPassportスコア
- D1に申請、Passport、監査イベント、Incidentを保存
- **生の会話本文はデフォルトで保存しません**

## 構成

```text
Discord
├─ Interactions (slash commands)
│    └─ Cloudflare Worker /interactions
│          ├─ D1: policy / registry / audit metadata
│          └─ OpenAI-compatible LLM API (optional)
│
└─ Gateway events (guild-installed bot)
     └─ Node Gateway process
          ├─ mention response -> Worker /internal/ask
          ├─ safe event metadata -> Worker /internal/events
          └─ Bot Warden -> moderator alert

Third-party Agent
└─ HTTPS endpoint + agent-manifest.json
     └─ Agent Dock registry / Passport review
          └─ future: scoped event dispatch (Discord Tokenは渡さない)
```

詳細は [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) と [`docs/SECURITY.md`](docs/SECURITY.md) を参照してください。

## セットアップ

### 1. Install

```bash
npm install
cp .env.example .env
```

Node.js 22.12以上を前提にしています。

### 2. Discord Developer Portal

1. Applicationを作成
2. **User Install** と **Guild Install** を有効化
3. Installation ContextsでUser/Guildの両方を許可
4. Interactions Endpoint URLを `https://<worker-domain>/interactions` に設定
5. Guild Install用Botを作成
6. Message Content Intentは、常時本文を読む必要が確定した場合だけ有効化

### 3. D1

```bash
npx wrangler d1 create ai-driven-development-discord
# wrangler.jsonc の database_id を置換
npx wrangler d1 migrations apply ai-driven-development-discord --local
npx wrangler d1 migrations apply ai-driven-development-discord --remote
```

### 4. Worker secrets

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put INTERNAL_SHARED_SECRET
npx wrangler secret put AI_API_KEY       # AIを使う場合のみ
```

`AI_API_URL` と `AI_MODEL` は `wrangler.jsonc` のvarsまたは環境変数で設定します。OpenAI互換Chat Completions APIを想定しています。

### 5. Slash command登録

```bash
DISCORD_APPLICATION_ID=... \
DISCORD_BOT_TOKEN=... \
npm run commands:register
```

`DISCORD_GUILD_ID` を追加すると開発Guildだけに登録します。

### 6. Worker

```bash
npm run dev:worker
# 本番反映は明示的に
npm run deploy:worker
```

### 7. Gateway

```bash
DISCORD_BOT_TOKEN=... \
WORKER_INTERNAL_URL=https://<worker-domain> \
INTERNAL_SHARED_SECRET=... \
MONITORED_CHANNEL_IDS=123,456 \
npm run dev:gateway
```

GatewayはDiscordへ外向きWebSocket接続するため、通常は受信用ポート公開不要です。Cloudflare WorkerはInteractionsと内部APIの表玄関を担当します。

## 安全側の初期設定

- `PASSIVE_OBSERVE=false`
- `ENABLE_MESSAGE_CONTENT_INTENT=false`
- `MONITORED_CHANNEL_IDS` は明示allowlist
- AIが他Botの発言に返答しない
- 自動BAN / 自動Kick / 自動ロール変更なし
- 外部Agentの `ADMINISTRATOR` 等は自動Reject
- Discordデータの学習利用を申告するAgentはReject
- 外部manifest URLは申請時に自動fetchしない（SSRF回避）
- 外部公開やPitcheee導線はユーザーの明示操作後のみ

## Agent Passport

Passportは「安全を保証する認証」ではなく、リスクを比較するための表示です。

- **green**: Sandbox導入候補
- **yellow**: 追加確認が必要
- **red**: 掲載のみ／Native Install非推奨
- **blocked**: 自動導入不可

評価対象は権限、Privileged Intents、メッセージ保存、保持期間、外部LLM、学習利用、削除窓口、レート上限です。

## 開発コマンド

```bash
npm run typecheck
npm test
npm run build
npm run dev:worker
npm run dev:gateway
```

## 現時点で未実装のもの

- 第三者Agentへの本番イベントdispatch
- 管理Web UI
- Discord上の承認ボタン
- 自動Quarantine（高権限が必要なので初期版では意図的に外しています）
- FlowAlign / RepoDeck / Pitcheeeへの実操作
- 本番デプロイとDiscordサーバーへの導入

まずはCommunity AI、Agent申請、Passport判定、Warden通知を実サーバーで検証し、誤割込み率と運営負荷を測ってから権限を広げます。

## KPI（初期）

- 明示呼出しへの応答成功率: 99%以上
- 不要な自発割込み報告率: 1%未満
- Bot異常連投の検知遅延: 30秒以内
- Agent申請からSandbox判断まで: 24時間以内
- `/ask` から成果物・次アクションに進む率: 20%以上
- `/pitch` 作成者の外部公開選択率: 計測のみ（誘導最適化を先にしない）

## License

Private repository. Copyright © NexA LLC.
