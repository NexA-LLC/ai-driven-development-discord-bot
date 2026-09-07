# Security and moderation policy

## Core rule

**Publishing is open; execution is staged; privileges are least-possible; operators can revoke access.**

A BAN is not a data-loss prevention control. Once an external native bot has read and exported a message, removing it from the Guild cannot retrieve that data. Therefore prevention and isolation are more important than post-incident punishment.

## Admission tiers

| Tier | Meaning | Default |
|---|---|---|
| Listed | Manifest/card may be shown | Open after basic abuse checks |
| User Install | Explicit slash-command use | Preferred low-risk entry |
| Agent Dock Sandbox | Events are filtered by the NexA gateway | Preferred for community-built agents |
| Native Guild Bot Sandbox | Bot joins only isolated channels | Manual review |
| Trusted | Limited general-channel access | Earned after operating history |

## Automatic blockers

The initial Passport marks an agent `blocked` when it declares any of:

- `ADMINISTRATOR`
- `MANAGE_GUILD`
- `MANAGE_ROLES`
- `MANAGE_CHANNELS`
- `MANAGE_WEBHOOKS`
- `BAN_MEMBERS`
- `KICK_MEMBERS`
- `MODERATE_MEMBERS`
- `MENTION_EVERYONE`
- training with Discord data

This is an auto-install rule, not a claim that every moderation product using those permissions is malicious. A genuinely required high-privilege integration must be handled as a separate, named exception with an operator-owned threat review.

## Content policy

Initial defaults:

- no raw message persistence;
- no hidden people scoring;
- no employment/credit/eligibility inference from Discord activity;
- no unsolicited DMs;
- no model training with Discord data;
- no external publication without explicit user action;
- no AI reply to another bot;
- no automatic moderation punishment.

## Warden behavior

The Gateway tracks message timestamps per external bot in allowlisted channels.

Default signal:

```text
more than 5 messages in 30 seconds
```

On threshold breach it:

1. writes an incident to D1;
2. posts to the moderator alert channel;
3. enters a cooldown to avoid alert floods;
4. does not automatically Kick/BAN.

This catches accidental loops but is not sufficient for malicious content, phishing, compromised webhooks, or slow exfiltration.

## Operator response

### Quarantine

- remove the bot's access to public channels;
- keep an incident record;
- preserve only the minimum evidence needed;
- disable Agent Dock dispatch credentials.

### Remove

- Kick/remove the Guild-installed app;
- inspect and remove its webhooks;
- inspect roles or channels it created;
- revoke OAuth/integration credentials;
- request deletion from the external operator if content was retained.

### Registry ban

Track at least:

- Discord application ID;
- bot user ID;
- developer account/contact;
- endpoint domain;
- reason and evidence;
- expiry/review date.

Do not create a public accusation list by default. Public claims require evidence and a defined appeal process.

## Agent Dock dispatch requirements before production

The repository does not yet dispatch events to arbitrary third-party endpoints. Before enabling it, implement:

- unique per-agent HMAC secret;
- secret rotation and immediate revoke;
- event and channel scopes;
- maximum context count;
- request timeout under 10 seconds;
- retry ceiling and dead-letter handling;
- response size limit;
- mention neutralization;
- URL and attachment scanning;
- circuit breaker;
- per-agent audit trail;
- deletion request workflow.

## Secret handling

Never commit:

- Discord bot token;
- Discord public/private credentials other than the public application key where policy permits;
- AI provider keys;
- HMAC shared secrets;
- third-party Agent Dock credentials.

Use Cloudflare secrets for Worker production and a secret manager or protected environment for the Gateway host.

## Incident priorities

- **P0**: token compromise, mass deletion, mass DM, credential theft.
- **P1**: data exfiltration, malicious links, permission escalation.
- **P2**: bot loop, high-volume spam, repeated policy violation.
- **P3**: noisy but non-malicious behavior.

P0/P1 should disable the integration immediately. P2 normally starts with Quarantine unless evidence shows deliberate abuse.

## 公開リポジトリで扱う値

このリポジトリは public です。次の値はコミットして構いません（公開情報）。

- Discord Application ID、Discord Public Key（署名検証用の公開鍵）
- Cloudflare D1 の database_id、Worker の名前と workers.dev の URL
- コマンド定義、Passport の評価ルール

次の値は絶対にコミットしません。`.env` / `.dev.vars` は `.gitignore` 済みで、本番値は `wrangler secret` と常駐ホストの環境変数にだけ置きます。

- `DISCORD_BOT_TOKEN`、`INTERNAL_SHARED_SECRET`、`AI_API_KEY` / `LLM_API_KEY`
- 社内 LLM のホスト名や IP（`.env.example` はプレースホルダーのままにする）
- 運営チャンネル ID など、公開すると標的になりやすい運用値

CI では gitleaks で履歴と差分を走査し、GitHub の Push Protection を有効にしています。

## 返答ログとフィードバックの保存範囲（2026-09-07）

改善ループのために、次を D1 に保存します。

- スー自身の返答（本文、イベント種別、モデル、所要時間、成否）: `reply_logs`
- スーの投稿への人の反応: Discord の「返信」で向けられた本文、`#スーの独り言` での発言、スーの投稿へのリアクション、`/feedback` の本文: `feedback_logs`
- 障害の記録（種別、要約、回数、詳細メッセージ）: `incidents`。会話本文は含めません

保存しないもの（従来どおり）: スーに向けられていない通常の会話本文、`/ask` `/pitch` の入力本文（完了時に消去）。
運営チャンネル（店長室）への通知と nexa-chat への中継にも会話本文は載せません。
