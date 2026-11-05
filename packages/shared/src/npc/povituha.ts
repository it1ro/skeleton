import {
  MAX_MINUTES,
  MAX_PATIENCE,
  type Act,
  type Beat,
  type Fact,
  type NpcCard,
  type PriceId,
  type TalkState,
  type TestId,
  type Why,
} from './types.ts';

/**
 * Повитуха: the first talking character. She trades a body for a debt, and the debt is a promise,
 * not an item. The rules below decide what a phrase costs and what it buys; the line is the fallback
 * a model may re-voice, never replace with a different meaning.
 */

export const POVITUHA: NpcCard = {
  id: 'povituha',
  name: 'Повитуха',
  voice:
    'Строгая старуха, ворчит, торгуется, говорит поговорками. Наполовину кость, наполовину плоть. ' +
    'Принимает мёртвых в жизнь заново. Ради героя, а не ради себя, но мягкой не бывает.',
  knows: [
    'баня и рост тела на мёртвой воде',
    'чего боится нечисть',
    'Нетленный до падения: они учились вместе',
    'у Нетленного есть слабость',
  ],
  hides: ['свою вину в падении Нетленного', 'что герой ей кого-то напоминает'],
  wants: ['чтобы герой стал человеком, а не зверем', 'чтобы её не торопили', 'веник баннику до полуночи'],
};

export const TESTS: Record<TestId, string> = {
  stone: 'Принеси камень с кургана. Не бери — попроси у хозяина.',
  night: 'Просиди ночь в бане и не открой баннику.',
  word: 'Вспомни последнее слово перед смертью. Принеси мне его, не пересказ.',
  name: 'Узнай имя Недобудки. Не убей — назови.',
  fear: 'Назови, чего боишься. Не мне — себе. Придёшь — скажешь.',
};

export const PRICES: Record<PriceId, string> = {
  venik: 'веник баннику до полуночи',
  silence: 'обещание не звать меня, пока не вернёшь глаза',
  death_image: 'образ твоей смерти',
  oath: 'обещание не трогать Нетленного, пока не узнаешь его имени',
  fear: 'честный ответ: чего ты боишься',
};

const WHY_TEST: Record<Why, TestId> = {
  power: 'stone',
  hide: 'night',
  memory: 'word',
  revenge: 'name',
  unknown: 'night',
};

const WHY_PRICE: Record<Why, PriceId> = {
  power: 'venik',
  hide: 'silence',
  memory: 'death_image',
  revenge: 'oath',
  unknown: 'fear',
};

const WHY_LINE: Record<Why, string> = {
  power:
    'Сила... Сила без головы — что топор без топорища. Цена: веник баннику до полуночи. Не отдашь — рост сорвётся.',
  hide:
    'Спрятаться хочешь. От Нетленного не спрячешься — он и в бане найдёт. Цена: обещание. Не зови меня, пока глаз не вернёшь.',
  memory: 'Помнить хочешь. Это дороже тела. Цена: образ твоей смерти. Принесёшь — отдам тело.',
  revenge:
    'Отомстить. Нетленный тебя и не заметит, пока ты — кости. Цена: обещание. Не тронешь его, пока не узнаешь имени. Слово дай.',
  unknown: 'Не знаешь? Тогда и тело тебе не нужно.',
};

const PRICE_MATCH: Record<PriceId, RegExp> = {
  venik: /веник|банник/,
  silence: /не звать|не зови|молча|помолчу|глаз/,
  death_image: /образ|смерт/,
  oath: /не трону|не трогать|нетленн/,
  fear: /боюсь|боя|страш|страх|темнот|высот|огн|вод|одиноч|смерт/,
};

export function startTalk(): Beat {
  const state: TalkState = {
    stage: 'why',
    patience: MAX_PATIENCE,
    minutes: 0,
    why: 'unknown',
    test: null,
    price: null,
    facts: [],
    haggled: false,
  };
  return beat(
    state,
    'Ну? Чего пришёл? Тела, поди. Все вы за телом. Зачем оно тебе?',
    'Она спрашивает, зачем герою тело, и ждёт ответа по существу.',
  );
}

/** One phrase costs bath time: a paragraph costs more than a word. */
function cost(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(5, Math.max(1, Math.ceil(words / 6)));
}

function beat(state: TalkState, line: string, intent: string, end = false): Beat {
  return end ? { line, intent, state, end } : { line, intent, state };
}

function clone(state: TalkState): TalkState {
  return { ...state, facts: state.facts.map((fact) => ({ ...fact })) };
}

