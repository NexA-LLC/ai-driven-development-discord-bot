# Product strategy

## 1. Product thesis

このBotは「AIについて質問できるDiscord Bot」ではありません。

**AI開発コミュニティ内の「聞きたい・作りたい・見せたい・他のAgentを試したい」を、成果物または次の実行へ変えるCommunity AI**です。

価値の順序は次です。

1. その場で役に立つ
2. 会話を成果物へ変える
3. 人・Agent・外部ツールを安全につなぐ
4. 結果としてNexAの能力が実演される

NexAの広告表示は主目的ではありません。

## 2. NexAにとっての意味

### 短期

- AI開発者・起業家・企業担当者が実際に使う公開実証
- Discord Bot案件の納品資産
- Community AI / Agent Dock / Wardenの事例
- 明示的な相談・協業・導入希望だけをNexAへつなぐ入口
- Pitcheeeへ自然に供給されるプロジェクト・募集・成果発表

### 長期Moat

NexAに残すべき資産は会話ログではなく、次の3つです。

1. **Capability Gateway**  
   Discord、Slack、Nexa-chat等から同じAgent能力を呼べる実行基盤。

2. **Agent Trust Layer**  
   Manifest、Passport、scope、rate limit、audit、Quarantineを共通化した安全層。

3. **Outcome Dataset**  
   どの依頼が、回答・仕様・Issue・試作・公開・人へのhandoffのどれで前進したかという匿名集計。

これらは他コミュニティや企業内Discord/Slackへ横展開できます。

## 3. NexAを前面に出しすぎない原則

### 表に出すもの

- Community AIの能力
- データ方針
- 実行前の確認
- 運営・問い合わせ先
- `/about` 内の控えめな「基盤運用: NexA」

### 表に出しすぎないもの

- 毎回答のNexA広告
- NexA製品名の羅列
- 会話からの無断営業
- 参加者を裏でリード・能力・採用候補として採点
- Pitcheeeへの強制遷移

### 製品名ではなく動詞を出す

| 利用者に見せるAction | 内部で使える能力 |
|---|---|
| 整理する | Community AI / FlowAlign |
| 作り始める | GitHub / RepoDeck |
| 試す | Agent Dock |
| 紹介する | Pitcheee |
| 人に相談する | 明示opt-in handoff |
| 止める | Warden / operator control |

## 4. 主要ユーザージャーニー

### A. 技術質問

```text
/ask
  -> 直接回答
  -> 根拠・制約
  -> [最小コード] [Issue化] [詳しい人/Agentを探す]
```

成功条件: 文章が返ることではなく、問題が解消するか次の行動が明確になること。

### B. 作りたい

```text
アイデア
  -> 1画面/1機能のPoCに縮約
  -> 仕様
  -> task
  -> optional implementation request
```

成功条件: 相談から24時間以内に何らかのartifactが残ること。

### C. 見せたい・仲間を集めたい

```text
完成/構想
  -> 15秒pitch
  -> Discord内preview
  -> [コピー] [募集文] [Pitcheeeへ進む]
```

Pitcheeeは、公開・募集・紹介という明示目的がある場合だけ提案します。

### D. 自分のAgentを試したい

```text
Agent manifest提出
  -> Passport
  -> review
  -> Dock Sandbox
  -> measured run
  -> Trusted / Quarantine
```

Native Botを最初から一般チャンネルへ入れるのではなく、User InstallまたはAgent Dockを標準入口にします。

## 5. 「何でもできる」の定義

Botは万能を装わず、能力を3層に分けて返します。

- **今ここでできる**: 回答、要約、仕様、コード案、ピッチ
- **確認後にできる**: 外部投稿、Issue作成、Agent呼出し、人へのhandoff
- **現在できない**: 権限のない操作、金銭・契約決定、自動BAN、無断公開

返答の基本フォーマット:

```text
結論
今できる成果
必要な制約
次に押せるAction（最大3つ）
```

## 6. Product guardrails

- 明示呼出しは高応答、自発発言は低頻度
- 生メッセージ本文はデフォルト非保存
- 外部LLM送信先を開示
- Botの発言を別Botの自動起動条件にしない
- 外部Actionはidempotentかつ監査可能
- destructive actionは人間承認
- 隠れ人物スコアを作らない
- 取得データをモデル訓練に使わない
- 利用者が「なぜ出てきたか」を確認できる
- 運営が即時に無効化できる

## 7. KPI

### North Star

**Community AIが関与した会話のうち、検証可能な成果または次Actionへ進んだ割合**

### Activation

- `/ask` 初回成功率
- `/pitch` 初回成功率
- 初回利用から7日以内の再利用率
- User Install完了率

### Outcome

- 回答→解決自己申告率
- 回答→artifact作成率
- idea→仕様化率
- pitch→コピー/公開/募集率
- Agent申請→Sandbox run率

### Safety

- 不要な自発割込み報告率
- Warden false positive率
- Bot loop検知時間
- Quarantine反映時間
- raw本文保存事故件数
- tenant/guild越境件数
- P0/P1 incident件数

### Economics

- active userあたりAI原価
- successful outcomeあたりAI原価
- Agent runあたり原価
- キャッシュhit率
- 高価モデル使用率

## 8. Anti-metrics

以下を成長指標にしません。

- 総メッセージ監視数
- 保存した会話量
- Botの発言数
- NexAリンクの表示回数
- 無断で作った営業リード数
- 利用者の能力・信用スコア

これらを増やすと、短期数字は増えてもコミュニティの信頼を壊します。

## 9. 逆張り仮説

**NexA名を強く出すより、Community AIが本当に仕事をする方がNexAへの相談率は上がる。**

反証条件:

- 控えめ表示群より明示ブランド群の方が、継続率を落とさず相談opt-inを2倍以上生む
- 広告感に関する否定的フィードバックが増えない

まずは控えめ表示をdefaultにし、ブランド露出はA/Bテストではなく明示的なコミュニティ合意後に検証します。

## 10. 事業化の順序

1. 今回のDiscordで実証
2. 他コミュニティ向けCommunity AIテンプレ
3. Agent Dock / Passportを共通サービス化
4. 企業Discord/Slack向けprivate deployment
5. FlowAlign / RepoDeck / Pitcheee等を能力として追加
6. Discord以外も同じCapability Gatewayへ接続

単発Bot受託で終わらせず、**安全にAgentを持ち込めるコミュニティ基盤**へ育てるのが本命です。
