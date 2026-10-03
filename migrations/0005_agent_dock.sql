-- Agent Dock v1 (Issue #3): per-Agent credential version, circuit breaker and
-- dispatch metadata. Per-Agent HMAC secrets are derived from AGENT_DOCK_SECRET
-- and never stored; bumping secret_version revokes the old credential.
-- Dispatched message content is never stored.

ALTER TABLE agent_installations ADD COLUMN secret_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_installations ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_installations ADD COLUMN circuit_opened_at_ms INTEGER;
ALTER TABLE agent_installations ADD COLUMN quarantined_at TEXT;
ALTER TABLE agent_installations ADD COLUMN quarantine_reason TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_installations_submission
  ON agent_installations(submission_id);

CREATE TABLE IF NOT EXISTS agent_dispatches (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('sent', 'failed', 'rejected')),
  reason TEXT,
  http_status INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (installation_id) REFERENCES agent_installations(id)
);

CREATE INDEX IF NOT EXISTS idx_agent_dispatches_rate
  ON agent_dispatches(installation_id, status, created_at_ms);
