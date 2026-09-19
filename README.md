# AI Driven Development Discord Bot「スー」

AI駆動開発コミュニティ（Discord）のための Discord App / Bot 基盤です。Bot の人格は KyaraFlip のキャラクター「スー（Su Myat Thiri）」で、Discord サーバーを「深夜のコンビニ」に見立てて動きます。人格の正本は [`docs/character/su.md`](docs/character/su.md)、Bot への投影（プロンプト）は `src/shared/persona.ts` です。挙動は if 文ではなくプロンプトで管理します。

皆で作る Bot です。Issue / PR 歓迎。改善の議論は DecisionGarden「スーの秘密日記」に残します。

### 会話・経験記憶と公開イベント

対応チャンネルでは、メンションだけでなくスーの投稿への通常の返信でも会話を続けます。同じ返信チェーンの最大8件・6時間・5,000文字を参照し、実在する発言から短い経験を抽出します。観察された引用とスーの解釈を分け、関連する会話に最大3件、同じチャンネルの独り言に最大1件を読み戻します。記憶・解析待ちは `SU_STATE_DIR/experiences.json` に最大30日保持します。詳細と削除・再試行の扱いは [実装ノート](docs/EXPERIENCE_AND_EVENTS.md) を参照してください。

connpass API v2 からAI駆動開発グループ（`subdomain=aid`）のイベント一覧を取得し、話題に使えます。connpassで発行されたAPI keyを `CONNPASS_API_KEY` に設定し、`CONNPASS_ENABLED=true` で有効化します。既定は1時間ごとの取得・24時間のキャッシュ有効期限・イベント独り言1日1件です。初回は取り込みのみ。質問には取得済み情報と実際の開催日時を参照し、新着の独り言には出典URLを必ず添えます。`CONNPASS_POLL_SECONDS` / `CONNPASS_CACHE_HOURS` / `CONNPASS_DAILY_LIMIT` で調整できます。公開情報はスー自身の体験記憶には登録しません。

記憶は日付ではなく話題で束ねます。同じチャンネルで同じ話が続いた場合は新しいノードを作らず、同一 thread を根拠付きで更新し（`revision` が増え、以前の引用は履歴として残ります）、変化がなければ何も書きません。未解決の問いはTODOではなく knowledge として保持します。日次ダイジェストは廃止しました。

本番有効化には、このWorker/Gatewayの反映、永続 `SU_STATE_DIR`、既存のGateway用LLM設定が必要です。DB migrationはありません。DecisionGardenへの経験共有は `EXPERIENCE_KNOWLEDGE_CHANNEL_IDS` に運営が明示したsource channelを指定した場合のみです。さらにそのうえで、記憶ごとに安全性判定を通す必要があります。保存されるのは原文の引用ではなく、人物名・内密の内容がないと判定されたうえで書き直された短い要約だけで、DecisionGarden上でも `visibility: private` のKnowledgeです。判定を通らなかった記憶はノードを作りません。旧 `EXPERIENCE_PUBLIC_CHANNEL_IDS` は互換aliasとして読まれますが、公開ノードは作りません。稼働統計はGardenではなく運営ログにのみ出ます。この変更のローカル検証だけでは本番反映・Discord送信を意味しません。

#### 導入順・未反映時の挙動・ロールバック

