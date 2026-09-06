# デプロイ手順

実際のDiscordサーバーで動かすまでの運用手順です。設計背景は [`ARCHITECTURE.md`](ARCHITECTURE.md)、安全側の方針は [`SECURITY.md`](SECURITY.md) を参照してください。

## どこに何を置くか

| コンポーネント | 置き場所 | 理由 |
|---|---|---|
| `src/worker` (Interactions / 内部API) | Cloudflare Workers | Discordの `/interactions` はHTTP POSTなので常駐プロセス不要。D1が同じ境界にある |
| D1 | Cloudflare D1 | Workerからのみ参照 |
| `src/gateway` (常時接続Bot / Warden) | Heroku などのコンテナ実行環境 | discord.js のGateway接続はWebSocketを張り続けるプロセスが必要 |

**Gateway を Cloudflare Workers に載せることはできません。** Workerはリクエスト単位の実行モデルで、常時WebSocketクライアントを維持できないためです。したがって構成は必ず「Worker (Cloudflare) + Gateway (Heroku等)」の2箇所になります。Cloudflare側だけで完結させたい場合はDurable Objectsを使う別実装が必要で、現時点では未対応です。

Gatewayは受信ポートを持たない外向き接続専用プロセスなので、Heroku以外にも Fly.io / Railway / Render / 任意のVPS上のDockerで同じ `Dockerfile.gateway` が使えます。

## 0. 事前準備

- Cloudflareアカウントと `npx wrangler login`
- Heroku CLI と `heroku login`
- Discord Developer Portal のApplication
- 検証用のDiscordサーバー（本番コミュニティとは別に用意することを推奨）

先にローカルで検証を通しておきます。

```bash
npm install
npm run typecheck
npm test
npm run build
```

## 1. D1を作る

```bash
npx wrangler d1 create ai-driven-development-discord
```

出力された `database_id` を `wrangler.jsonc` に反映します。初期値の `00000000-0000-0000-0000-000000000000` はプレースホルダで、**置き換えないとデプロイは通っても実行時にDBアクセスが失敗します。**

```bash
npx wrangler d1 migrations apply ai-driven-development-discord --local
npx wrangler d1 migrations apply ai-driven-development-discord --remote
```

## 2. Worker secretsを入れる

Gatewayと共有するHMAC鍵を先に生成しておきます。

```bash
openssl rand -hex 32   # INTERNAL_SHARED_SECRET として両側に同じ値を設定する
```

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY      # Portal の General Information > Public Key
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put INTERNAL_SHARED_SECRET
npx wrangler secret put AI_API_KEY              # AI応答を使う場合のみ
```

`AI_API_URL` / `AI_MODEL` / `PITCHEEE_URL` / `COMMUNITY_NAME` は秘密ではないので `wrangler.jsonc` の `vars` に書きます。`AI_API_URL` / `AI_API_KEY` / `AI_MODEL` のいずれかが未設定の場合、`/ask` と `/pitch` はLLMを呼ばず定型のフォールバック応答を返します。AIなしでも起動確認は進められます。

## 3. Workerをデプロイする

```bash
npm run deploy:worker
curl -s https://<worker-domain>/health
```

`/health` が `{"ok":true,...}` を返すことを確認します。ここが通らない状態でPortalにEndpoint URLを登録しても検証に失敗します。

## 4. Discord Developer Portal を設定する

1. **Installation** で User Install と Guild Install の両方を有効化
2. **Interactions Endpoint URL** に `https://<worker-domain>/interactions` を設定して保存
   - 保存時にDiscordがEd25519署名付きのPINGを送ります。`DISCORD_PUBLIC_KEY` が未設定・別Applicationの値だとここで弾かれます
3. **Bot** タブでBotを作成し、検証サーバーへ招待
4. **Message Content Intent は既定のまま無効**にします
   - 無効でも、Botがメンションされたメッセージの本文はDiscordから配信されるため、メンション応答は動作します
   - Warden の連投検知はメッセージ本文ではなく件数だけを見るため、本文なしで成立します
   - `PASSIVE_OBSERVE=true` を使う段階になって初めて有効化を検討します

## 5. Slash commandを登録する

```bash
DISCORD_APPLICATION_ID=... \
DISCORD_BOT_TOKEN=... \
DISCORD_GUILD_ID=<検証サーバーID> \
npm run commands:register
```

