-- Incident loop: the Gateway and the Worker record failures here; the
-- 205 relay forwards them to nexa-chat; repeated incidents become GitHub
-- issues for Repo Deck. Detail text is bounded and never contains user
-- conversation content.
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning'
    CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  source TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resolved')),
  notified_ops_at TEXT,
  relayed_at TEXT,
  issue_url TEXT,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_incidents_dedupe_open
  ON incidents(dedupe_key, status);
CREATE INDEX IF NOT EXISTS idx_incidents_relay
  ON incidents(relayed_at, last_seen_at);

-- Feedback loop, part 1: what スー said. Her own text is hers to keep.
CREATE TABLE IF NOT EXISTS reply_logs (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,                 -- ask / pitch / mention / welcome / musing
  guild_id TEXT,
  channel_id TEXT,
  message_id TEXT,                     -- Discord message id of スー's reply (when known)
  requester_user_id TEXT,
  provider TEXT,                       -- gateway / workers-ai / fallback-apology
  model TEXT,
  latency_ms INTEGER,
  ok INTEGER NOT NULL DEFAULT 1,
  reply_text TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reply_logs_message ON reply_logs(message_id);
CREATE INDEX IF NOT EXISTS idx_reply_logs_created ON reply_logs(created_at);

-- Feedback loop, part 2: what people said back to her. Only replies and
-- reactions addressed to スー are stored (SECURITY.md).
CREATE TABLE IF NOT EXISTS feedback_logs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('reply', 'reaction', 'command')),
  guild_id TEXT,
  channel_id TEXT,
  message_id TEXT,                     -- the user's message (reply/command) or reacted message
  in_reply_to_message_id TEXT,         -- スー's message this refers to
  user_id TEXT,
  content TEXT,                        -- reply text / emoji / command text
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_feedback_logs_created ON feedback_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_logs_reply ON feedback_logs(in_reply_to_message_id);
