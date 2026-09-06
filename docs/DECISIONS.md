# Decision log

簡易ADR。状態は `accepted / proposed / superseded / rejected`。

## D-001 — Community value first

- Status: accepted
- Decision: NexA広告ではなく、コミュニティ参加者の成果を最優先する。
- Consequence: NexA名は`/about`等へ控えめに置き、通常回答では宣伝しない。
- Revisit: ブランド表示が継続率を落とさず相談opt-inを明確に改善する証拠が出た時。

## D-002 — One visible persona, many internal capabilities

- Status: accepted
- Decision: 表面は一人格のCommunity AI。内部でanswer/pitch/agent/tool capabilitiesを分離する。
- Reason: 複数Bot人格の混乱、責任境界の曖昧化、bot-to-bot loopを避ける。
- Consequence: 全実行に共通trace/auditが必要。

## D-003 — Support both User Install and Guild Install

- Status: accepted
- Decision: 同じDiscord Applicationで両installation contextを扱う。
- User Install: explicit commandと配布。
- Guild Install: Gateway、monitoring、operator controls。
- Consequence: command/context/permission testを分ける。

## D-004 — Interactions via Worker, Gateway via persistent process

- Status: accepted
- Decision: HTTP InteractionはCloudflare Worker、Guild message eventはNode Gateway。
- Reason: public HTTPS・D1・bursty workとpersistent WebSocketの責任分離。
- Consequence: HMAC境界、versioning、health、retryが必要。

## D-005 — No raw Discord message persistence by default

- Status: accepted
- Decision: D1はcontrol planeとmetadataに限定。
- Consequence: RAGや検索より先に、derived signalと明示opt-inを設計する。
- Revisit: 利用者・運営の明示合意、retention/deletion、必要性の証拠が揃った時。

## D-006 — Agent Dock is the preferred third-party path

- Status: accepted
- Decision: Community-built AgentはNative BotよりUser Install/Agent Dockを優先。
- Reason: Discord Token・権限・event scopeを第三者へ渡さず強制できる。
- Consequence: Dispatcher、credential、sanitizer、QuarantineがMoatになる。

## D-007 — Native Bots are staged, not freely trusted

- Status: accepted
- Decision: Listed → User Install/Dock → Native Sandbox → Trusted。
- Consequence: high-risk permissionはauto-install blocker。例外は個別threat review。

## D-008 — Human moderation authority first

- Status: accepted
- Decision: Phase 0/1で自動BAN/Kickをしない。
- Reason: false positiveと不可逆なコミュニティ事故を避ける。
- Consequence: Wardenは検知・証拠・Quarantine補助に集中。

## D-009 — Pitcheee is contextual and opt-in

- Status: accepted
- Decision: 「見せたい・募集したい・公開したい」時だけ導線を出す。
- Consequence: まずDiscord内previewを返し、外部公開は明示確認後。

## D-010 — Passive observation starts in shadow mode

- Status: accepted
- Decision: 自発返信前に100件以上のshadow datasetで精度評価。
- Exit: false positive < 10%、保存内容から本文再構成不可。
- Consequence: Message Content intentはPhase 0必須ではない。

## D-011 — D1 is the control-plane database

- Status: accepted
- Decision: policy、registry、audit、incidentをD1へ。
- Non-goal: 全会話の永久保存。
- Consequence: realtime rate stateはDurable Object等を別検討。

## D-012 — `todos.jsonl` is the execution source of truth

- Status: accepted
- Decision: tasks、依存、Exit Gate、証拠をmachine-readable JSONLで管理。
- Consequence: GitHub Issueは外部協働UI。状態衝突時は証拠付きJSONLを更新。

## D-013 — No external side effect without evidence

- Status: accepted
- Decision: 「実行済み」は外部object ID/URL/response等の証拠がある場合のみ。
- Consequence: tool resultをauditへ保存し、AI文章だけでdoneにしない。

## D-014 — Existing NexA host for Phase 0, production host deferred

- Status: proposed
- Decision: Phase 0 Gatewayは既存常駐機で最短実証し、本番hostはuptime/ops/costで決める。
- Risk: 単一機障害、個人端末依存。
- Revisit: Phase 0 E2E後。

## D-015 — Passport is risk communication, not certification

- Status: accepted
- Decision: self-declared / reviewed / enforced / observedを分離表示。
- Consequence: “safe”の断定を避け、bandと理由と検証レベルを表示。
