# `todos.jsonl` guide

## 1. Purpose

`todos.jsonl` は、実装・運用・検証・法務・事業仮説を同じ依存グラフで管理するmachine-readable backlogです。

READMEやIssueに書いただけで消えるタスクを防ぎます。

## 2. Record types

### `meta`

ファイルschemaと状態定義。

### `task`

実行単位。1行1 JSON object。

主なfield:

| Field | Meaning |
|---|---|
| `id` | UUIDv7 |
| `key` | 人間向け安定キー `ADD-###` |
| `title` | タスク名 |
| `status` | `done / next / planned / blocked / parked / cancelled` |
| `priority` | `P0 / P1 / P2 / P3` |
| `phase` | Roadmap phase |
| `area` | product/discord/cloudflare/security等 |
| `depends_on` | 依存するtask key |
| `objective` | なぜ必要か |
| `acceptance` | 完了条件 |
| `evidence` | 実装・CI・外部objectの証拠 |
| `blocker` | blocked理由 |
| `risk` | 未実施時の主要リスク |
| `next_action` | 次の具体行動 |
| `issue` | GitHub Issue番号 |
| `owner` | owner。未割当は`unassigned` |
| `created_at` / `updated_at` | RFC3339 |

## 3. Status rule

### done

次を満たす場合だけ。

- acceptanceがすべて成立
- evidenceがある
- 外部実行ならobject ID/URL/observed resultがある
- 「コードを書いた」だけでE2E taskをdoneにしない

### next

他のP0より先に実行すべき、依存が概ね解消したタスク。

### planned

価値はあるが、前PhaseのExit Gate後。

### blocked

外部credential、権限、decision、依存task等で進められない。

### parked

仮説が弱い、または今作るとscope creepになる。

## 4. Priority rule

- **P0**: 起動、安全、データ漏洩、費用暴走、E2E証明
- **P1**: beta価値、運営、Agent Dock安全
- **P2**: outcome action、NexA capability、拡張
- **P3**: 横展開、事業化、最適化

## 5. Dependency rule

- 循環依存を作らない
- blocked taskはblockerを明記
- Phase 2 taskをPhase 0 taskの前提にしない
- GitHub Issue番号だけを依存IDにしない
- `key`はrenameしても再利用しない

## 6. GitHub Issuesとの同期

- `next` / `blocked` で人間協働が必要なtaskはIssue化
- Issue titleに`[ADD-###]`を付ける
- Issue close時にJSONLを自動でdoneにしない
- evidence確認後にJSONL更新
- 既存Issue #1〜#3は対応taskへ紐付け済み

## 7. Review cadence

各実装turnの最後に:

1. 完了taskのevidence更新
2. 新規blocker追加
3. `next`は最大3〜5件
4. scope creepは`parked`
5. `CURRENT_STATUS.md`と矛盾があれば修正
6. Phase Exit Gateを再評価

## 8. Suggested tooling

将来追加するscript:

```bash
npm run todos:validate
npm run todos:list -- --status next
npm run todos:graph
npm run todos:sync-issues
```

validatorで確認するもの:

- JSONL parse
- unique `id` / `key`
- valid status/priority
- dependency existence
- no dependency cycle
- done task has evidence
- blocked task has blocker
- next count threshold
