# Community AI / third-party Bot policy draft

これは運営者レビュー前の叩き台です。

## 1. Community AIについて

このDiscordでは、Community AIが質問への回答、内容整理、ピッチ作成、Agent紹介、Bot安全監視を行う場合があります。

初期設定:

- 明示的なSlash Commandまたはメンションへの応答が中心
- 常時本文分類はOFF
- 生のメッセージ本文はデフォルトで永続保存しない
- 外部公開・Issue作成・人への連絡は明示確認後
- AIの回答は誤る可能性がある
- 運営はBot機能を停止・制限できる

## 2. 外部LLM

AI処理に外部モデル事業者を使う場合があります。

運営は少なくとも次を表示します。

- provider
- 送信対象
- 保存/学習方針
- retention
- 利用停止方法
- 問い合わせ先

secret、非公開channel、個人情報、契約上の機密を不用意に入力しないでください。

## 3. Third-party Agent / Botの掲載

参加者は自作Agent/Botを申請できます。

掲載と実行は別です。

- Listed: 紹介のみ
- User Install: 利用者本人が明示的に利用
- Dock Sandbox: NexA Gateway経由の限定実行
- Native Sandbox: 専用カテゴリのみ
- Trusted: 実績・再審査後の限定展開

## 4. 申請時の必須申告

- App/Agent名
- 開発者・問い合わせ先
- installation mode
- requested permissions
- privileged intents
- triggers/actions
- 保存データ
- retention
- external model provider
- training use
- deletion route
- rate limit
- endpoint/domain
- source/review情報

変更時は再申請が必要です。

## 5. 禁止

- User Tokenの要求・利用
- token/credential窃取
- マルウェア・フィッシング
- 無断DM
- 無断広告
- 無断外部公開
- Discordデータの無断学習利用
- 隠れ人物評価
- moderation回避
- Bot同士の無限自動会話
- permissionの虚偽申告
- Quarantine回避
- 別App IDによるBAN回避
- `@everyone`等の濫用

## 6. 運営措置

運営は状況に応じて次を行えます。

- 警告
- rate制限
- channel scope縮小
- Quarantine
- credential revoke
- Bot remove
- registry ban
- 投稿者/開発者への利用制限
- Discordへの報告

重大なtoken窃取、データ流出、悪意ある権限濫用は即時停止対象です。

## 7. 異議申立て

PassportやQuarantineは安全性の断定ではありません。

開発者は次を提示して再審査を求められます。

- 変更内容
- 修正commit/version
- 権限縮小
- データ削除証拠
- incident原因と再発防止
- test結果

## 8. データ削除

利用者・開発者向けに削除依頼経路を用意します。

削除対象と保持義務が競合する場合は、法令・契約・security incident evidenceの必要最小限を説明します。

## 9. 人物評価の禁止

コミュニティ発言から、採用、信用、融資、保険、適格性などを裏で推定・採点しません。

本人が明示登録した「得意領域」「協業希望」等は、本人の表示・編集・削除を可能にした上で利用します。

## 10. Policy transparency

`/about`または固定channelから以下へ到達できるようにします。

- この方針
- 現在有効な監視範囲
- external provider
- data retention
- installed/approved Agents
- incident contact
- AI mute/opt-out
- deletion request
