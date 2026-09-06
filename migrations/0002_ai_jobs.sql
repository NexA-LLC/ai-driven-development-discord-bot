-- AI jobs queue: the Worker accepts /ask and /pitch, stores the order here,
-- and the Gateway process (inside the office network) claims it, runs the
-- in-house LLM, and answers Discord through the interaction webhook.
--
-- The prompt text is stored only until the job is completed or expires; the
-- Gateway clears it on completion so raw conversation text does not persist.

CREATE TABLE IF NOT EXISTS ai_jobs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('ask', 'pitch')),
  input TEXT,
  language TEXT NOT NULL DEFAULT 'ja',
  application_id TEXT NOT NULL,
  interaction_token TEXT NOT NULL,
  ephemeral INTEGER NOT NULL DEFAULT 1,
  guild_id TEXT,
  requester_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'done', 'failed', 'expired')),
  claimed_at TEXT,
  completed_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_jobs_status_created
  ON ai_jobs(status, created_at);
