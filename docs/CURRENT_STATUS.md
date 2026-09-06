# Current status

基準日: **2026-09-06**  
対象: `NexA-LLC/ai-driven-development-discord-bot`

## 結論

このリポジトリは、**設計だけではなくTypeScript実装まである**一方、まだ「Discordで使えるBot」ではありません。

正確には次の状態です。

- コード骨格: あり
- 型検査・単体テスト・ビルド: CI成功
- Cloudflare Worker本番デプロイ: 未実施
- D1実DB作成・migration適用: 未実施
- Discord Application作成・設定: 未確認
- test GuildへのUser/Guild Install: 未実施
- Gateway常駐起動: 未実施
- 実Discord上のEnd-to-End確認: 未実施
- 第三者Agentの本番dispatch: 未実装

したがって、**リポジトリ完成度とサービス完成度を同一視しない**ことが重要です。

## Capability matrix

| Capability | Code | Automated test/build | Live deploy | Discord E2E | 判定 |
|---|---:|---:|---:|---:|---|
| `/ask` Interaction | Yes | Buildのみ | No | No | 骨格 |
| `/pitch` Interaction | Yes | Buildのみ | No | No | 骨格 |
| `/about` | Yes | Buildのみ | No | No | 骨格 |
| `/agents` | Yes | Buildのみ | No | No | 骨格 |
| `/agent-submit` URL受付 | Yes | Buildのみ | No | No | 骨格 |
| User Install command定義 | Yes | Buildのみ | No | No | 未実証 |
| Guild Install command定義 | Yes | Buildのみ | No | No | 未実証 |
| Discord署名検証 | Yes | 専用testなし | No | No | 要test |
| Interaction defer/follow-up | Yes | 専用testなし | No | No | 要E2E |
| Gateway接続 | Yes | Buildのみ | No | No | 未実証 |
| メンション応答 | Yes | Buildのみ | No | No | 未実証 |
| Channel allowlist | Yes | 専用testなし | No | No | 要test |
| passive observe metadata | Yes | 専用testなし | No | No | 実験前 |
| Bot rate Warden | Yes | 専用testなし | No | No | prototype |
| D1 schema | Yes | migration testなし | No | No | prototype |
| Agent Manifest検証 | Yes | Unit testあり | N/A | N/A | 実装済み |
| Passport scoring | Yes | Unit testあり | N/A | N/A | prototype |
| Agent review/approval | DB列のみ | No | No | No | 未実装 |
| Agent Dock dispatch | No | No | No | No | 未実装 |
| Quarantine/revoke | No | No | No | No | 未実装 |
| 管理UI/Discord運営操作 | No | No | No | No | 未実装 |
| Pitcheee実投稿 | No | No | No | No | 未実装 |
| FlowAlign/RepoDeck操作 | No | No | No | No | 未実装 |

## 実装済みの証拠

### Cloudflare Worker

`src/worker/index.ts` に以下の入口があります。

- `GET /health`
- `POST /interactions`
- `POST /internal/ask`
- `POST /internal/events`
- `POST /internal/agents`
- `GET /api/agents`

実装済みの制御:

- Discord Ed25519署名検証
- Interactionのdeferとfollow-up
- HMACによるGateway→Worker内部通信
- 1900文字への出力切り詰め
- `allowed_mentions` 無効化
- AI API未設定時のfallback
- Agent申請のD1記録
- metadata-only audit event記録

### Gateway

`src/gateway/index.ts` に以下があります。

- Discord Gatewayへのoutbound WebSocket接続
- `Guilds` / `GuildMessages` intent
- Message Content intentの明示的ON/OFF
- Channel allowlist
- 自Bot・外部BotからAI応答を連鎖させない制御
- Bot投稿レートのインメモリ監視
- WorkerへのHMAC署名付き送信
- 運営チャンネルへのWarden警告
- SIGINT/SIGTERM時の終了処理

### D1

`migrations/0001_init.sql` に以下があります。

- `guild_policies`
- `agent_submissions`
- `agent_installations`
- `audit_events`
- `incidents`

意図的に `raw_messages` テーブルはありません。

### CI

GitHub Actionsは次を実行し、直近実行は成功しています。

- dependency install
- TypeScript typecheck
- Vitest
- Worker dry-run build
- Gateway bundle build

ただしlockfileが無いため、現状のCIは完全再現可能ではありません。

## 完成度の目安

以下は進捗管理のための推定値であり、実測ではありません。

| 軸 | 推定 | 理由 |
|---|---:|---|
| プロダクト仮説 | 75% | 役割と非目標は概ね定義済み |
| リポジトリ基盤 | 70% | TypeScript、CI、migration、docsあり |
| Community AIコード | 50% | 基本commandのみ。評価・tool executionなし |
| User Install実証 | 10% | command定義のみ。実導入未確認 |
| Guild Install実証 | 10% | Gatewayコードのみ。常駐未確認 |
| Warden | 20% | 単純レート検知のみ。永続state・停止操作なし |
| Agent Dock | 15% | Manifest/Passportのみ。dispatchなし |
| セキュリティ/運用 | 30% | 基本方針あり。認証、rotation、runbook実証なし |
| Phase 0 MVP全体 | **約35%** | CI成功だがlive E2Eがゼロ |

## 重要な未解決点

### P0 — 起動しなければ価値が証明できない

1. Discord Applicationとtest Guildを用意
2. staging D1を作成
3. Workerをstaging deploy
4. command登録
5. Gatewayを常駐起動
6. `/ask`、`/pitch`、メンション、Wardenを実Discordで通す

### P0 — 現状の安全上の穴

- `/api/agents` に利用者認証がなく、guild IDを知る相手へ情報を返し得る
- 内部HMACは5分以内のreplayを防いでいない
- 共通secretが全Gatewayで1本
- per-user / per-guildのAIコスト上限がない
- `guild_policies` がruntimeで実際には参照されていない
- Warden stateがインメモリで、再起動や複数instanceで消える
- Agent URL受付後の安全なfetch/review経路がない
- Discord Interaction、HMAC、D1 migrationの専用testが不足
- dependency lockfileがない
- staging / productionのCloudflare環境分離がない

### P1 — 価値検証不足

- AI回答が「役に立ったか」を測る導線がない
- 回答から仕様・Issue・試作・ピッチへ進む構造化Actionがない
- Pitcheeeは文面上の任意導線だけで、実連携ではない
- 外部Agentを試す体験がまだ存在しない
- passive observationのshadow evaluationが未実施

## 次のマイルストーン

次に達成すべき状態は機能追加ではなく、次の一文です。

> test Guild上でUser InstallとGuild Installが動き、本文非保存を確認しながら、`/ask`・`/pitch`・メンション応答・Warden警告を再現できる。

Exit Gateは [ROADMAP.md](ROADMAP.md)、具体タスクは [`../todos.jsonl`](../todos.jsonl) を参照してください。
