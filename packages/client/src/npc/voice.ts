/**
 * Optional re-voicing through a local proxy. The browser never holds a model key, and the game
 * never waits on the network to stay playable: any failure returns the authored line.
 *
 * The proxy streams: `delta` events arrive while the model talks, `done` carries the bill.
 */
export interface VoiceReply {
  text: string;
  /** Upstream model time, measured by the proxy. */
  ms: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** The proxy knows the model's prices; without them the meter shows tokens only. */
  priced: boolean;
}

function parse(chunk: string): { event: string; data: unknown } | null {
  const event = /^event: (.+)$/m.exec(chunk)?.[1];
  const data = /^data: (.+)$/m.exec(chunk)?.[1];
  if (!event || !data) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

export async function voiceLine(
  prompt: { system: string; user: string },
  onDelta?: (delta: string) => void,
): Promise<VoiceReply | null> {
  try {
    const response = await fetch('/npc/voice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...prompt, stream: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;

    // An older proxy answers in one JSON piece; keep the game working with both.
    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream') || !response.body) {
      const data = (await response.json()) as Partial<VoiceReply> & { text?: unknown };
      if (typeof data.text !== 'string') return null;
      const text = data.text.replace(/\s+/g, ' ').trim();
      if (text.length < 2 || text.length > 400) return null;
      return {
        text,
        ms: data.ms ?? 0,
        tokensIn: data.tokensIn ?? 0,
        tokensOut: data.tokensOut ?? 0,
        costUsd: data.costUsd ?? 0,
        priced: data.priced === true,
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let done: Omit<VoiceReply, 'text'> | null = null;

    for (;;) {
      const { done: eof, value } = await reader.read();
      if (eof) break;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf('\n\n');
      while (cut >= 0) {
        const chunk = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const parsed = parse(chunk);
        if (parsed?.event === 'delta') {
          const delta = (parsed.data as { t?: unknown }).t;
          if (typeof delta === 'string') {
            text += delta;
            onDelta?.(delta);
          }
        } else if (parsed?.event === 'done') {
          const data = parsed.data as Partial<VoiceReply>;
          done = {
            ms: data.ms ?? 0,
            tokensIn: data.tokensIn ?? 0,
            tokensOut: data.tokensOut ?? 0,
            costUsd: data.costUsd ?? 0,
            priced: data.priced === true,
          };
        } else if (parsed?.event === 'error') {
          return null;
        }
        cut = buffer.indexOf('\n\n');
      }
    }

    const line = text.replace(/\s+/g, ' ').trim();
    if (!line || !done) return null;
    return { text: line, ...done };
  } catch {
    return null;
  }
}
