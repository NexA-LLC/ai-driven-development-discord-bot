# Operations runbook

## 1. Environment model

| Environment | Discord | Cloudflare | D1 | Gateway | Data |
|---|---|---|---|---|---|
| local | test appまたはmock | `wrangler dev` | local-only | local process | disposable |
| staging | test Guild専用App | staging Worker | staging DB | single staging host | test data |
| production | production App | production Worker | production DB | managed always-on host | policy-controlled |

`wrangler.jsonc` はstaging/production bindingを分け、placeholder UUIDを本番へ持ち込まないこと。

## 2. Required secrets

### Worker

- `DISCORD_PUBLIC_KEY`
- `DISCORD_BOT_TOKEN`（必要経路を再確認。未使用なら削除）
- `INTERNAL_SHARED_SECRET`（Phase 0のみ。後にrotation/per-client化）
- `AI_API_KEY`
- optional provider/config secrets

### Gateway

- `DISCORD_BOT_TOKEN`
- `WORKER_INTERNAL_URL`
- `INTERNAL_SHARED_SECRET`
- monitored channel IDs
- Warden alert channel ID

### 禁止

- `.env`のcommit
- tokenをDiscordへ貼る
- CI logへsecretを出す
- third-party AgentへDiscord Tokenを渡す
- production secretをstagingで使う

## 3. Phase 0 deployment sequence

### A. Repository

```bash
npm ci
npm run typecheck
npm test
npm run build
```

lockfile作成までは `npm install` ですが、Go-live前に `npm ci` へ移行します。

### B. Cloudflare

```bash
npx wrangler d1 create ai-driven-development-discord-staging --location=apac
npx wrangler d1 migrations apply ai-driven-development-discord-staging --env staging --remote
npx wrangler secret put DISCORD_PUBLIC_KEY --env staging
npx wrangler secret put INTERNAL_SHARED_SECRET --env staging
npx wrangler secret put AI_API_KEY --env staging
npx wrangler deploy --env staging
```

実際のcommandは最終`wrangler.jsonc`に合わせます。

### C. Discord

- Application作成
- User Install / Guild Install有効化
- User Install: `applications.commands`
- Guild Install: `applications.commands` + `bot`
- Interactions Endpointにstaging Workerの`/interactions`
- 最小権限のみ設定
- test GuildへGuild Install
- test userへUser Install
- test Guild限定command登録

### D. Gateway

- allowlistをtest channelだけに設定
- Message Content intentはOFFから開始
- Warden alert channelを指定
- service managerで自動再起動
- logにtoken/本文が出ないことを確認

## 4. Smoke test

- `GET /health`
- Discord endpoint PING
- `/about`
- `/ask public:false`
- `/ask public:true`
- `/pitch`
- User Install経由
- Guild Install経由
- mention response
- allowlist外mention無応答
- bot flood simulation
- D1 audit確認
- raw本文非保存確認
- Gateway restart後の復帰

結果は日時、App ID、Guild ID、commit SHA、Worker version、Gateway versionとともに記録します。

## 5. Rollback

### Worker

- 直前の既知良好versionへrollback
- command payload変更がある場合は旧commandを再登録
- migrationは原則forward fix。破壊的migrationを避ける

### Gateway

- service stop
- Discord tokenを必要に応じてrotate
- 既知良好image/commitでrestart
- Wardenのみ残すsafe modeを用意

### Safe mode

以下を一括で実現できる設定を用意します。

```text
AI replies OFF
Passive observe OFF
Agent dispatch OFF
External actions OFF
Warden alerts ON
/health and /about ON
```

## 6. Incident response

### P0 — token compromise / destructive action

1. Bot停止
2. Discord token rotate
3. Agent credentials revoke
4. Cloudflare secrets rotate
5. affected Guild/channel特定
6. audit保存
7. 運営へ通知
8. 原因修正まで再起動禁止

### P1 — data exfiltration / malicious Agent / privilege escalation

1. Agent Quarantine
2. dispatch credential revoke
3. endpoint/domain block
4. scopeとaudit確認
5. 保存先への削除要求
6. Guild運営へ影響説明

### P2 — loop / spam / cost spike

1. trigger停止
2. rate/budget limit適用
3. thread/channel単位でmute
4. Warden evidence確認
5. false positiveならthreshold調整

### P3 — noisy behavior

- cooldown延長
- public replyをephemeralへ
- channel allowlist縮小
- prompt/policy調整

## 7. Third-party Agent onboarding

1. manifest受付
2. URL/domain basic check
3. safe fetch
4. schema validation
5. Passport
6. human review
7. Dock Sandbox credential発行
8. scope確認
9. test invocation
10. operating window
11. Trusted昇格またはQuarantine

Native Botは別手順で、専用カテゴリ・専用role・最小権限から始めます。

## 8. Data operations

- raw本文を保存しない
- auditはmetadata最小化
- retention jobを実装
- deletion requestの受付・完了証拠
- D1 export/restore drill
- incident evidenceは通常データと別retention
- opaque/guild-scoped user identifierを検討
- public analyticsは集計値のみ

## 9. Monitoring

最低限のメトリクス:

- interaction count / success / latency
- AI provider error / latency / cost
- Gateway connected state / reconnect count
- Worker internal auth failure
- D1 error
- Warden alert
- Agent timeout / circuit state
- proactive suggestion acceptance
- raw-content logging detector

alertは「異常を知れる」だけでなく、どのsafe modeを押すべきかまで示します。

## 10. Host decision

Phase 0は既存のNexA常駐機で検証可能です。ただし本番は次の基準で決めます。

- 24/7 uptime
- process auto-restart
- secret management
- remote log/metrics
- outbound WebSocket安定性
- deploy rollback
- single-person operation負荷
- monthly cost

GatewayはCloudflare経由でWebSocketを中継せず、ホストからDiscord Gatewayへ直接outbound接続します。
