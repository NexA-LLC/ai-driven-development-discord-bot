# Capability and installation model

## 結論

4方式を混同しないことが重要です。

| 方式 | 誰が導入 | 主な入力 | 常時監視 | 権限 | 標準用途 |
|---|---|---|---:|---|---|
| User Install | 個人 | Slash command / explicit interaction | No | 小 | Community AIを持ち歩く |
| NexA Guild Install | サーバー運営 | Gateway event / mention | Yes | 中・限定 | 監視、Warden、server-wide capability |
| Agent Dock | 運営承認後、NexA Gatewayが接続 | allowlisted event envelope | 条件付き | Discord権限なし | 第三者Agentの安全な実験 |
| Third-party Native Bot | サーバー運営 | 任意のDiscord event | Yes | Bot次第 | 例外的な専用機能 |

## 1. User Install

### 向いていること

- `/ask`
- `/pitch`
- `/about`
- ユーザー本人が自分の別サーバーでも使う
- 明示操作だけで完結する能力

### 向いていないこと

- 全チャンネル監視
- 未回答質問の自動検知
- サーバー全体のBot Warden
- role/channel管理
- 運営判断

### Product value

最も低リスクな配布導線です。参加者がCommunity AIを自分のアカウントに導入すれば、NexAの広告を出さなくても別サーバーへ能力が広がります。

## 2. NexA Guild Install

### 向いていること

- allowlisted channelのGateway event
- メンション応答
- opt-in passive observation
- Bot連投・ループ監視
- operator alert
- Guild policyの適用

### Permission baseline

初期は次のみを候補にします。

- View Channel: 許可カテゴリのみ
- Send Messages
- Read Message History: 必要な場合のみ
- Use Application Commands
- Send Messages in Threads: thread利用時のみ

初期版では付けません。

- Administrator
- Manage Guild
- Manage Roles
- Manage Channels
- Manage Webhooks
- Ban Members
- Kick Members
- Moderate Members
- Mention Everyone

Message Contentは、メンション応答だけならDiscordの例外で本文を受け取れるケースがあります。サーバー全体の内容分類にはPrivileged Intentが必要になるため、Phase 0ではOFFのままメンションE2Eを確認し、Phase 1のshadow modeで初めてONを検討します。

## 3. Agent Dock

### 目的

第三者AgentへDiscord Bot Tokenを渡さず、NexA側が次を強制します。

- event scope
- guild/channel/thread scope
- context上限
- request rate
- timeout
- retry上限
- output長
- mention無効化
- audit
- revoke / Quarantine

### Event envelope案

```json
{
  "schema_version": "1",
  "event_id": "uuidv7",
  "agent_id": "sample-agent",
  "trigger": "direct_mention",
  "guild_id": "discord-snowflake",
  "channel_id": "discord-snowflake",
  "thread_id": null,
  "actor": {
    "opaque_id": "guild-scoped-hash"
  },
  "content": {
    "text": "explicitly scoped input only",
    "attachments": []
  },
  "policy": {
    "max_output_chars": 1900,
    "allow_mentions": false,
    "allow_external_actions": false
  },
  "issued_at": "RFC3339",
  "expires_at": "RFC3339",
  "trace_id": "uuidv7"
}
```

外部Agentの応答は直接Discordへ投稿させず、NexA Gatewayが検査して投稿します。

### 初期trigger

- `direct_mention`
- `manual_dispatch`
- `opted_in_thread`

初期段階では「全メッセージ」「他Botの出力」「DM全体」を渡しません。

## 4. Third-party Native Bot

Native Botは完全禁止ではありません。ただし標準入口にはしません。

### Admission ladder

1. **Listed**: 紹介カードだけ掲載
2. **User Install**: 個人が明示的に呼ぶ
3. **Dock Sandbox**: 限定eventをNexA Gateway経由で渡す
4. **Native Sandbox**: 専用カテゴリだけ閲覧・投稿
5. **Trusted**: 実績後、指定チャンネルだけ許可

### Native Botの最低条件

- Application IDと運営者連絡先
- requested permission一覧
- Privileged Intent一覧
- 取得データ・保持期間
- 外部LLM送信先
- model training有無
- deletion/contact経路
- rate limit
- incident時の停止方法
- 変更時の再申請

### 即時Reject候補

- Administrator要求
- 無断DM
- Bot TokenやUser Tokenの提出要求
- Discordデータの訓練利用
- 利用目的不明の本文保存
- 削除経路なしの長期保存
- role/webhook/channel管理を通常機能として要求
- `@everyone`/`@here`の自由利用
- 自動で別Botを呼ぶ設計

## 5. Decision tree

```text
その能力は明示コマンドだけで成立する?
  Yes -> User Install
  No
   |
   +-- Discordの常時eventが必要?
         No -> Agent Dock manual dispatch
         Yes
          |
          +-- Discord権限を第三者へ渡さず実装できる?
                Yes -> Agent Dock
                No
                 |
                 +-- 高権限が本当に必要?
                       No -> Native Sandbox
                       Yes -> 原則Reject / 個別threat review
```

## 6. 一人格・複数Capability

利用者から見えるBotは原則一人格にします。

```text
Community AI
  -> answer capability
  -> pitch capability
  -> agent registry capability
  -> issue capability
  -> FlowAlign capability
  -> RepoDeck capability
```

内部Agentが増えても、表に大量の人格を並べません。これにより、誰が何を実行したか、どの権限で動いたかを一つのaudit trailに集約できます。

## 7. Bot-to-bot policy

- Bot投稿はAIの自動triggerにしない
- 明示handoff時のみAgent間通信
- `max_hops=1`から開始
- 同一traceの再入を拒否
- outputにBot mentionを残さない
- cost budget超過で即停止
- loop検知時はQuarantineを優先

## 8. 運営権限

初期は次の3操作を人間が持ちます。

- Approve
- Quarantine
- Remove / Registry Ban

自動BANはPhase 0/1では行いません。Botを消しても外部に送られたデータは回収できないため、権限分離と事前scopeの方が重要です。
