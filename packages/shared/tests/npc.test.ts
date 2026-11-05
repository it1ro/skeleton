import { describe, expect, it } from 'vitest';
import {
  MAX_MINUTES,
  MAX_PATIENCE,
  POVITUHA,
  buildVoicePrompt,
  interpret,
  startTalk,
  talk,
  type Beat,
  type TalkState,
} from '../src/index.ts';

function turn(state: TalkState, text: string): Beat {
  return talk(state, interpret(text));
}

function meet(): TalkState {
  return startTalk().state;
}

describe('npc act interpreter', () => {
  it('reads a reason as a statement', () => {
    expect(interpret('Хочу силу').kind).toBe('say');
  });

  it('reads short consent and refusal', () => {
    expect(interpret('Да').kind).toBe('accept');
    expect(interpret('Нет, не буду').kind).toBe('refuse');
  });

  it('finds the topic of a question', () => {
    const act = interpret('Сколько стоит?');
    expect(act.kind).toBe('ask');
    expect(act.topic).toBe('price');
    expect(interpret('Кто ты?').topic).toBe('her');
  });

  it('separates a promise from a claim', () => {
    expect(interpret('Я принесу веник').kind).toBe('promise');
    const claim = interpret('У меня есть глина');
    expect(claim.kind).toBe('claim');
    expect(claim.claim).toEqual({ kind: 'has', subject: 'глина' });
  });

  it('hears a threat only when it is aimed at her', () => {
    expect(interpret('Я убью тебя').kind).toBe('threat');
    expect(interpret('Я убью Нетленного').kind).not.toBe('threat');
  });

  it('reads a haggle as an offer', () => {
    expect(interpret('Дорого, сбавь').kind).toBe('offer');
  });

  it('greets', () => {
    expect(interpret('Привет').kind).toBe('greet');
  });
});

describe('povituha trade', () => {
  it('names a price for a reason and closes the deal', () => {
    const reason = turn(meet(), 'Хочу силу, чтобы бить нечисть');
    expect(reason.state.stage).toBe('price');
    expect(reason.state.why).toBe('power');
    expect(reason.state.price).toBe('venik');

    const deal = turn(reason.state, 'Да, беру');
    expect(deal.state.stage).toBe('deal');
    expect(deal.end).toBe(true);
    expect(deal.state.test).toBe('stone');
    expect(deal.state.facts.map((fact) => fact.kind)).toEqual(['test', 'debt']);
    expect(deal.state.facts[1]?.text).toContain('веник');
  });

  it('catches a lie and makes it cost patience', () => {
    const beat = turn(meet(), 'У меня есть глина');
    expect(beat.line).toContain('Врёшь');
    expect(beat.state.stage).toBe('why');
    expect(beat.state.patience).toBe(MAX_PATIENCE - 2);
  });

  it('ends the talk on a threat', () => {
    const beat = turn(meet(), 'Я убью тебя, старуха');
    expect(beat.state.stage).toBe('refused');
    expect(beat.end).toBe(true);
  });

  it('turns a refusal to explain into a fear price', () => {
    const refused = turn(meet(), 'Не твоё дело');
    expect(refused.state.stage).toBe('price');
    expect(refused.state.price).toBe('fear');

    const insist = turn(refused.state, 'Да');
    expect(insist.state.stage).toBe('price');

    const deal = turn(insist.state, 'Боюсь темноты');
    expect(deal.state.stage).toBe('deal');
    expect(deal.state.test).toBe('night');
    expect(deal.state.facts).toHaveLength(1);
  });

  it('rejects a wrong offer and keeps the price', () => {
    const price = turn(meet(), 'Хочу силу').state;
    const wrong = turn(price, 'Дам тебе камень');
    expect(wrong.state.stage).toBe('price');
    expect(wrong.state.patience).toBe(MAX_PATIENCE - 1);
    expect(wrong.line).toContain('ни к чему');
  });

  it('answers a haggle without lowering the price', () => {
    const price = turn(meet(), 'Хочу силу').state;
    const haggle = turn(price, 'Дорого, сбавь');
    expect(haggle.state.haggled).toBe(true);
    expect(haggle.state.patience).toBe(MAX_PATIENCE);
    const deal = turn(haggle.state, 'Ладно, принесу веник');
    expect(deal.state.stage).toBe('deal');
  });

  it('lets the bath cool and ends the talk', () => {
    let state = meet();
    const long = `ну ${'а '.repeat(40)}`;
    for (let i = 0; i < 4; i++) {
      const beat = turn(state, long);
      state = beat.state;
      if (beat.end) break;
    }
    expect(state.minutes).toBe(MAX_MINUTES);
    expect(state.stage).toBe('over');
  });

  it('runs out of patience on empty talk', () => {
    let state = meet();
    let end = false;
    for (let i = 0; i < MAX_PATIENCE + 1 && !end; i++) {
      const beat = turn(state, 'Просто стою');
      state = beat.state;
      end = Boolean(beat.end);
    }
    expect(state.stage).toBe('over');
    expect(end).toBe(true);
  });

  it('serializes without loss', () => {
    const state = turn(meet(), 'Хочу вспомнить, кем был').state;
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});

describe('voice prompt', () => {
  it('keeps the card and the meaning, not the world state', () => {
    const beat = turn(meet(), 'Хочу силу');
    const prompt = buildVoicePrompt(POVITUHA, beat.state, beat, 'Хочу силу', ['Герой: Хочу силу']);
    expect(prompt.system).toContain('Повитуха');
    expect(prompt.system).toContain('Не придумывай');
    expect(prompt.system).toContain('цена: веник баннику до полуночи');
    expect(prompt.user).toContain('Смысл твоей реплики');
    expect(prompt.user).toContain('Хочу силу');
  });
});

describe('povituha answers', () => {
  it('answers about Нетленный without giving the secret away', () => {
    const beat = turn(meet(), 'Ты знала Нетленного?');
    expect(beat.line).toContain('Знала');
    expect(beat.state.stage).toBe('why');
  });
});
