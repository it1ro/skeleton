import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Dev-only voice proxy for the NPC spike. The browser never sees a model key.
 *
 *   npm run npc:proxy
 *   NPC_MODEL=qwen2.5:3b npm run npc:proxy
 *   NPC_LLM_URL=https://api.example.com/v1/chat/completions NPC_LLM_KEY=... npm run npc:proxy
 *
 * Any OpenAI-compatible endpoint works; the default is a local Ollama. Without a model the client
 * falls back to the authored lines, so the game never depends on this process.
 */

// Keys live in a git-ignored .env.npc next to the repo root; real environment variables win over it.
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env.npc', import.meta.url)));
} catch {
  // No key file: the proxy runs on the environment as is.
}

const PORT = Number(process.env.NPC_PROXY_PORT ?? 8788);
const UPSTREAM = process.env.NPC_LLM_URL ?? 'http://127.0.0.1:11434/v1/chat/completions';
const MODEL = process.env.NPC_MODEL ?? 'qwen2.5:3b';
const KEY = process.env.NPC_LLM_KEY ?? '';
const MAX_BODY = 64 * 1024;
/** USD per 1M tokens, for the price meter. Zero means the meter shows only tokens. */
const PRICE_IN = Number(process.env.NPC_PRICE_IN ?? 0) || 0;
const PRICE_OUT = Number(process.env.NPC_PRICE_OUT ?? 0) || 0;
/** A line is one or two phrases, so the cap stays tight; raise it for terse reasoning models. */
const MAX_TOKENS = Number(process.env.NPC_MAX_TOKENS ?? 80) || 80;
/** `off` silences thinking: a reasoning model spends the whole cap on it and returns no line. */
const REASONING_OFF = process.env.NPC_REASONING === 'off';

/** Inworld TTS: the key stays here, the browser only ever asks for audio. */
const TTS_URL = process.env.INWORLD_TTS_URL ?? 'https://api.inworld.ai/tts/v1/voice:stream';
const TTS_KEY = process.env.INWORLD_API_KEY ?? '';
const TTS_MODEL = process.env.INWORLD_TTS_MODEL ?? 'inworld-tts-2';
const TTS_VOICE = process.env.INWORLD_TTS_VOICE ?? 'Tamara';
/** A designed voice wins over a stored one: describe the character instead of picking a sample. */
const TTS_DESIGN = process.env.INWORLD_TTS_DESIGN ?? '';
const TTS_RATE = Number(process.env.INWORLD_TTS_RATE ?? 0.8) || 0.8;
const TTS_DELIVERY = process.env.INWORLD_TTS_DELIVERY ?? 'CREATIVE';
const TTS_LANGUAGE = process.env.INWORLD_TTS_LANGUAGE ?? 'ru-RU';
/** The character, in words the steering model can act on. Read only when reasoning runs. */
const TTS_CHARACTER =
  process.env.INWORLD_TTS_CHARACTER ??
  'Повитуха — древняя старуха, повитуха мёртвых. Голос низкий, хриплый, с одышкой. Говорит медленно, ' +
    'ворчливо, с усталой насмешкой. Не добрая и не злая, знает цену каждому слову.';
/** REASONING_ON lets the model read the line and write its own steering: livelier, a bit slower. */
const TTS_REASONING = process.env.INWORLD_TTS_REASONING !== 'off';
/** Synthesized phrases live here between runs; delete the folder to start over. */
const CACHE_DIR = process.env.NPC_TTS_CACHE_DIR ?? fileURLToPath(new URL('../.cache/tts', import.meta.url));
const CACHE_OFF = process.env.NPC_TTS_CACHE === 'off';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...CORS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function upstreamHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) };
}

interface VoiceRequest {
  system: string;
  user: string;
}

