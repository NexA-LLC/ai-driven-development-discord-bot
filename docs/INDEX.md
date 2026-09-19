# Project control center

このディレクトリは、`ai-driven-development-discord-bot` の「何を作るか」「今どこまでできたか」「何を先に検証するか」を分離して管理するための入口です。

> 現在地: **コード骨格とCIは成立。実Discord・Cloudflare・D1への接続、実運用、第三者Agent dispatchは未完了。**

## 最初に読む順番

1. [CURRENT_STATUS.md](CURRENT_STATUS.md) — 実装済み、未検証、未実装を区別した現在地
2. [PRODUCT_STRATEGY.md](PRODUCT_STRATEGY.md) — コミュニティとNexAの双方にとっての意味
3. [CAPABILITY_AND_INSTALLATION_MODEL.md](CAPABILITY_AND_INSTALLATION_MODEL.md) — User Install / Guild Install / Agent Dock / Native Botの使い分け
4. [ROADMAP.md](ROADMAP.md) — フェーズとExit Gate
5. [`../todos.jsonl`](../todos.jsonl) — 実行タスクの正本
6. [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md) — 起動、停止、デプロイ、事故対応
7. [THREAT_MODEL.md](THREAT_MODEL.md) — 攻撃面とGo-live条件
8. [DECISIONS.md](DECISIONS.md) — 主要設計判断
9. [EXPERIMENTS.md](EXPERIMENTS.md) — 価値と危険性を数値で検証する実験
10. [COMMUNITY_POLICY_DRAFT.md](COMMUNITY_POLICY_DRAFT.md) — 参加者・Bot開発者向けの運用方針案
11. [TODOS.md](TODOS.md) — `todos.jsonl`のスキーマと更新規則

既存の技術文書:

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [SECURITY.md](SECURITY.md)

## Source of truth

情報が衝突した場合は、原則として次の順で扱います。

1. 実行時の観測結果・CI・Discord/Cloudflareの実環境
2. `todos.jsonl` の状態と証拠
3. `CURRENT_STATUS.md`
4. GitHub Issues
5. README / その他の説明文

READMEに「できる」と書かれていても、`CURRENT_STATUS.md`で `deployed=false` または `e2e_verified=false` なら、利用可能とは扱いません。

## 用語

- **Community AI**: 利用者から見える一人格。質問、整理、試作、発信を支援する。
- **User Install**: ユーザー本人に導入され、明示的なInteraction中心で動くDiscord App。
- **Guild Install**: サーバーへ導入され、許可されたGateway Eventやサーバー権限を扱うBot。
- **Agent Dock**: 第三者AgentへDiscord Tokenを渡さず、NexA側が限定イベントだけを中継する仕組み。
- **Native Bot**: 第三者が自分のDiscord Botを直接Guildへ参加させる方式。
- **Passport**: 安全保証ではなく、申告内容と観測結果からリスクを比較表示する仕組み。
- **Warden**: Bot連投・ループ・権限逸脱などを監視し、運営へ停止判断材料を出す仕組み。
- **Derived signal**: 元メッセージを保存せず、`unanswered_question` 等の最小分類だけを残す情報。
