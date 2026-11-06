-- Audio health in the play samples: the state of the one AudioContext, device latency, the playback
-- statistics (underrun time and events) and the master level. Safe to run more than once.
--
-- Existing database, from telemetry/:
--   docker compose exec -T db psql -U skeleton -d skeleton < migrations/002-audio.sql

ALTER TABLE samples ADD COLUMN IF NOT EXISTS audio_state text;
ALTER TABLE samples ADD COLUMN IF NOT EXISTS audio_rate integer;
ALTER TABLE samples ADD COLUMN IF NOT EXISTS audio_latency_ms real;
ALTER TABLE samples ADD COLUMN IF NOT EXISTS audio_underrun_ms real;
ALTER TABLE samples ADD COLUMN IF NOT EXISTS audio_underrun_events integer;
ALTER TABLE samples ADD COLUMN IF NOT EXISTS audio_played_ms real;
ALTER TABLE samples ADD COLUMN IF NOT EXISTS audio_stats boolean;
ALTER TABLE samples ADD COLUMN IF NOT EXISTS rms_db real;
ALTER TABLE samples ADD COLUMN IF NOT EXISTS peak_db real;
ALTER TABLE samples ADD COLUMN IF NOT EXISTS audio_muted boolean;
ALTER TABLE samples ADD COLUMN IF NOT EXISTS music_track text;

-- A view cannot gain columns in place, so it is recreated: the audio aggregates join the frame summary.
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
       sum(x.hitches) AS hitches,
       count(x.audio_state) AS audio_samples,
       round((sum(x.audio_played_ms) / 1000)::numeric, 1) AS audio_played_s,
       round(sum(x.audio_underrun_ms)::numeric, 1) AS audio_underrun_ms,
       sum(x.audio_underrun_events) AS audio_underrun_events,
       round((100 * sum(x.audio_underrun_ms) / nullif(sum(x.audio_played_ms), 0))::numeric, 2) AS audio_glitch_pct,
       round(avg(x.audio_latency_ms)::numeric) AS audio_latency_ms,
       bool_or(x.audio_stats) AS audio_stats,
       (SELECT count(*) FROM events e WHERE e.session_id = s.id AND e.kind = 'audio') AS audio_events
FROM sessions s
LEFT JOIN samples x ON x.session_id = s.id
GROUP BY s.id;
