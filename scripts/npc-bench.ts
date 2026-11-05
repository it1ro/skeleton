import { POVITUHA, buildVoicePrompt, interpret, startTalk, talk, type TalkState } from '@skeleton/shared';

/**
 * Measures a real model through the dev proxy: one scripted conversation with Повитуха,
 * played several times. Prints latency percentiles, tokens and money per line.
 *
 *   npm run npc:proxy            # in another terminal, with NPC_LLM_* set
 *   npm run npc:bench
 *   NPC_BENCH_RUNS=5 npm run npc:bench
 */

const PROXY = process.env.NPC_PROXY_URL ?? 'http://127.0.0.1:8788';
const RUNS = Math.max(1, Number(process.env.NPC_BENCH_RUNS ?? 3));

/** A full conversation: reason, price, haggle, deal. Ends when the rules close the talk. */
const SCRIPT = [
  'здравствуй, бабка',
  'хочу вернуть глаза, память о прошлом',
  'что за цена?',
  'дорого просишь, сбавь',
  'дам образ смерти',
];

interface Reply {
  text: string;
  ms: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  priced: boolean;
}

interface Sample {
  text: string;
  reply: Reply;
  wallMs: number;
}

async function voice(prompt: { system: string; user: string }): Promise<Reply> {
  const response = await fetch(`${PROXY}/voice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(prompt),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`proxy ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const data = (await response.json()) as Partial<Reply>;
  if (typeof data.text !== 'string') throw new Error('proxy returned no text');
  return {
    text: data.text,
    ms: data.ms ?? 0,
    tokensIn: data.tokensIn ?? 0,
    tokensOut: data.tokensOut ?? 0,
    costUsd: data.costUsd ?? 0,
    priced: data.priced === true,
  };
}

function percentile(values: number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  return usd < 0.01 ? `$${usd.toPrecision(2)}` : `$${usd.toFixed(3)}`;
}

async function main(): Promise<void> {
  const health = await fetch(`${PROXY}/health`).then(
    (response) => response.json() as Promise<{ model?: string; ok?: boolean }>,
    () => null,
  );
  if (!health?.ok) {
    console.error(`Прокси не отвечает на ${PROXY}. Запусти: npm run npc:proxy`);
    process.exit(1);
  }
  console.log(`Модель: ${health.model ?? '?'} · прогонов: ${RUNS} · реплик в разговоре: ${SCRIPT.length}\n`);

  const samples: Sample[] = [];
  for (let run = 1; run <= RUNS; run++) {
    const opening = startTalk();
    let state: TalkState = opening.state;
    let history = [`Повитуха: ${opening.line}`];
    console.log(`#${run}`);

    for (const text of SCRIPT) {
      const beat = talk(state, interpret(text));
      state = beat.state;
      const started = Date.now();
      try {
        const reply = await voice(buildVoicePrompt(POVITUHA, beat.state, beat, text, history.slice(-6)));
        const wallMs = Date.now() - started;
        samples.push({ text, reply, wallMs });
        history = [...history, `Герой: ${text}`, `Повитуха: ${reply.text}`];
        const cost = reply.priced ? ` · ${formatCost(reply.costUsd)}` : '';
        console.log(`  ${reply.ms} мс · ${reply.tokensIn}→${reply.tokensOut} ток${cost} · «${reply.text.slice(0, 72)}»`);
      } catch (error) {
        console.error(`  ошибка: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
      if (beat.end) break;
    }
    console.log('');
  }

  const ms = samples.map((sample) => sample.reply.ms);
  const wall = samples.map((sample) => sample.wallMs);
  const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
  const tokensIn = sum(samples.map((sample) => sample.reply.tokensIn));
  const tokensOut = sum(samples.map((sample) => sample.reply.tokensOut));
  const cost = sum(samples.map((sample) => sample.reply.costUsd));
  const priced = samples.some((sample) => sample.reply.priced);
  const perTalk = samples.length / RUNS;

  console.log(`Реплик: ${samples.length} (${perTalk} на разговор)`);
  console.log(
    `Модель: p50 ${percentile(ms, 0.5)} мс · p95 ${percentile(ms, 0.95)} мс · среднее ${Math.round(sum(ms) / ms.length)} мс`,
  );
  console.log(
    `Круг клиент→прокси: p50 ${percentile(wall, 0.5)} мс · p95 ${percentile(wall, 0.95)} мс`,
  );
  console.log(`Токены: ${tokensIn} вход / ${tokensOut} выход`);
  if (priced) {
    console.log(
      `Цена: ${formatCost(cost)} за всё · ${formatCost(cost / RUNS)} за разговор из ${perTalk} реплик`,
    );
  } else {
    console.log('Цена: NPC_PRICE_IN / NPC_PRICE_OUT не заданы, считаем только токены');
  }
}

await main();
