# Roadmap and exit gates

このRoadmapは機能数ではなく、**検証可能な状態**で区切ります。

## Phase 0 — Real boot

### Goal

test Guildで実際に動くことを証明する。

### Scope

- Discord Application
- User Install / Guild Install
- staging D1
- staging Worker
- Gateway常駐
- `/ask`
- `/pitch`
- `/about`
- メンション応答
- Warden alert
- raw本文非保存確認

### Exit Gate

- Discord PINGが成功
- `/ask` と `/pitch` が初期応答3秒以内、follow-up成功
- User Install / Guild Installの両方で`/ask`成功
- Message Content intent OFFでもメンション応答を実証
- allowlist外ではGateway応答0件
- 外部Bot 6件/30秒でIncidentと運営通知
- D1にraw本文が存在しない
- Worker/Gateway双方にtrace IDが残る
- restart後も手順書だけで復旧できる
- active userあたりの原価が計測できる

### Kill condition

Phase 0が通る前に、管理Web UI、複雑なRAG、複数人格、FlowAlign連携を作らない。

## Phase 1 — Community beta

### Goal

「役に立つが邪魔ではない」を証明する。

### Scope

- 1つの公開allowlisted channel
- explicit commandとmentionのみ
- feedback buttons
- per-user/guild rate limit
- budget cap
- redacted observability
- `/agent-submit`
- 人間review
- Passport表示
- one-click Quarantine
- native bot sandbox policy

### Exit Gate

- 明示呼出し成功率 99%以上
- 7日再利用率 20%以上
- outcome化率 20%以上
- 不要な自発割込み 0件（このPhaseでは自発返信OFF）
- P0/P1 incident 0件
- Agent申請からreviewまで24時間以内
- Warden false positive 10%未満
- 1回以上の実incident drill成功

## Phase 2 — Agent Dock v1

### Goal

第三者AgentをDiscord Tokenなしで安全に動かす。

### Scope

- safe manifest fetch
- per-agent HMAC credential
- scope enforcement
- signed event envelope
- timeout
- retry ceiling
- circuit breaker
- response sanitizer
- per-agent budget
- audit
- revoke
- Dock Sandbox
- reference agent 1体

### Exit Gate

- allowlist外event流出0件
- Quarantine後のdispatch 0件
- `@everyone` / role mentionが無効化
- replay拒否
- 5xx/timeout時circuit open
- tenant/guild越境test成功
- reference agent 100 run
- successful run率 95%以上
- P95 latencyを計測
- 1 runあたり原価を計測

## Phase 3 — Opt-in proactive AI

### Goal

常時監視を「監視感」ではなく、未回答・詰まり・成果の支援に変える。

### Scope

- Guild/Channel/Thread opt-in
- Message Content intent
- transient classifier
- shadow mode
- derived signal only
- reason display
- suggestion cooldown
- `/mute-ai`
- `/forget`
- operator threshold

### Initial classes

- `none`
- `unanswered_question`
- `blocked`
- `project_idea`
- `achievement`
- `request_for_collaborator`

### Exit Gate

- shadow dataset 100件以上
- precision 90%以上を目標
- false positive 10%未満
- 保存データから元本文を再構成不可
- self-trigger / bot-trigger 0件
- proactive suggestion受容率 20%以上
- mute率 5%未満
- 苦情率 1%未満

閾値を満たさなければ自発返信は有効化しません。

## Phase 4 — Outcome actions

### Goal

回答を外部成果へ変える。

### Scope

- structured action buttons
- Issue作成
- 仕様化
- RepoDeck implementation request
- FlowAlign action
- Pitcheee preview/publish
- collaborator request
- human handoff

### Rule

外部副作用は常に:

```text
preview -> user confirmation -> execute -> evidence -> undo/recovery
```

### Exit Gate

- action成功率 95%以上
- duplicate action 0件
- 全actionにactor/trace/evidence
- destructive actionは100% human approval
- Pitcheee等の外部公開は100%明示確認
- outcome化率 35%以上

## Phase 5 — Reusable NexA platform

### Goal

今回のBotを単発受託から共通基盤へ変える。

### Scope

- multi-guild tenancy
- configurable policy packs
- Slack/Nexa-chat adapter
- capability registry
- enterprise private deployment
- usage metering
- operator console
- portable Agent Passport
- audit export

### Exit Gate

- 3 Guild以上で同一runtimeを利用
- guild越境0件
- 新Guild導入をコード変更なしで実施
- 1つ以上の外部コミュニティ導入
- 1つ以上の企業向け導入候補
- 共通コード比率80%以上

## Priority rule

1. **動く証拠**
2. **安全に止められること**
3. **利用者価値**
4. **第三者Agent**
5. **NexA能力連携**
6. **横展開**

DBやUIを先に膨らませず、各PhaseのExit Gateに必要なものだけ作ります。