function upstreamBody(request: VoiceRequest, stream: boolean): string {
  return JSON.stringify({
    model: MODEL,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    temperature: 0.85,
    max_tokens: MAX_TOKENS,
    ...(REASONING_OFF ? { reasoning: { enabled: false } } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  });
}

function price(tokensIn: number, tokensOut: number): number {
  return (tokensIn * PRICE_IN + tokensOut * PRICE_OUT) / 1_000_000;
}

/**
 * Relays the model's deltas as our own SSE: `delta` while it talks, `done` with the bill.
 * The first phrase reaches the player in a few hundred milliseconds instead of a full reply.
 */
async function streamVoice(res: ServerResponse, request: VoiceRequest): Promise<void> {
  const started = performance.now();
  const upstream = await fetch(UPSTREAM, {
    method: 'POST',
    headers: upstreamHeaders(),
    body: upstreamBody(request, true),
    signal: AbortSignal.timeout(60_000),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = (await upstream.text().catch(() => '')).slice(0, 300);
    console.error(`upstream ${upstream.status}: ${detail}`);
    send(res, 502, { error: `upstream ${upstream.status}` });
    return;
  }

  res.writeHead(200, {
    ...CORS,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const event = (name: string, data: unknown): void => {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let text = '';
  let tokensIn = 0;
  let tokensOut = 0;

  try {
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf('\n\n');
      while (cut >= 0) {
        const chunk = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let parsed: {
            choices?: { delta?: { content?: string } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            event('delta', { t: delta });
          }
          if (parsed.usage) {
            tokensIn = parsed.usage.prompt_tokens ?? tokensIn;
            tokensOut = parsed.usage.completion_tokens ?? tokensOut;
          }
        }
        cut = buffer.indexOf('\n\n');
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    event('error', { error: 'stream interrupted' });
    res.end();
    return;
  }

  if (!text.trim()) {
    console.error('empty streamed completion: the model likely spent the budget on reasoning; set NPC_REASONING=off');
    event('error', { error: 'empty completion' });
    res.end();
    return;
  }

  event('done', {
    ms: Math.round(performance.now() - started),
    tokensIn,
    tokensOut,
    costUsd: price(tokensIn, tokensOut),
    priced: PRICE_IN > 0 || PRICE_OUT > 0,
  });
  res.end();
}

/**
 * One short phrase in, one MP3 out. The stream is NDJSON: every line carries base64 MP3 bytes.
 * Phrases are short, so waiting for the whole clip of one phrase costs a couple of hundred ms.
 */
async function renderSpeech(text: string, voice: string | undefined, context: string[]): Promise<Buffer> {
  // Earlier lines give the model the conversation, not just the sentence: that is what makes
  // the delivery follow the scene instead of reading each phrase in isolation.
  const previousRequests = context.slice(-4).map((line) => ({ text: line.slice(0, 400) }));
  const synthesisContext = {
    ...(TTS_REASONING ? { reasoning: 'REASONING_ON', reasoningContext: TTS_CHARACTER } : {}),
    ...(previousRequests.length ? { previousRequests } : {}),
  };

  const upstream = await fetch(TTS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${TTS_KEY}` },
    body: JSON.stringify({
      text: text.slice(0, 2000),
      ...(TTS_DESIGN ? { voiceDesign: { designPrompt: TTS_DESIGN } } : { voiceId: voice ?? TTS_VOICE }),
      modelId: TTS_MODEL,
      audioConfig: { audioEncoding: 'MP3', speakingRate: TTS_RATE },
      deliveryMode: TTS_DELIVERY,
      language: TTS_LANGUAGE,
      ...(Object.keys(synthesisContext).length ? { synthesisContext } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = (await upstream.text().catch(() => '')).slice(0, 300);
    throw new Error(`tts ${upstream.status}: ${detail}`);
  }

  const chunks: Buffer[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  const collect = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed) as { result?: { audioContent?: string } };
      const audio = parsed.result?.audioContent;
      if (audio) chunks.push(Buffer.from(audio, 'base64'));
    } catch {
      // A line split across chunks: the rest arrives with the next read.
    }
  };

  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut = buffer.indexOf('\n');
    while (cut >= 0) {
      collect(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 1);
      cut = buffer.indexOf('\n');
    }
  }
  collect(buffer);

  const audio = Buffer.concat(chunks);
  if (!audio.length) throw new Error('tts returned no audio');
  return audio;
}

/**
 * A phrase, a voice and the settings fully determine the bytes, so the file name is their hash:
 * every player, every restart and every browser hit the same file, and one synthesis is paid once.
 * The conversation context is deliberately not part of the key: it colours the delivery, and
 * a phrase that repeats across sessions should not re-cost money because the lines before it differ.
 */
function cacheKey(voice: string, text: string): string {
  return createHash('sha256')
    .update([TTS_MODEL, voice, TTS_RATE, TTS_DELIVERY, TTS_LANGUAGE, TTS_REASONING ? 'reasoning' : 'plain', text].join('\u0000'))
    .digest('hex');
}

async function readCached(key: string): Promise<Buffer | null> {
  if (CACHE_OFF) return null;
  try {
    return await readFile(join(CACHE_DIR, `${key}.mp3`));
  } catch {
    return null;
  }
}

/** Write through a temp file: a half-written clip must never look like a cache hit. */
async function writeCached(key: string, audio: Buffer): Promise<void> {
  if (CACHE_OFF) return;
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const target = join(CACHE_DIR, `${key}.mp3`);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, audio);
    await rename(temp, target);
  } catch (error) {
    console.error(`tts cache: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const inFlight = new Map<string, Promise<Buffer>>();

function sendAudio(res: ServerResponse, audio: Buffer, cache: string, ms: number): void {
  res.writeHead(200, {
    ...CORS,
    'access-control-expose-headers': 'x-tts-ms, x-tts-cache',
    'content-type': 'audio/mpeg',
    'content-length': String(audio.length),
    'x-tts-ms': String(ms),
    'x-tts-cache': cache,
  });
  res.end(audio);
}

async function synthesize(
  res: ServerResponse,
  body: { text?: unknown; voice?: unknown; context?: unknown },
): Promise<void> {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    send(res, 400, { error: 'text is required' });
    return;
  }
  if (!TTS_KEY) {
    send(res, 503, { error: 'INWORLD_API_KEY is not set' });
    return;
  }

  const voice = TTS_DESIGN ? 'designed' : typeof body.voice === 'string' ? body.voice : TTS_VOICE;
  const context = (Array.isArray(body.context) ? body.context : []).filter(
    (line): line is string => typeof line === 'string' && line.trim().length > 0,
  );
  const key = cacheKey(voice, text);
  const started = performance.now();

  const cached = await readCached(key);
  if (cached) {
    sendAudio(res, cached, 'hit', Math.round(performance.now() - started));
    return;
  }

  // Two players asking for the same line at once share one synthesis.
  let pending = inFlight.get(key);
  if (!pending) {
    pending = renderSpeech(text, voice, context).then(async (audio) => {
      await writeCached(key, audio);
      return audio;
    });
    inFlight.set(key, pending);
    pending.then(
      () => inFlight.delete(key),
      () => inFlight.delete(key),
    );
  }

  try {
    const audio = await pending;
    sendAudio(res, audio, 'miss', Math.round(performance.now() - started));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    send(res, 502, { error: 'tts unavailable' });
  }
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const path = (req.url ?? '').replace(/^\/npc/, '');
  if (req.method === 'GET' && path === '/health') {
    send(res, 200, {
      ok: true,
      model: MODEL,
      upstream: new URL(UPSTREAM).origin,
      tts: TTS_KEY ? `${TTS_MODEL} / ${TTS_DESIGN ? 'designed' : TTS_VOICE}` : null,
      // Everything that shapes the audio, so a browser cache can tell one voice from another.
      ttsKey: TTS_KEY
        ? [TTS_MODEL, TTS_DESIGN ? `design:${TTS_DESIGN}` : TTS_VOICE, TTS_RATE, TTS_DELIVERY, TTS_LANGUAGE, TTS_REASONING ? 'reasoning' : 'plain'].join('|')
        : null,
    });
    return;
  }
  if (req.method === 'POST' && path === '/tts') {
    try {
      await synthesize(res, (await readJson(req)) as { text?: unknown; voice?: unknown; context?: unknown });
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      if (!res.headersSent) send(res, 502, { error: 'tts unavailable' });
      else res.end();
    }
    return;
  }
  if (req.method !== 'POST' || path !== '/voice') {
    send(res, 404, { error: 'not found' });
    return;
  }

  try {
    const body = (await readJson(req)) as { system?: unknown; user?: unknown; stream?: unknown };
    if (typeof body.system !== 'string' || typeof body.user !== 'string') {
      send(res, 400, { error: 'system and user are required' });
      return;
    }
    const request: VoiceRequest = { system: body.system, user: body.user };
    if (body.stream === true) {
      await streamVoice(res, request);
      return;
    }

    const started = performance.now();
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: upstreamHeaders(),
      body: upstreamBody(request, false),
      signal: AbortSignal.timeout(20_000),
    });

    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 300);
      console.error(`upstream ${upstream.status}: ${detail}`);
      send(res, 502, { error: `upstream ${upstream.status}` });
      return;
    }

    const data = (await upstream.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const ms = Math.round(performance.now() - started);
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) {
      const spent = data.usage?.completion_tokens ?? 0;
      console.error(
        spent
          ? `empty completion after ${spent} tokens: the model likely spent them on reasoning; set NPC_REASONING=off`
          : 'empty completion',
      );
      send(res, 502, { error: 'empty completion' });
      return;
    }
    const tokensIn = data.usage?.prompt_tokens ?? 0;
    const tokensOut = data.usage?.completion_tokens ?? 0;
    send(res, 200, {
      text,
      ms,
      tokensIn,
      tokensOut,
      costUsd: price(tokensIn, tokensOut),
      priced: PRICE_IN > 0 || PRICE_OUT > 0,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    if (!res.headersSent) send(res, 502, { error: 'upstream unavailable' });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`NPC voice proxy: http://127.0.0.1:${PORT}/voice -> ${UPSTREAM} (${MODEL})`);
  console.log(
    PRICE_IN || PRICE_OUT
      ? `Price: $${PRICE_IN}/1M in, $${PRICE_OUT}/1M out`
      : 'Price: NPC_PRICE_IN / NPC_PRICE_OUT are unset, the meter shows tokens only',
  );
  console.log(
    TTS_KEY
      ? `Voice: ${TTS_MODEL} / ${TTS_DESIGN ? `designed: ${TTS_DESIGN.slice(0, 40)}…` : TTS_VOICE} -> ${TTS_URL}`
      : 'Voice: INWORLD_API_KEY is not set, replies stay silent',
  );
  console.log(CACHE_OFF ? 'Cache: off' : `Cache: ${CACHE_DIR}`);
  console.log('Client: http://localhost:5173/?npc=llm');
});
