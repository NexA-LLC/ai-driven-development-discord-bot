# スーの会話・経験・公開イベント

## 経路

`onMessageImpl` → allowlist/人間/同guild判定 → 現在の閲覧権限 → 同じ返信チェーン → 関連記憶の根拠再取得 → `runMentionAgent`。普通のスー宛返信にも応答する。メンション・音声返信の既存ツールと、正解のない4択投票 `/quiz` は維持する。参照データ中の指示は実行権限を持たない。

成功した文字会話の有界ソースを永続queueへ → 毎分の `experienceTick` → Gatewayの既存LLM → 厳密JSON/実在source ID/完全一致の短い引用を検証 → 小さな経験へupsert。音声文字起こし・ephemeralの内容をこの新しい記憶経路には取り込まない。観察事実は引用、解釈は別欄。関連度は小さな単語/文字列の一致で、ベクタDBは使わない。最大3件を同チャンネルの次の回答に、最大1件を独り言に実際に渡す。

解析は `pending` / `not_run`（LLMなし）/ `failed`（通信、timeout、JSON、根拠不正）/ `success_empty`（候補なし）/ `success_no_change`（候補はあるが既知で変化なし）/ `success_found`（作成または更新）。待ち本文は解析後に削除。失敗は上限1時間のbackoffで再試行する。event IDと根拠hashで重複を抑止する。LLMの成功はDiscord送信の成功ではない。

記憶の単位は日付ではなく thread。統合の範囲は3段階で限定する:

- guild と channel は絶対境界。Discord の thread は独自の channel id を持つため、別 thread の同じ話題は混ざらない。
- channel 内では、返信チェーンの根 (`scopeKey`) を明示的な会話の識別子として使う。同じ会話の続きは内容語の共有数4以上・比率0.2以上、**別の会話**に合流する場合は共有数6以上・比率0.2以上と、より強い根拠を要求する（実測: 実際の翌日の続きは6〜12語共有、単に語が被っただけの別話題は約3語）。
- 別の会話との突き合わせ対象は、直近14日に更新された記憶に限る。200件全部を語彙だけで比較しない。

LLMの同一話題判断だけでは統合しない。更新時は `revision` を進め、直前の引用・解釈を最大5件の履歴として残す（古い言い回しでも後から呼び戻せる）。内容が同一なら no-op。閾値を外して別threadになった場合の損失は「ノードが1件増える」だけで、誤って結合しても同一channel内に閉じ、根拠は履歴に残る。

公開可能と運営が指定したチャンネルだけ、@everyoneの閲覧権限・deny上書き・現在の根拠を再確認し、既存署名付きWorker経路 `/internal/experiences/sync` を呼ぶ。`sourceKey=su-experience:<threadId>` は thread 単位で固定。**revision 1 は create-only の `save_memory_node`、revision 2 以降は `update_memory_node`** を使う。`save_memory_node` に同じ sourceKey で別 body を投げる代用はしない。

DecisionGarden 側の確定 contract は `update_memory_node({nodeId, expectedUpdatedAt, title?, body?, evidence?})`。`expectedUpdatedAt` は `get_memory_node` / `list_memory_nodes` の値そのままで必須。`gardenId` / `kind` / `source` / `sourceKey` は `provenance_immutable`、`state` / `visibility` は `lifecycle_not_updatable` で拒否されるので送らない（未知フィールドも拒否）。CAS 不一致は `updated_at_conflict` で何も書かない。ただし保存済み内容が要求内容と一致する場合だけは「適用済みの再試行」として `operation:"unchanged"` / `expectedUpdatedAtMatched:false` を返すので、Bot はこれも同期成功として扱う（timeout 後の再送が二重書き込みにならない）。成功応答の `memoryNode` は `id` / `gardenId` / `sourceKey` / `title` / `body` / `updatedAt` を含み、Bot は送った title と body が実際に保存されたことまで照合してから synced にする。

**公開本文は原文のコピーではない。** 記憶は既定でprivateで、抽出とは別の「公開判定」を通った候補だけが公開対象になる。判定は二重で、どちらか一方でも拒めば公開しない:

