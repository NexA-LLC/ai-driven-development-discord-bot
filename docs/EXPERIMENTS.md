# Experiment plan

機能を増やす前に、価値・安全・原価を小さく検証します。

## E-001 — Explicit Community AI value

### Hypothesis

`/ask`利用者の20%以上が、回答後に「解決」「artifact化」「次Action選択」のいずれかへ進む。

### Instrumentation

- interaction started/succeeded/failed
- feedback: solved / useful / not useful
- next action selected
- latency
- model/cost
- no raw prompt in analytics

### Pass

- success >= 99%
- useful >= 60%
- outcome >= 20%
- P95 latencyを記録
- active userあたり原価が予算内

### Fail action

汎用回答を増やさず、対象ユースケースを絞る。

## E-002 — User Install distribution

### Hypothesis

ミートアップ参加者の5〜15%がUser Installし、その20%以上が7日以内に再利用する。

### Pass

- install funnelを計測
- first command success >= 95%
- 7-day reuse >= 20%
- uninstall/complaintを記録

### Fail action

「持ち歩けるChatGPT」では差が弱い。Discord固有のartifact/actionへ絞る。

## E-003 — Pitch as a natural route

### Hypothesis

「完成・募集・公開」の明示文脈では、`/pitch`利用者の10%以上がpreviewをコピーし、2〜10%が外部公開を選ぶ。

### Guardrail

Pitcheeeの表示は明示文脈のみ。毎回答に出さない。

### Fail action

Pitcheee導線を強くせず、Discord内募集文・X文面生成の価値を先に改善。

## E-004 — Agent submission demand

### Hypothesis

AI開発ミートアップ層の中から、最初の50 active memberにつき1〜5件のAgent申請が出る。

### Pass

- valid manifest rate >= 70%
- review time <= 24h
- Sandbox runまで到達 >= 30%

### Fail action

Manifestを簡略化し、sample Agent SDK/CLIを作る。

## E-005 — Warden usefulness

### Hypothesis

rate-based signalだけでも accidental bot loopを30秒以内に検知できる。

### Method

test Botで正常burst、slow spam、loopを再現。

### Pass

- loop detection <= 30s
- false positive < 10%
- alert duplicate抑制
- restart/replicaでも検知継続

### Fail action

単一thresholdから、bot/channel/behavior別のpolicyへ移行。

## E-006 — Passive observation shadow mode

### Hypothesis

raw本文を永続化せず、`unanswered_question`等をprecision 90%以上で分類できる。

### Dataset

明示同意したtest channelの100件以上。評価用本文は短期隔離し、評価後削除。

### Pass

- precision >= 90%
- false positive < 10%
- source textをderived recordから再構成不可
- bot-origin/self-trigger 0

### Fail action

自発返信を有効化しない。明示コマンド中心を維持。

## E-007 — Agent Dock safety

### Hypothesis

Native Botより制限されたAgent Dockでも、開発者の主要デモ用途の80%以上を満たせる。

### Pass

- 100 dispatch
- successful response >= 95%
- scope violation 0
- replay acceptance 0
- Quarantine後dispatch 0
- output mention bypass 0

### Fail action

Native Sandboxの範囲を限定的に拡張するが、高権限を標準化しない。

## E-008 — Brand restraint

### Hypothesis

NexA表記を`/about`に留めても、利用者は運営元を認識し、信頼と相談opt-inを得られる。

### Signals

- “誰が作ったか”認知
- NexA相談opt-in
- 広告感の苦情
- retention

### Pass

広告感の苦情 < 1%、相談導線がゼロでない。

## E-009 — Cost routing

### Hypothesis

簡易分類・短い質問はcheap model、複雑な設計だけstrong modelに振ることで、品質を保ちながら原価を50%以上削減できる。

### Pass

- cost/outcome 50%改善
- useful rate低下 < 5pt
- latency悪化なし

## E-010 — “Agent Dock” business signal

### Hypothesis

Community版を動かすと、3〜6か月以内に他Guildまたは企業Slack/Discordへの導入相談が1件以上出る。

### Guardrail

無断営業せず、`/about`・利用者の自発問い合わせ・運営合意の導線だけで測る。
