# Шаг 1. Тело в симуляции

Спека к шагу 1 итерации 1 ([roadmap](../roadmap.md)). Здесь только состояние тела и его передача: рост в бане,
смерть и урон подключаются на шагах 2, 5 и 6 и в эту спеку не входят.

## Решения, на которых стоит спека

- Тело — сущность мира со ссылкой на владельца, а не поле игрока: [ADR 0001](../adr/0001-body-is-a-world-entity.md).
- Часть тела — одна единица двух видов, орган и ткань: [GLOSSARY](../../GLOSSARY.md).
- Орган оживает в бане; рост встаёт на паузу при уходе; смерть не отнимает меру; урон не отнимает части:
  [systems.md](../systems.md), разделы «Баня», «Смерть», «Голый скелет».

## Модель

`packages/shared/src/body.ts`:

```ts
export type OrganName = 'eyes' | 'tongue' | 'ears' | 'lungs' | 'heart' | 'stomach';
export type Segment = 'head' | 'torso' | 'arms' | 'legs';
export type Layer = 'muscle' | 'skin';
export type TissueMaterial = 'clay' | 'roots' | 'bogOre' | 'moss' | 'birch' | 'scale';

export type PartKey = `organ:${OrganName}` | `tissue:${Segment}:${Layer}`;

export interface OrganPart {
  key: `organ:${OrganName}`;
  kind: 'organ';
  /** 0..1. Единица — часть работает; меньше — растёт и не работает. */
  growth: number;
}

export interface TissuePart {
  key: `tissue:${Segment}:${Layer}`;
  kind: 'tissue';
  /** Из чего выращена. У органа материала нет. */
  material: TissueMaterial;
  growth: number;
}

export type Part = OrganPart | TissuePart;

export interface Body {
  id: number;
  /** Кто носит; null — тело лежит в мире. */
  ownerId: number | null;
  parts: Part[];
  /** Где лежит; у надетого тела — позиция владельца на последнем тике. */
  x: number;
  y: number;
  z: number;
}
```

Вид части лежит и в ключе, и в поле `kind`: `kind` нужен для сужения типа без разбора строки, ключ —
для уникальности и для карты «кость → меш» на клиенте.

`Player` в `sim.ts` получает два поля, `PlayerState` не трогаем:

```ts
interface Player {
  // ...
  /** null — голый скелет. */
  bodyId: number | null;
  /** Мера игрока: сколько нити есть. Занятое считается по частям. */
  thread: number;
}
```

`PlayerState` остаётся состоянием движения, которое переигрывает предсказание. Тело в срезе на движение
не влияет; когда появятся лёгкие, `moveMode` начнёт зависеть от тела — это отдельная спека.

## Снимок

`Body` — он же формат снимка, отдельного `BodySnapshot` нет.

```ts
export interface PlayerSnapshot {
  // ...id, name, color, x, y, z, yaw, speed
  bodyId: number | null;
  thread: number;
}

// protocol.ts: вариант 'snapshot' в ServerMessage
interface Snapshot {
  t: 'snapshot';
  // ...tick, ack, vy, grounded, players
  players: PlayerSnapshot[];
  bodies: Body[];
}
```

Сервер шлёт все тела: надетые и лежащие. Пока это дёшево; AOI — когда тел станет много. Клиент рисует чужие
тела тем же кодом, что своё, и не выводит части из своих знаний.

## Инварианты

1. Ключи частей в теле уникальны: один орган каждого вида, одна ткань на сегмент и слой.
2. Часть с `growth < 1` занимает нить и видна на модели, но не работает.
3. Занятая нить — сумма стоимостей частей; свободная — `thread` минус занятое.
4. `bodyId` ссылается на тело с `ownerId === player.id`; у тела не больше одного владельца.
5. Тело без владельца не растёт и не меняется.
6. Смерть: `ownerId = null`, `bodyId = null`, `thread` не меняется, тело остаётся на месте.
7. Урон не меняет `parts`.
8. Обычный рост требует свободной нити: занятое плюс стоимость не больше `thread`.

## Числа

Черновые, крутятся на плейтесте. Живут в `constants.ts`, не в коде роста.

```ts
export const START_THREAD = 5;
export const GROWTH_TICKS = 60 * 30; // 60 секунд при 30 Гц

export const PART_COST: Partial<Record<PartKey, number>> = {
  'organ:eyes': 2,
  'tissue:arms:muscle': 3,
};

export function partCost(part: Part): number {
  const cost = PART_COST[part.key];
  if (cost === undefined) throw new Error(`no thread cost for ${part.key}`);
  return cost;
}
```

`START_THREAD` ровно закрывает две части среза: мышцы рук и глаза. Игрок упирается в меру на второй части —
это и проверяет гипотеза 2. `partCost` падает на неизвестной части, а не считает её нулём: забытая часть
должна ломать тест, а не бюджет. `GROWTH_TICKS` понадобится шагу 2 и лежит здесь, чтобы число было в одном месте.

## События (задел под журнал плейтеста)

Имена резервируем сейчас, пишет их шаг 8: `body.worn`, `body.dropped`, `part.started`, `part.finished`.

## Тесты

`packages/shared/tests/body.test.ts`:

- часть занимает нить с начала роста, а не после;
- второй орган того же вида не добавляется;
- надеть тело: `ownerId` и `bodyId` выставлены; снять: оба `null`, позиция тела сохранена;
- смерть обнуляет `bodyId`, `thread` не меняется, тело остаётся в мире;
- `partCost` падает на неизвестной части.

`packages/shared/tests/sim.test.ts`:

- снимок содержит тело игрока, его части и `bodyId`;
- тело без владельца видно в снимке.

## Клиент: greybox

`client/src/body/greybox.ts` строит по ключу части группу примитивов и вешает её на кость UAL:

| Ключ | Кости | Примитив |
| --- | --- | --- |
| `tissue:arms:muscle` | `upperarm_l/r`, `lowerarm_l/r` | цилиндры вдоль костей |
| `organ:eyes` | `Head` | две сферы в глазницах |
| `tissue:torso:muscle` | `spine_01`, `spine_02` | короб |
| `tissue:legs:muscle` | `thigh_l/r`, `calf_l/r` | цилиндры |

При `growth < 1` примитив полупрозрачный и растёт по `growth`. Это же место займёт шейдер роста.

## Порядок работ

1. `body.ts`, стоимости, `partCost`, тесты.
2. Сим: `Player.bodyId`, `Player.thread`, карта тел, надеть и снять.
3. Протокол: `bodies` в снимке, поля в `PlayerSnapshot`.
4. Клиент: greybox по снимку.

## Не входит

- баня и рост по времени — шаг 2;
- смерть и урон — шаги 2 и 5;
- восприятие — шаг 7;
- превышение меры и колдовство — после среза;
- замена материала и тиры — после среза;
- уровень бани и тиры построек — после среза;
- обмен телами в коопе — после среза.

## Решения, принятые в спеке (проверь)

1. **Обычный рост требует свободной нити**, превышение — отдельный колдовской путь. Так мирятся «место в Нити»
   как условие бани и «превысить меру можно» как соблазн. В срезе превышения нет.
2. **Орган оживает сразу, ткань растёт по времени.** В доке «парится, пока растёт» сказано про ткань;
   скорость для органа не задана.
3. **`PlayerState` не трогаем.** Тело в срезе не влияет на движение, предсказание остаётся чистым.