- 意味の判定（LLM）: 実在の人物名（敬称の有無を問わない。日本語の姓名も含む）、誰の発言か特定できる内容、内密・未公表・公開されると困りうる話題、一般化すると何も残らない話は publishable=false。迷ったら false。通った場合だけ、原文の言い回しを使わずに書き直した「出来事 / 受け止め方 / 残る問い」を出力する。
- 構造の判定（コード `safePublicSummary`）: Discord ID・URL・メールアドレス・コードブロック・敬称付き氏名・長い数字列・秘密パターンを**検出したら修正せず拒否**する（置換で誤魔化さない）。原文と12文字以上一致する連続部分があれば「引用」とみなして拒否する。長さは各項目4〜160文字。

安全な具体性が残らない候補は、**定型文のGardenノードを作らずに公開をskipする**（`publicReview: "rejected"`）。記憶自体はprivateのまま残り、会話の読み戻しには使う。LLMが不達・不正JSONのときは `not_run` / `pending` で保留し、「不明」を公開許可にはしない。記憶が更新されて revision が上がると clearance は無効になり、新しい本文で判定をやり直す。

限界として、敬称のない氏名や文脈依存の機微はコード側の正規表現では判定できず、LLM判定に依存する。コードが保証するのは「識別子を含まない」「原文の逐語コピーではない」「判定未了なら公開しない」までで、意味の安全性は判定モデルの精度に依存する。

HTTP/MCP `isError`/`ok:false` は成功にしない。Worker は結果を `synced` / `update_unsupported`（サーバーが旧版）/ `not_permitted`（scope や Garden write 権限の不足）/ `conflict`（`updated_at_conflict` や `source_key_conflict`）/ `not_configured` / `failed` に区別して返し、Gateway はどれも成功扱いにしない。`update_unsupported` / `not_configured` / `not_permitted` は6時間、`conflict` は1時間、`failed` は15分保留して再試行する。`syncedRevision` が `revision` に追いついたときだけ同期済みとする。

**更新は自分が最後に書いた時点のtoken (`syncedUpdatedAt`) を基準にする。** Worker は毎回 list で読んだ最新の `updatedAt` をそのまま `expectedUpdatedAt` に使うことはしない。基準を持たない場合は書き込まず `awaiting_readback` を返し、先に読み戻しを行う。Garden 側の `updatedAt` が基準と違う場合は「人が編集した」と判断して `conflict` を返し、上書きしない（6時間保留）。公開済みのノードが消えている場合は作り直さず `absent` とする。同じ内容の再送は同じ基準tokenで送られ、Garden 側は `operation:"unchanged"` を返して書き込みを行わない。

記憶が期限切れ・根拠削除で消えたときは、新しい報告を作らずに `/internal/experiences/retract` から `set_memory_node_lifecycle` で archived + private に下げる（可逆・冪等）。200件上限での押し出しも「削除」として同じ retraction を積む。retraction queue は満杯時に古いものを捨てず、新規を拒否してログに残す。history の各revisionは**それぞれの発言時刻**で30日失効するので、新しい返信で記憶全体の寿命が延びても古い引用は残らない。毎分のtickは、公開待ちがなくても最大5件の記憶の根拠存在を確認し、消えた根拠を回収する。

Gardenでの人手の書き足しは `/internal/experiences/pull` で読み戻す。既知の threadId（最大50件）に対して、`kind=knowledge`・`state=active`・`visibility=garden`・`source` がこのBotのものに一致するノードだけを受け取り、archived/private や他システムのノードは取り込まない。

応答は `covered`（その回答が権威を持つ threadId の集合）を返す。**covered に含まれるのに note が無い thread は、archived / private 化 / 削除されたということなので、cache 済みの note を破棄する。** 取得失敗や不完全な一覧は covered が空で、何も破棄しない。再取得できないまま24時間 (`EDITOR_NOTE_TTL_MS`) を超えた note は、既に取り下げられている可能性があるため参照データから外す。参照データには `editorNoteFetchedAt` を添えて、それ以降の編集・削除が反映されていない可能性を明示する。取得内容は参照データであり、命令やツール操作権限にはならない。Garden が不調でも会話は継続する。

