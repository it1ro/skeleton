-- Skeleton local telemetry. Applied once by the TimescaleDB image on first start.
-- Reapply by hand after schema changes: docker compose exec -T db psql -U skeleton -d skeleton -f /docker-entrypoint-initdb.d/001-schema.sql

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  kind text NOT NULL DEFAULT 'play',
  game text NOT NULL DEFAULT 'skeleton',
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  seed integer,
  commit text,
  backend text,
  gpu text,
  width integer,
  height integer,
  pixel_ratio real,
  load_ms real,
  first_frame_ms real,
  user_agent text
);
CREATE INDEX IF NOT EXISTS sessions_game_started ON sessions (game, started_at DESC);

CREATE TABLE IF NOT EXISTS samples (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts timestamptz NOT NULL,
  fps real,
  p50 real,
  p95 real,
  p99 real,
  max real,
  frames integer,
  hitches integer,
  chunks integer,
  grass_tiles integer,
  grass_pending integer,
  chunk_queue integer,
  calls integer,
  triangles bigint,
  heap_mb real,
  x real,
  z real,
  biome text,
  speed real
);
SELECT create_hypertable('samples', 'ts', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS samples_session_ts ON samples (session_id, ts DESC);

CREATE TABLE IF NOT EXISTS events (
  id bigserial,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts timestamptz NOT NULL,
  kind text NOT NULL,
  ms real,
  data jsonb
);
SELECT create_hypertable('events', 'ts', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS events_session_ts ON events (session_id, ts DESC);
CREATE INDEX IF NOT EXISTS events_kind ON events (kind);

CREATE TABLE IF NOT EXISTS host_samples (
  ts timestamptz NOT NULL,
  gpu_util real,
  gpu_mem_mb integer,
  gpu_temp real,
  cpu_load real,
  mem_used_mb integer,
  chrome_rss_mb integer
);
SELECT create_hypertable('host_samples', 'ts', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS bench_runs (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  name text,
  scene text,
  commit text,
  fps real,
  p50 real,
  p95 real,
  max real,
  chunks integer,
  result jsonb
);

CREATE MATERIALIZED VIEW IF NOT EXISTS samples_1m
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 minute', ts) AS bucket,
       session_id,
       avg(fps) AS fps,
       avg(p95) AS p95,
       max(max) AS max,
       count(*) AS samples
FROM samples
GROUP BY bucket, session_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('samples_1m',
  start_offset => INTERVAL '3 days',
  end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');

SELECT add_retention_policy('samples', INTERVAL '90 days');
SELECT add_retention_policy('events', INTERVAL '90 days');
SELECT add_retention_policy('host_samples', INTERVAL '30 days');

CREATE OR REPLACE VIEW session_summary AS
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
