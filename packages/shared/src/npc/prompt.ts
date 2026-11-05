import { PRICES, TESTS } from './povituha.ts';
import { MAX_MINUTES, MAX_PATIENCE, type Beat, type NpcCard, type Stage, type TalkState } from './types.ts';

/**
 * The model gets a closed card and a meaning to say. It never gets the world's truth:
 * a sentence it invents cannot become a fact, because facts are made by the judge.
 */

const STAGE: Record<Stage, string> = {
  why: 'она ждёт причины',
  price: 'она называет цену',
  deal: 'сделка заключена',
  refused: 'она отказала',
  over: 'разговор кончен',
};

export function stateSummary(state: TalkState): string {
  const parts = [
    `стадия: ${STAGE[state.stage]}`,
    `терпение: ${state.patience} из ${MAX_PATIENCE}`,
    `баня остывает: ${state.minutes} из ${MAX_MINUTES} минут`,
  ];
  if (state.price) parts.push(`цена: ${PRICES[state.price]}`);
  if (state.test) parts.push(`испытание: ${TESTS[state.test]}`);
  if (state.facts.length) parts.push(`долги: ${state.facts.map((fact) => fact.text).join('; ')}`);
  return parts.join('; ');
}

export function buildVoicePrompt(
  card: NpcCard,
  state: TalkState,
  beat: Beat,
  playerText: string,
  recent: string[],
): { system: string; user: string } {
  const system = [
    `Ты — ${card.name}. ${card.voice}`,
    '',
    'Правила:',
    '- Говори по-русски, одна-две короткие фразы. Сказ, без современных слов, без объяснений и лекций.',
    '- Ты не помощник и не гид. У тебя своё дело и своё право отказать.',
    '- Не придумывай новых имён, мест, существ и событий. Если чего-то не знаешь, уходи от ответа.',
    '- Не упоминай, что ты модель или игра.',
    '- Герой — мёртвый скелет без языка. Ты слышишь мёртвых: это твой дар, не его.',
    '',
    `Ты знаешь: ${card.knows.join('; ')}.`,
    `Ты скрываешь: ${card.hides.join('; ')}.`,
    `Ты хочешь: ${card.wants.join('; ')}.`,
    '',
    `Сейчас: ${stateSummary(state)}.`,
  ].join('\n');

  const user = [
    recent.length ? `Последние реплики:\n${recent.join('\n')}` : '',
    `Герой: ${playerText}`,
    `Смысл твоей реплики: ${beat.intent}`,
    `Опора по тону (не копируй дословно): ${beat.line}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return { system, user };
}
