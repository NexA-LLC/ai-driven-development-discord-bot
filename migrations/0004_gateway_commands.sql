-- Commands for the Gateway, queued by the Worker (e.g. from the MCP endpoint):
-- "muse now", "say this in that channel". Claimed and completed like ai_jobs.
CREATE TABLE IF NOT EXISTS gateway_commands (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('muse', 'say')),
  payload_json TEXT NOT NULL,
  requested_by TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'done', 'failed', 'expired')),
  result TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at TEXT,
  completed_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gateway_commands_status ON gateway_commands(status, created_at);