function overPatience(state: TalkState): Beat {
  state.stage = 'over';
  return beat(state, 'Всё. Кончился разговор. Ступай, сквозняк.', 'Она теряет терпение и прогоняет героя.', true);
}

function overBath(state: TalkState): Beat {
  state.stage = 'over';
  return beat(state, 'Баня остыла. Не о чем больше говорить.', 'Она заканчивает разговор: время вышло.', true);
}

function refuseThreat(state: TalkState): Beat {
  state.stage = 'refused';
  return beat(
    state,
    'Ты мне тут костями не греми. В моей бане и не таких выпаривали. Ступай, пока цел.',
    'Она обрывает угрозу и прогоняет героя.',
    true,
  );
}

function refuseDeal(state: TalkState): Beat {
  state.stage = 'refused';
  return beat(
    state,
    'Как хочешь. Баня остынет — приходи, когда будет чем платить.',
    'Она отказывается от сделки и отпускает героя.',
    true,
  );
}

/** The player claims something the world knows to be false. She hears the lie and it costs. */
function caught(state: TalkState, act: Act): Beat {
  const kind = act.claim?.kind ?? 'has';
  const lines: Record<string, string> = {
    has: 'Врёшь. У тебя за душой ни глины, ни веника — ничего, кроме костей.',
    did: 'Недобудка спит. Не по твоим костям такая добыча.',
    knows: 'Имя? Ты бы его не удержал. Оно бы тебя сожгло.',
  };
  state.patience -= 2;
  if (state.patience <= 0) {
    state.stage = 'over';
    return beat(state, 'Хватит. Врёшь и пустословишь. Ступай.', 'Она ловит ложь и заканчивает разговор.', true);
  }
  return beat(state, lines[kind] ?? lines.has, 'Она ловит ложь и стыдит героя.');
}

function detectWhy(text: string): Why {
  if (/нетленн|отомст|мест[ьи]/.test(text)) return 'revenge';
  if (/помн|вспомн|памят|прошл|кем был|кем была|имя|вернуть|жить|жизн/.test(text)) return 'memory';
  if (/сил|бить|драт|мощ|топор|оруж|защит/.test(text)) return 'power';
  if (/спрят|тихо|скрыт|незамет|убеж|боюсь|страш/.test(text)) return 'hide';
  return 'unknown';
}

function matchesPrice(text: string, price: PriceId): boolean {
  return PRICE_MATCH[price].test(text);
}

function answerAsk(state: TalkState, act: Act, atWhy: boolean): Beat {
  if (/нетленн/.test(act.text)) {
    return beat(
      state,
      'Знала. До того, как он решил, что ему мало. Больше не спрашивай.',
      'Она неохотно признаёт, что знала Нетленного.',
    );
  }
  if (/помога|что тебе с этого|зачем тебе это/.test(act.text)) {
    return beat(state, 'Не тебе помогаю. Себе. Он и меня не пощадил.', 'Она говорит, что дело личное.');
  }

  switch (act.topic) {
    case 'price': {
      if (state.stage !== 'price') {
        return beat(state, 'Сначала скажи, зачем тело. Потом цена.', 'Она откладывает цену, пока не услышит причину.');
      }
      const price = state.price ?? WHY_PRICE[state.why];
      return beat(state, `Цена — ${PRICES[price]}. Не нравится — ищи другую баню.`, 'Она повторяет цену.');
    }
    case 'test':
      return beat(state, 'Сначала цена. Испытание — после.', 'Она откладывает испытание до сделки.');
    case 'body':
      return beat(
        state,
        atWhy
          ? 'Тело растят в бане, на мёртвой воде. Мясо — из глины, кожа — из мха. Не за один пар. А тебе зачем?'
          : 'Тело растят в бане, на мёртвой воде. Мясо — из глины, кожа — из мха. Не за один пар.',
        'Она коротко отвечает про рост тела.',
      );
    case 'her':
      return beat(
        state,
        'Повитуха. Бабка. Принимаю в жизнь тех, кто уже помер. Тебе, чай, тоже придётся.',
        'Она представляется без охоты.',
      );
    case 'world':
      return beat(state, 'Мир? Погост, курганы, туман. Нечисть по ночам. Чего ещё?', 'Она отвечает про мир коротко.');
    case 'name':
      return beat(state, 'Имена? Имя — не слово, а сила. Своего я тебе не скажу.', 'Она уходит от вопроса об именах.');
    default:
      return beat(state, 'Спрашиваешь много, а дела нет.', 'Она не любит праздных вопросов.');
  }
}

