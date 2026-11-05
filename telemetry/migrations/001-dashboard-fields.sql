-- Add the fields the technical dashboards read. Safe to run more than once.
-- Existing database, from telemetry/:
--   docker compose exec -T db psql -U skeleton -d skeleton < migrations/001-dashboard-fields.sql

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS game text NOT NULL DEFAULT 'skeleton';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS load_ms real;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS first_frame_ms real;
CREATE INDEX IF NOT EXISTS sessions_game_started ON sessions (game, started_at DESC);

DROP VIEW IF EXISTS session_summary;
CREATE VIEW session_summary AS
SELECT s.id,
       s.kind,
       s.game,
       s.started_at,
       s.ended_at,
       s.seed,
       s.commit,
       s.backend,
       s.gpu,
       s.load_ms,
       s.first_frame_ms,
       count(x.ts) AS samples,
       round(avg(x.fps)::numeric, 1) AS fps,
       round(avg(x.p95)::numeric, 1) AS p95,
       round(max(x.max)::numeric, 1) AS max,
       sum(x.hitches) AS hitches
FROM sessions s
LEFT JOIN samples x ON x.session_id = s.id
GROUP BY s.id;