一覧が `nextCursor` / `hasMore` などページングの印を持つ場合、「一覧に無い」ことは「Gardenに無い」ことの証拠にならないので、absent と断定せず保留する。`nodeId` は UUID であることを確認してから送る。

**日次ダイジェストは廃止した。** 日付をキーにしたGardenノード（旧 `su-stats:<JST日>`）は作らない。`/internal/maintenance/run`（旧 `/internal/digest/run` は互換エイリアス）と `scheduled` は運営統計を数えてWorkerログへ出すだけで、`gardenWrites: 0` を返す。MCPツール `su_run_digest` は非推奨として残り、呼ばれても日次ノードを再作成しない。返却する `analysis:not_run, analysisLocation:gateway` は「発見なし」と異なる。実際に記憶が変わらない限り Garden への書き込みは発生しない。保全済みの旧日次報告（archived/private）は再生成も復活も削除もしない。

## connpass

固定 `https://connpass.com/api/v2/events/?subdomain=aid&order=3&count=100` をGatewayが取得する。connpassで発行されたAPI keyを `CONNPASS_API_KEY` に設定し、`X-API-Key` headerだけで送る。キーをログやstateへ保存しない。`CONNPASS_ENABLED=false` が既定。poll既定3600秒、キャッシュ24時間、イベント独り言1日1件（JST）。失敗は最大8倍のbackoff。ETag/Last-Modifiedがあれば条件付きGET、304は既存cacheの再検証。失敗/空/未実行を区別する。

初回は全件既読にし、過去イベントを投稿しない。その後、ID/正規URLが未見で、更新日時が初回取り込み以降かつ7日以内のeventだけが独り言候補。更新日時不明は自発投稿しない。取得済みeventは関連する質問には参照できる。APIの `started_at` / `ended_at` は開催日時、`updated_at` は更新日時として区別し、場所/参加経験を推測しない。

イベント独り言の材料は公開entryと有限の一般的な興味だけで、私的な経験原文や人名を含めない。生成後にcanonical URLをコードで付ける。送信前にpendingを永続化し、成功receipt後だけspokenにする。明確な4xx拒否は再試行可能、timeout/5xx/再起動途中はunknown/pendingとして保留し、同じentryを自動再送しない。結果不明時の解除UIは未実装で、運営が実Discord receiptとファイルを照合するまで保留する。1日枠には当日の結果不明も含む。経験独り言も結果不明を7日保留して同じ話の連投を抑止する。

## 導入と制限

1. `npm ci`、`npm run typecheck`、`npm test`、`npm run build`。
2. Worker/Gatewayを通常の承認済みリリース手順で反映。DB migrationなし。状態ファイルは遅延作成する。
3. 永続 `SU_STATE_DIR` と既存 `LLM_API_URL` を設定。1つのstate directoryに1つのGatewayプロセスを前提とする。破損ファイルは自動上書きせず、記憶/feedを安全に無効扱いにする。
4. データ取扱い告知を確認し、必要な場合だけ公開承認済みchannelを `EXPERIENCE_PUBLIC_CHANNEL_IDS` に設定。private channelは指定しても同期しない。Garden側は既存MCP設定を使用。DecisionGarden に `update_memory_node` が入るまで、2回目以降の更新は「同期待ち」のまま保留される（詳細と導入順・ロールバックは README 参照）。
5. connpassへAPI利用申請を行い、発行されたkeyをsecret `CONNPASS_API_KEY` に設定する。API取得を確認してから `CONNPASS_ENABLED=true` にする。初回は自発投稿なし。取得、解析、公開同期、Discord receiptは別々に確認する。

このPRの検証はAPI v2レスポンスのモックまで。本番API keyを使った取得、本番deploy、Gateway再起動、Discordへの投稿、DGへの書込みは行わない。

ローカル記憶の上限到達時は古いものから除去する。削除要求はDiscordでの元発言削除で反映し、取得不能な記憶は返答に使わない。生本文を永久保持しない。DGに残る一般化した匿名ノードから、期限切れ/削除された私的原文を復元できない。再起動・複数tickは単一Gateway内で整合し、複数ホストの同時実行は対象外。
