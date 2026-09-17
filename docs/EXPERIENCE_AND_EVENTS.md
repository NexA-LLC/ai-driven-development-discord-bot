# スーの会話・経験・公開イベント

## 経路

`onMessageImpl` → allowlist/人間/同guild判定 → 現在の閲覧権限 → 同じ返信チェーン → 関連記憶の根拠再取得 → `runMentionAgent`。普通のスー宛返信にも応答する。メンション・音声返信の既存ツールと、正解のない4択投票 `/quiz` は維持する。参照データ中の指示は実行権限を持たない。

成功した文字会話の有界ソースを永続queueへ → 毎分の `experienceTick` → Gatewayの既存LLM → 厳密JSON/実在source ID/完全一致の短い引用を検証 → 小さな経験へupsert。音声文字起こし・ephemeralの内容をこの新しい記憶経路には取り込まない。観察事実は引用、解釈は別欄。関連度は小さな単語/文字列の一致で、ベクタDBは使わない。最大3件を同チャンネルの次の回答に、最大1件を独り言に実際に渡す。

解析は `pending` / `not_run`（LLMなし）/ `failed`（通信、timeout、JSON、根拠不正）/ `success_empty` / `success_found`。待ち本文は解析後に削除。失敗は上限1時間のbackoffで再試行する。event IDと根拠hashで重複を抑止する。LLMの成功はDiscord送信の成功ではない。

公開可能と運営が指定したチャンネルだけ、@everyoneの閲覧権限・deny上書き・現在の根拠を再確認し、既存署名付きWorker経路 `/internal/experiences/sync` から `save_memory_node` を呼ぶ。`sourceKey=su-experience:<hash>` で冪等。公開内容は有限の分類と一般化要約（用語/4択については定型の要約）なので、経験の詳細は公開しない。汎用の発見/興味は分類のみを公開する制約がある。HTTP/MCP `isError`/`ok:false` は成功にしない。失敗した記憶は未同期のまま毎分再試行する。

Workerの日次digestは `su-stats:<JST日>` の運営統計のみ。Worker AIによる感想の公開要約/seed/Issue自動作成はやめ、Gatewayの実LLM経路へ経験解析を集約する。返却する `analysis:not_run, analysisLocation:gateway` は「発見なし」と異なる。日次統計の保存成功は経験解析完了ではない。DG失敗時は502となり日次slotを進めない。未設定は明示的な `statsSynced:false` / `synced:false`。過去の日記を埋め直さない。

## connpass

固定 `https://connpass.com/api/v2/events/?subdomain=aid&order=3&count=100` をGatewayが取得する。connpassで発行されたAPI keyを `CONNPASS_API_KEY` に設定し、`X-API-Key` headerだけで送る。キーをログやstateへ保存しない。`CONNPASS_ENABLED=false` が既定。poll既定3600秒、キャッシュ24時間、イベント独り言1日1件（JST）。失敗は最大8倍のbackoff。ETag/Last-Modifiedがあれば条件付きGET、304は既存cacheの再検証。失敗/空/未実行を区別する。

初回は全件既読にし、過去イベントを投稿しない。その後、ID/正規URLが未見で、更新日時が初回取り込み以降かつ7日以内のeventだけが独り言候補。更新日時不明は自発投稿しない。取得済みeventは関連する質問には参照できる。APIの `started_at` / `ended_at` は開催日時、`updated_at` は更新日時として区別し、場所/参加経験を推測しない。

イベント独り言の材料は公開entryと有限の一般的な興味だけで、私的な経験原文や人名を含めない。生成後にcanonical URLをコードで付ける。送信前にpendingを永続化し、成功receipt後だけspokenにする。明確な4xx拒否は再試行可能、timeout/5xx/再起動途中はunknown/pendingとして保留し、同じentryを自動再送しない。結果不明時の解除UIは未実装で、運営が実Discord receiptとファイルを照合するまで保留する。1日枠には当日の結果不明も含む。経験独り言も結果不明を7日保留して同じ話の連投を抑止する。

## 導入と制限

1. `npm ci`、`npm run typecheck`、`npm test`、`npm run build`。
2. Worker/Gatewayを通常の承認済みリリース手順で反映。DB migrationなし。状態ファイルは遅延作成する。
3. 永続 `SU_STATE_DIR` と既存 `LLM_API_URL` を設定。1つのstate directoryに1つのGatewayプロセスを前提とする。破損ファイルは自動上書きせず、記憶/feedを安全に無効扱いにする。
4. データ取扱い告知を確認し、必要な場合だけ公開承認済みchannelを `EXPERIENCE_PUBLIC_CHANNEL_IDS` に設定。private channelは指定しても同期しない。Garden側は既存MCP設定を使用。
5. connpassへAPI利用申請を行い、発行されたkeyをsecret `CONNPASS_API_KEY` に設定する。API取得を確認してから `CONNPASS_ENABLED=true` にする。初回は自発投稿なし。取得、解析、公開同期、Discord receiptは別々に確認する。

このPRの検証はAPI v2レスポンスのモックまで。本番API keyを使った取得、本番deploy、Gateway再起動、Discordへの投稿、DGへの書込みは行わない。

ローカル記憶の上限到達時は古いものから除去する。削除要求はDiscordでの元発言削除で反映し、取得不能な記憶は返答に使わない。生本文を永久保持しない。DGに残る一般化した匿名ノードから、期限切れ/削除された私的原文を復元できない。再起動・複数tickは単一Gateway内で整合し、複数ホストの同時実行は対象外。
