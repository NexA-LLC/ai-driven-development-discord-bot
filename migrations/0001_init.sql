PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS guild_policies (
  guild_id TEXT PRIMARY KEY,
  passive_observe_enabled INTEGER NOT NULL DEFAULT 0,
  message_content_storage_enabled INTEGER NOT NULL DEFAULT 0,
  max_external_bot_messages INTEGER NOT NULL DEFAULT 5,
  external_bot_window_seconds INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_submissions (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  submitter_user_id TEXT NOT NULL,
  agent_id TEXT,
  name TEXT,
  description TEXT,
  installation_mode TEXT,
  manifest_url TEXT,
  endpoint TEXT,
  manifest_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'quarantined', 'removed')),
  passport_score INTEGER,
  passport_band TEXT
    CHECK (passport_band IS NULL OR passport_band IN ('green', 'yellow', 'red', 'blocked')),
  passport_reasons_json TEXT,
  reviewer_user_id TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_submissions_guild_agent
  ON agent_submissions(guild_id, agent_id)
  WHERE agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_submissions_guild_status
  ON agent_submissions(guild_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_installations (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sandbox'
    CHECK (status IN ('sandbox', 'trusted', 'quarantined', 'removed')),
  installed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (submission_id) REFERENCES agent_submissions(id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  guild_id TEXT,
  channel_id TEXT,
  message_id TEXT,
  actor_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_events_guild_time
  ON audit_events(guild_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  guild_id TEXT,
  channel_id TEXT,
  subject_id TEXT,
  incident_type TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'resolved', 'false_positive')),
  operator_user_id TEXT,
  resolution_note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_incidents_guild_status
  ON incidents(guild_id, status, created_at DESC);

-- Deliberately no raw_messages table in the initial schema.
-- Message content is processed transiently unless a later, explicit policy migration adds storage.