1. **DecisionGarden（先）** — 関連PR: [NexA-LLC/webapp-decisiongarden#21](https://github.com/NexA-LLC/webapp-decisiongarden/pull/21)（`update_memory_node` の追加と、archived な Knowledge の読み取り互換修正）。Knowledge/TODO の本文を更新する `update_memory_node({nodeId, expectedUpdatedAt, title?, body?, evidence?})` が必要です（`mcp:write` + Garden write、`gardenId`/`kind`/`source`/`sourceKey` と `state`/`visibility` は指定不可、未知フィールドは拒否）。CAS 不一致は `updated_at_conflict` で何も書きません。ただし保存済み内容が要求内容と同じ場合は「適用済みの再試行」として `operation:"unchanged"` を返すため、Bot はこれを同期成功として扱います。既存の `save_memory_node` は create-only のままで、意味は変えません。未反映でも Bot は落ちません。
2. **Worker（次）** — `/internal/experiences/sync`（revision 1 は `save_memory_node`、revision 2 以降は `update_memory_node`）、`/internal/experiences/retract`、`/internal/experiences/pull`、`/internal/maintenance/run` が入ります。Garden へのアクセスは、作成時に受け取った node id で `get_memory_node` を1件ずつ呼ぶ形に限定され、Garden 全体の一覧取得は行いません。`/internal/digest/run` は同じ保守処理への互換エイリアスとして残り、`deprecatedAlias: true` を返します。
3. **Gateway（最後）** — 夜間保守の呼び先が `/internal/maintenance/run` に変わり、`MAINTENANCE_HOUR_JST`（未設定なら `DIGEST_HOUR_JST`）で動きます。`experiences.json` は既存ファイルのまま読めます（新しい項目は既定値で補完）。

**未反映時の挙動**: DecisionGarden が旧版だと、初回作成は成功し、2回目以降の更新は `update_unsupported` として**同期待ち**になります。権限不足（`forbidden` / `insufficient_scope` など）は `not_permitted`、Garden 側で人が編集していた場合は `conflict`、公開済みノードが消えていた場合は `absent` として同様に保留します。いずれも成功扱いにはせず、6時間ごとに再試行し、`syncedRevision` は進めません。人の編集を上書きすることはありません。ただし、Garden 側が動いたのが「自分の更新が適用されたが応答が届かなかった」ためで、保存内容が送ろうとしている内容と完全一致する場合だけは再送を通し、Garden の `unchanged` として決着させます。Worker が旧版だと Gateway の保守呼び出しは互換エイリアス経由で通ります。DecisionGarden 自体が未設定・不調でも会話は継続します。

**取り下げの保全**: 公開済みコピーの取り下げ待ち（tombstone）は容量のために捨てません。未処理が100件に達すると、新しい会話の受け付けと新しい公開を止めて backlog の解消を優先します（原文の30日失効はそのまま進みます）。

**移行**: node id を記録する前に公開されたコピーは更新も取り下げもできないため、`node_unknown` として保留しログに出します（Garden 全体を検索して探すことはしません）。該当は手動で archived+private にするか、30日の失効を待ってください。新規の経験は作成時に node id を受け取るので影響しません。

**ロールバック**: Gateway → Worker の順に前のリビジョンへ戻します。Garden 上のノードは残り、`sourceKey` は `su-experience:<threadId>` のまま変わらないため、再適用時に二重作成は起きません。`update_memory_node` の追加は既存データを書き換えないので、DecisionGarden 側は単独で戻せます。保全済みの旧日次報告（archived/private）には触れません。

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
- `/quiz [topic:<テーマ>] [public:true|false]` — 日次クイズと共通の生成・表示処理で、正解のない4択投票を出題。topicの質問を活かして選択肢を作成。既定は公開、リアクションで参加。`public:false` は自分用プレビュー。

`/quiz` は既存の `/ask` と同じAI処理・キューを利用します。日次クイズの投稿時刻や投稿済み状態には影響しません。追加をDiscordへ反映するにはWorkerをデプロイ後、`npm run commands:register` でコマンドを再登録してください。
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

以下はローカル開発向けです。実サーバーで動かすまでの手順は [`docs/DEPLOY.md`](docs/DEPLOY.md) にまとめています。

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
- Gatewayが処理するコマンド・メンションの入力、送信者ID、応答、送信結果を202の `SU_STATE_DIR/conversation-audit` に日別JSONLで30日間保存（ディレクトリ0700・ファイル0600）。生成と送信成功は別イベント。R2転送は未導入。Worker単独の代替応答はこのログの対象外。
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
  -> 運営用ログの保存期間・アクセス権を確認
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
| `su_run_digest` | **非推奨**。運営統計を読むだけで、Gardenへの書き込みも日次報告の作成も行わない |

```bash
curl -s https://<worker>/api/mcp -H "authorization: Bearer $SU_MCP_TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"su_muse","arguments":{"topic":"今日は雨"}}}'
```
