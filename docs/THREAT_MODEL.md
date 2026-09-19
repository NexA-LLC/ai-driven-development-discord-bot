# Threat model

## 1. Protected assets

- Discord bot token
- Discord Application credentials
- Cloudflare account / Worker secrets
- D1 guild policy・audit・incident data
- AI provider key・budget
- third-party Agent credential
- Discord message content handled transiently
- Guild/Channel/Thread scope
- operator approval authority
- NexA/コミュニティの信用

## 2. Trust boundaries

```text
Discord user
  -> Discord Platform
  -> Worker /interactions
  -> AI provider

Discord Gateway
  -> Gateway host
  -> Worker internal API
  -> D1

Operator
  -> review/control surface
  -> Agent registry

Third-party Agent endpoint
  <-> Agent Dock dispatcher
  -> sanitized Discord output
```

各矢印で、認証・scope・rate・payload size・audit・timeoutが必要です。

## 3. Current controls

- Interaction Ed25519 verification
- Gateway→Worker HMAC
- internal request timestamp window
- channel allowlist
- Message Content intent opt-in
- bot-origin messageをAI triggerにしない
- `allowed_mentions`無効化
- output長制限
- raw message tableなし
- high-risk permissionのPassport blocker
- Discord data trainingのPassport blocker
- Warden rate alert
- auto BAN/Kickなし

## 4. Risk register

| Threat | Likelihood | Impact | 現在 | 必須改善 |
|---|---|---|---|---|
| Discord token漏洩 | Medium | Critical | env only | secret manager、rotation drill、log scan |
| AI API key乱用 | Medium | High | env only | per-guild budget、provider key isolation |
| Internal HMAC replay | Medium | High | 5分timestampのみ | nonce/idempotency、replay cache |
| Shared secret横展開 | Medium | High | 1本 | per-client key、rotation/version |
| `/api/agents`情報漏洩 | Medium | Medium | 認証なし | operator auth、public DTO最小化 |
| malicious manifest URL / SSRF | High | High | 自動fetchしない | controlled fetch service |
| Agent output prompt injection | High | High | dispatch未実装 | data/instruction分離、output policy |
| Bot-to-bot infinite loop | Medium | High | bot trigger拒否 | trace/hop limit、circuit breaker |
| cost exhaustion | High | High | 上限なし | rate limit、budget、model router |
| Guild間data leakage | Medium | Critical | guild_id query中心 | tenant-bound auth、isolation test |
| Warden restart evasion | High | Medium | in-memory | durable state、distributed counter |
| false positive moderation | Medium | High | alert only | evidence、human review、appeal |
| slow data exfiltration | Medium | Critical | rate only | permission/scope、egress/audit policy |
| raw content in logs | Medium | High | policyのみ | structured redaction、log test |
| Discord API rate limit | High | Medium | generic handling | header-driven backoff、queue |
| stale/compromised Agent | Medium | High | no runtime check | health, key rotation, re-review |
| permission drift | Medium | High | no detector | periodic audit and reapproval |
| unauthorized publication | Medium | High | prompt policy | preview/confirm/evidence |
| hidden people profiling | Medium | High | prohibited in docs | data model/test/review guardrail |

## 5. Safe manifest fetch

Manifest URLを取得する機能は、単純な`fetch(url)`にしません。

必須制御:

- HTTPSのみ
- URL userinfo禁止
- DNS解決後にloopback/private/link-localを拒否
- redirectごとに再検査
- response size上限
- JSON content-typeまたは厳格parse
- timeout
- cookie/auth headerなし
- fixed user-agent
- egress allow/deny policy
- fetch時刻・最終URL・content hashを記録
- 自動承認しない

外部URLが安全である保証はできないため、取得・schema検証・人間review・実行承認を分離します。

## 6. Agent Dock dispatch

本番dispatch前の必須条件:

### Authentication

- per-agent secretまたはasymmetric key
- key IDとrotation
- `event_id`, `issued_at`, `expires_at`
- replay拒否
- immediate revoke

### Authorization

- trigger scope
- guild scope
- channel/thread scope
- action scope
- context message count
- attachment policy
- external side-effect policy

### Availability / cost

- timeout 10秒未満
- retry ceiling
- exponential backoff
- circuit breaker
- per-agent concurrency
- per-agent/guild budget
- dead-letter/audit

### Output

- schema validation
- 1900文字以下
- all mentions disabled by default
- URL/attachment policy
- no direct Discord API credential
- no arbitrary markdown embeds/components until reviewed
- output origin label

## 7. AI-specific controls

### Prompt injection

Discord本文・添付・Agent返答はすべてuntrusted dataです。

- system policyとuser/Discord dataを明確に分ける
- secretsをmodel contextへ入れない
- tool callsはallowlist schemaで検証
- retrieved text内の命令を実行しない
- 外部Actionは別confirmation step
- tool resultとmodel statementを分離

### Hallucination

- 「実行した」と言うにはtool evidenceが必要
- 生成物と公開済み成果を分ける
- 出典・対象repository・environmentを表示
- uncertaintyを返せるようにする

### Cost attack

- input/output token上限
- cheap classifier/router
- per-user/guild quotas
- duplicate request collapse
- caching
- emergency AI-off switch

## 8. Go-live minimum

Phase 0のstagingでも、少なくとも次を満たします。

- local/staging/production分離
- dependency lockfileと`npm ci`
- rate limit・budget cap
- HMAC replay defense
- `/api/agents`認証または非公開化
- guild policyのruntime enforcement
- secret rotation手順
- log redaction
- health/metrics/alert
- safe mode
- token compromise drill
- data disclosure/deletion経路
- Native Bot admission policy
- Discord E2E test evidence

## 9. Security claim rule

Passportの表示は次を分けます。

- **Self-declared**: 開発者のmanifest申告
- **Discord-observable**: Discordから確認できる権限/intent
- **NexA-reviewed**: 人間または静的検査済み
- **Gateway-enforced**: Agent Dockが構造的に制限
- **Runtime-observed**: 実運用のrate、incident、uptime

Passportは認証・安全保証ではありません。「何を根拠にどこまで確認したか」を可視化する比較指標です。
