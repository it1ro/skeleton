import type { Act, AskTopic, Claim } from './types.ts';

/**
 * Free text to an act. Rules for the spike: a language model may replace this later,
 * but the rest of the game already speaks in acts and does not care who wrote them.
 *
 * The order matters: "я принесу" is a promise, "я принёс" is a claim, "да" is consent.
 */

const THREAT_VERBS = ['убью', 'прикончу', 'заставл', 'сожгу', 'разнесу', 'выпотрошу', 'порву', 'поколочу'];
const THREAT_TARGETS = ['тебя', 'твой', 'твоя', 'твою', 'твои', 'твое', 'твоё', 'баню', 'избу', 'старух'];

const PROMISE = ['обеща', 'кляну', 'слово даю', 'зуб даю', 'принесу', 'приведу', 'сделаю', 'достану'];
const CLAIM_STARTS = [
  'у меня есть',
  'у меня',
  'я уже',
  'я принес',
  'я убил',
  'я наш',
  'я знаю',
  'я достал',
  'я добыл',
  'я смог',
];
const OFFER = [
  'дам',
  'отдам',
  'обмен',
  'меняться',
  'взамен',
  'заплач',
  'предлож',
  'возьми',
  'бери',
  'в уплату',
  'дешев',
  'дорого',
  'сбавь',
  'уступи',
  'торг',
];
const ACCEPT = ['да', 'ага', 'угу', 'конечно', 'соглас', 'беру', 'по рукам', 'хорошо', 'ладно', 'идет', 'годится'];
const REFUSE = ['нет', 'не буду', 'не стану', 'не пойду', 'отказ', 'не хочу', 'не мое', 'не твое'];
const GREET = ['здравств', 'привет', 'здорово', 'мир тебе', 'кланяюсь', 'доброго'];

function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function hasAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

function startsWithAny(text: string, words: string[]): boolean {
  return words.some((word) => text.startsWith(word));
}

function claimOf(text: string): Claim {
  if (/недобудк/.test(text)) return { kind: 'did', subject: 'недобудка' };
  if (/имя|имени/.test(text)) return { kind: 'knows', subject: 'имя' };
  if (/глин/.test(text)) return { kind: 'has', subject: 'глина' };
  if (/веник/.test(text)) return { kind: 'has', subject: 'веник' };
  if (/глаз/.test(text)) return { kind: 'has', subject: 'глаза' };
  if (/топор/.test(text)) return { kind: 'has', subject: 'топор' };
  if (/мяс/.test(text)) return { kind: 'has', subject: 'мясо' };
  return { kind: 'has', subject: text };
}

function topicOf(text: string): AskTopic | undefined {
  if (/цена|стоит|взамен|плат|что хочешь|чего хочешь/.test(text)) return 'price';
  if (/испытани|проверк|задани/.test(text)) return 'test';
  if (/имя|имена/.test(text)) return 'name';
  if (/ты кто|кто ты|как зовут|зовут|бабк|повитух/.test(text)) return 'her';
  if (/тело|мясо|кож|расти|ткань|орган/.test(text)) return 'body';
  if (/мир|погост|навь|нечист|лес|болот|нетленн/.test(text)) return 'world';
  return undefined;
}

function isQuestion(text: string): boolean {
  return (
    text.includes('?') ||
    /^(что|кто|как|где|когда|почему|зачем|сколько|можно|скажи|расскажи)(\s|$|[,.!?])/.test(text)
  );
}

export function interpret(raw: string): Act {
  const text = normalize(raw);
  const words = text.split(' ').filter(Boolean);

  if (hasAny(text, THREAT_VERBS) && hasAny(text, THREAT_TARGETS)) {
    return { kind: 'threat', text };
  }
  if (hasAny(text, PROMISE)) {
    return { kind: 'promise', text };
  }
  if (startsWithAny(text, CLAIM_STARTS)) {
    return { kind: 'claim', text, claim: claimOf(text) };
  }
  if (hasAny(text, OFFER)) {
    return { kind: 'offer', text };
  }
  if (words.length <= 3 && startsWithAny(text, ACCEPT)) {
    return { kind: 'accept', text };
  }
  if (words.length <= 3 && startsWithAny(text, REFUSE)) {
    return { kind: 'refuse', text };
  }
  if (startsWithAny(text, ACCEPT)) {
    return { kind: 'accept', text };
  }
  if (startsWithAny(text, REFUSE)) {
    return { kind: 'refuse', text };
  }
  if (startsWithAny(text, GREET)) {
    return { kind: 'greet', text };
  }
  if (isQuestion(text)) {
    return { kind: 'ask', text, topic: topicOf(text) };
  }
  return { kind: 'say', text };
}
