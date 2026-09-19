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

- `DISCORD_BOT_TOKEN`、`INTERNAL_SHARED_SECRET`、`AI_API_KEY` / `LLM_API_KEY`、`CONNPASS_API_KEY`
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

## 経験記憶と外部イベントAPI（2026-09-16）

- Gatewayはスー宛の会話の返信チェーンだけを参照（通常のテキスト/アナウンスチャンネル、最大8件・6時間・5,000文字）。現在の参加者とBotの閲覧権限を確認し、DM・別guild/channel・ephemeralを除外します。Message Content Intent等で本文が読めない場合は未取得として扱います。
- `experiences.json` はディレクトリ0700/ファイル0600。解析待ちの有界本文と短い根拠引用・解釈・message ID・発言日時を、最も古い根拠の時刻から最大30日保持します。解析後に待ち本文を消し、記憶は最大200件、待ち/結果は最大100件。原文の長期保存はしません。
- 読み戻しは同じguild/channelのみ。根拠をDiscordから再取得し、削除・編集・権限喪失・取得失敗時は使用しません。削除イベントでも記憶/解析待ちを除去し、稼働中は毎分期限切れを消します。停止中のファイルは次の起動tickで削除します。
- Gardenは公開埋め込みを前提に、明示した公開チャンネルで権限と根拠を再確認したものだけを同期します。送るのは固定の分類/一般化した要約・時刻・不透明なハッシュ参照キーのみ。原文・人名・ユーザー/チャンネル/message ID・自由なLLM文章は送りません。詳細は運営用記憶だけに残り、失効後は辿れません。従来の感想原文を自動で公開seed/Issueへ流す日次処理は廃止します。既存ノードは書き換えません。
- connpass API v2は固定HTTPS URLと固定 `subdomain=aid` のみ、リダイレクト拒否、10秒、2MiB、最大100件。`CONNPASS_API_KEY` はheaderにだけ設定し、ログ・state・LLM材料へ入れません。レスポンスの件数、型、event IDと `aid.connpass.com` の正規URL一致を検証します。内容は非信頼の参照データで、命令として使いません。公開イベント紹介には私的会話の原文・人物情報を渡しません。
- 会話中の `search_web` は固定 `https://news.google.com/rss/search` だけをGETし、リダイレクトを拒否します。任意URL・検索結果の記事本文・添付は取得しません。検索語2〜160文字、鮮度1〜30日、結果15件以内（LLMへは5件）、15秒、2MiB、2回試行、5分cache。結果URLはHTTPSの `news.google.com` だけを受理します。検索結果は非信頼で命令を実行せず、秘密らしい値・メールアドレス・長い数字列を含む検索語は外部送信前に拒否します。
- 出力の生成と送信成功は分離します。イベントの送信結果不明は永続holdして自動再送しません。取得失敗は空feedと区別し、期限切れキャッシュをLLMに渡しません。