function deal(state: TalkState): Beat {
  const test = state.test ?? WHY_TEST[state.why];
  const price = state.price ?? WHY_PRICE[state.why];
  state.stage = 'deal';
  state.test = test;
  const facts: Fact[] = [{ kind: 'test', text: TESTS[test] }];
  if (price !== 'fear') facts.push({ kind: 'debt', text: PRICES[price] });
  state.facts = [...state.facts, ...facts];

  const line =
    price === 'fear'
      ? `Так и быть. Испытание: ${TESTS[test]} Ступай.`
      : `Так и быть. Испытание: ${TESTS[test]} И долг помни: ${PRICES[price]}. Ступай, до полуночи.`;
  return beat(state, line, 'Она заключает сделку, называет испытание и цену и отпускает героя.', true);
}

function onWhy(state: TalkState, act: Act): Beat {
  if (act.kind === 'threat') return refuseThreat(state);
  if (act.kind === 'claim') return caught(state, act);
  if (act.kind === 'ask') return answerAsk(state, act, true);

  if (act.kind === 'refuse') {
    state.why = 'unknown';
    state.price = 'fear';
    state.stage = 'price';
    return beat(
      state,
      'Ладно, скрытный. Тогда простое: скажи, чего боишься. Честно — и сговоримся.',
      'Она не давит: просит назвать страх и этим начинает торг.',
    );
  }
  if (act.kind === 'accept' || act.kind === 'greet') {
    return beat(state, 'Не мычи. Зачем тебе тело?', 'Она повторяет вопрос.');
  }

  const why = detectWhy(act.text);
  if (why === 'unknown') {
    state.patience -= 1;
    if (state.patience <= 0) return overPatience(state);
    return beat(
      state,
      'Пустое. Я не даю тело тому, кто сам не знает, зачем. Скажи по делу.',
      'Она обрывает пустой ответ и ждёт настоящей причины.',
    );
  }

  state.why = why;
  state.price = WHY_PRICE[why];
  state.stage = 'price';
  return beat(state, WHY_LINE[why], `Она называет цену: ${PRICES[state.price]}, и ждёт ответа.`);
}

function onPrice(state: TalkState, act: Act): Beat {
  const price = state.price ?? WHY_PRICE[state.why];

  if (act.kind === 'threat') return refuseThreat(state);
  if (act.kind === 'claim') return caught(state, act);

  if (price === 'fear') {
    if (act.kind === 'accept') {
      return beat(state, 'Сначала ответь. Чего боишься?', 'Она не принимает согласие вместо ответа.');
    }
    if (act.kind === 'say' && matchesPrice(act.text, price)) return deal(state);
  }

  if (act.kind === 'accept') return deal(state);
  if (act.kind === 'ask') return answerAsk(state, act, false);
  if (act.kind === 'refuse') return refuseDeal(state);
  if (act.kind === 'greet') {
    return beat(state, `Не до здоровья. Цена — ${PRICES[price]}.`, 'Она возвращает разговор к цене.');
  }

  if (act.kind === 'offer' || act.kind === 'promise') {
    if (matchesPrice(act.text, price)) return deal(state);
    if (!state.haggled && /дешев|дорого|много|сбавь|уступи|не могу/.test(act.text)) {
      state.haggled = true;
      return beat(
        state,
        'Дешевле? Тогда и тело будет дешевле — из мха да бересты. Тебе такое надо?',
        'Она отвечает на попытку сбить цену отказом, но без обиды.',
      );
    }
    state.patience -= 1;
    if (state.patience <= 0) return overPatience(state);
    return beat(
      state,
      `Мне это ни к чему. Мне нужно другое: ${PRICES[price]}.`,
      'Она отвергает предложение и повторяет цену.',
    );
  }

  state.patience -= 1;
  if (state.patience <= 0) return overPatience(state);
  return beat(state, 'Мели. Вода от слов не греется.', 'Она обрывает пустословие.');
}

export function talk(prev: TalkState, act: Act): Beat {
  const state = clone(prev);

  if (state.stage === 'deal') {
    return beat(state, 'Испытание не пройдено. Ступай.', 'Она не продолжает разговор: сначала испытание.', true);
  }
  if (state.stage === 'refused') {
    return beat(state, 'Я сказала: ступай.', 'Она не хочет продолжать.', true);
  }
  if (state.stage === 'over') {
    return beat(state, 'Разговор кончен.', 'Она не хочет продолжать.', true);
  }

  state.minutes = Math.min(MAX_MINUTES, state.minutes + cost(act.text));
  if (state.minutes >= MAX_MINUTES) return overBath(state);

  return state.stage === 'why' ? onWhy(state, act) : onPrice(state, act);
}