`DISCORD_GUILD_ID` を付けると検証サーバーのみに即時反映されます。外すとグローバル登録になり、反映に時間がかかります。**最初は必ずGuild限定で登録してください。**

## 6. GatewayをHerokuへデプロイする

`heroku.yml` はコンテナビルド定義です。Gatewayは受信ポートを bind しないため、`web` ではなく `worker` プロセスとして起動します（`web` にすると `$PORT` を listen せず R10 Boot timeout で落ちます）。

```bash
heroku create <app-name>
heroku stack:set container -a <app-name>

heroku config:set -a <app-name> \
  DISCORD_BOT_TOKEN=... \
  WORKER_INTERNAL_URL=https://<worker-domain> \
  INTERNAL_SHARED_SECRET=<手順2と同じ値> \
  MONITORED_CHANNEL_IDS=<チャンネルIDをカンマ区切り> \
  WARDEN_ALERT_CHANNEL_ID=<運営チャンネルID> \
  ENABLE_MESSAGE_CONTENT_INTENT=false \
  PASSIVE_OBSERVE=false \
  ALLOW_MENTIONS_ANYWHERE=false

git push heroku <branch>:main
heroku ps:scale worker=1 -a <app-name>
heroku logs -t -a <app-name>
```

起動ログに `Gateway ready as <bot-tag>; passiveObserve=false; monitoredChannels=N` が出れば接続成功です。

注意点:

- `INTERNAL_SHARED_SECRET` がWorker側と1文字でも違うと `/internal/ask` が401になり、メンション応答だけが無言で失敗します
- Workerは受信タイムスタンプの±5分ずれを拒否します。実行環境の時刻がずれている場合は同期してください
- Herokuのdynoは日次で再起動します。プロセス再起動時にdiscord.jsが再接続するため通常は問題ありませんが、`botRateState` はメモリ上のため再起動でリセットされます
- Herokuに無料dynoはありません。常時接続なので課金対象です

## 7. Discordサーバーでの受け入れ確認

Phase 0 相当の確認項目です。すべて検証サーバーで行います。

- [ ] `/about` がephemeralで返る
- [ ] `/ask prompt:...` が返る（`public:true` で公開投稿になる）
- [ ] `/pitch idea:...` が返る
- [ ] `/agents` が承認済みAgent一覧（初期は空）を返す
- [ ] `/agent-submit manifest_url:https://...` が受理され、D1に行が入る
- [ ] allowlistチャンネルでのメンションに応答する
- [ ] allowlist外チャンネルでのメンションには応答しない（`ALLOW_MENTIONS_ANYWHERE=false`）
- [ ] 他のBotの発言にAIが応答しない
- [ ] テスト用Botで `WARDEN_WINDOW_SECONDS` 内に `WARDEN_MAX_MESSAGES` 超の連投をすると、運営チャンネルにWarden警告が出る
- [ ] 自動BAN / Kick / ロール変更が一切起きない

D1の中身は次で確認できます。

```bash
npx wrangler d1 execute ai-driven-development-discord --remote \
  --command "select * from agent_submissions order by created_at desc limit 5"
```

## 8. 停止とロールバック

| やりたいこと | コマンド |
|---|---|
| Gatewayを止める（Botをオフラインに） | `heroku ps:scale worker=0 -a <app-name>` |
| Workerを前バージョンへ戻す | `npx wrangler rollback` |
| Slash commandを外す | Portalから削除、またはGuild登録を空配列で再登録 |
| 監視チャンネルを絞る | `heroku config:set MONITORED_CHANNEL_IDS=... -a <app-name>` |

Botそのものをサーバーから外すのが最も確実な緊急停止です。

## 9. 本番コミュニティへ広げる前に

- 検証サーバーで上記チェックが全部通っていること
- `MONITORED_CHANNEL_IDS` を本番の1チャンネルだけに限定すること（Phase 1）
- シークレットローテーション手順を運営で共有すること
- 誤割込み率と運営負荷を計測してから権限を広げること

現時点では、第三者Agentへの本番イベントdispatch、管理Web UI、Discord上の承認ボタン、自動Quarantineは未実装です。これらを前提とした運用は行わないでください。
