# Телеметрия Skeleton

Локальный стек на aio: **TimescaleDB + Grafana + сборщик**. Данные не покидают aio.

## Запуск

```bash
# на aio, из каталога telemetry
docker compose up -d --build
```

Grafana — `http://127.0.0.1:3000` (admin / `skeleton`), дашборд «Skeleton telemetry».
С ноутбука:

```bash
ssh -L 3000:localhost:3000 aio
# открыть http://localhost:3000
```

Игра с телеметрией — `http://127.0.0.1:18010/?seed=42&telemetry`. Сборщик отдаёт статику игры и принимает
`POST /ingest` на том же origin.

## Что внутри

- `db` — TimescaleDB (Postgres 16), схема из `schema.sql` применяется при первом старте.
- `grafana` — дашборд и datasource провижнятся из `grafana/`.
- `collector` — Node: статика игры, `/ingest`, `/health`, `/api/sessions`; раз в секунду пишет GPU (`nvidia-smi`)
  и CPU/RAM в `host_samples`.

Клиент включается только с `?telemetry`: на GitHub Pages и в `?bench` телеметрия выключена, чтобы не портить
эталон. В секунду пишется кадр (fps, p50/p95/p99/max, рывки, чанки/трава, draw calls, heap, позиция), раз в пять
секунд — батч POST, на выходе — `sendBeacon`.

## Таблицы

- `sessions` — сессия, seed, commit, backend, GPU, viewport.
- `samples` — 1 Гц срезы; hypertable.
- `events` — рывки, ошибки, long tasks, контекст; hypertable.
- `host_samples` — GPU/CPU/RAM раз в секунду; hypertable.
- `bench_runs` — история бенчей.
- `session_summary` — сводка по сессии для таблицы.

Сырые срезы живут 90 дней, хост — 30. `samples_1m` — минутные агрегаты.

## Запросы

```sql
-- сессии за сегодня
SELECT * FROM session_summary WHERE started_at > now() - interval '1 day' ORDER BY started_at DESC;

-- худшие рывки
SELECT ts, kind, ms, data FROM events WHERE kind = 'hitch' ORDER BY ms DESC LIMIT 20;

-- fps и GPU по минутам
SELECT time_bucket('1 minute', s.ts) AS minute, avg(s.fps) AS fps, avg(h.gpu_util) AS gpu
FROM samples s JOIN host_samples h ON h.ts BETWEEN s.ts - interval '1 second' AND s.ts + interval '1 second'
GROUP BY minute ORDER BY minute DESC LIMIT 60;
```

## Порты

`5432` Postgres, `3000` Grafana, `18010` сборщик/игра — все на `127.0.0.1`. Публиковать наружу не нужно:
для ноутбука хватает SSH-туннеля, для Tailscale — при желании поменять bind в compose.
