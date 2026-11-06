# Промпт: реестр биомов (рефакторинг без изменения поведения)

Ты — агент в репозитории `/home/itiro/dev/games/skeleton`: TypeScript, npm workspaces, three.js
(WebGPURenderer), Vitest. Ветка `main`, ничего не коммить.

## Контекст

Первый биом (Погост, в коде — `meadows`) вшит: пороги высот, плотность и виды деревьев, пропы, трава и
палитра размазаны по четырём модулям проверками по имени и магическими числами. Абстракция есть только в
типах (`Biome` union, `Record<Biome, …>`). Из-за этого второй биом (Поле, кольцо 2) потребует нового `if` в
каждом модуле.

Нужен реестр биомов как данных: одна таблица `BIOMES: Record<Biome, BiomeDef>`, из которой читают
генерация рельефа, цвет земли, деревья, трава и туман.

## Задача

1. Создать `packages/shared/src/biomes.ts`:
   - `BIOME_NAMES`, `Biome`, `TREE_KINDS`, `TreeKind` (переехали из `terrain.ts`);
   - `BiomeDef` — `when` (высотные/шумовые условия), `surface`, `ground` (hex), `trees { density, mix }`,
     `scatter { grass, flowers }`, `fog [near, far]`, `pogost` (флаг слоя Погоста);
   - `BIOMES` — таблица всех пяти биомов;
   - `BIOME_ORDER` — порядок разрешения (первое совпадение побеждает): `ocean → beach → mountain → forest →
     meadows`; `meadows` — фолбэк, обязан быть последним;
   - `selectBiome(height, forestNoise, x, z)` — обход `BIOME_ORDER` (условия строгие, как в старых ветках:
     `height < below`, `height > above`, `forestNoise > above`; шум семплится **только** если дошли до
     биома с `forestNoise` — как раньше);
   - `pickTreeKind(mix, roll)` — первый `until` больше ролла; пороги кумулятивные, чтобы сравнения остались
     бит-в-бит прежними (`roll < 0.62` и т. д.);
   - таблицу скомпилировать в плоский список правил (`RULES`) один раз при импорте: `biomeAt` вызывается
     на каждую вершину рельефа, поэтому никаких строковых ключей и итераторов в горячем пути. Замерить
     `selectBiome` микробенчем до/после (ожидание — десятки наносекунд на вызов, не сотни).
2. Перевести потребителей на таблицу:
   - `terrain.ts`: `biomeAt` → `selectBiome`; `kindFor`/тернарник плотности → `BIOMES[biome].trees`;
     `inPogost` → `BIOMES[…].pogost`; `TREE_KINDS`/`TreeKind`/`Biome` больше не объявляются здесь.
   - `ground-color.ts`: палитра из `BIOMES[name].ground`, ветвление по `surface` (`water|sand|rock|soil`)
     вместо сравнения имён.
   - `scatter.ts`: трава/цветы по `BIOMES[biome].scatter` вместо `!== 'meadows'`.
   - `environment.ts` (клиент): `FOG_BY_BIOME` удалить, читать `BIOMES[biome].fog`.
   - `index.ts`: `export * from './biomes.ts'`.
3. Тест `packages/shared/tests/biomes.test.ts`: полнота и уникальность `BIOME_ORDER`; границы `selectBiome`
   (вода/берег/горы/лес/луга, строгие пороги); `pickTreeKind` по границам миксов; `near < far` у тумана;
   трава только там, где `scatter.grass`.
4. Обновить упоминания `FOG_BY_BIOME` в `docs/graphics.md`.

## Границы: что НЕ делать

- **Не менять поведение.** Тот же seed обязан дать тот же мир: те же биомы в точках, те же деревья
  (позиции, масштаб, поворот, вид), те же пропы, тот же цвет земли.
- **Не менять RNG-поток:** порядок и число вызовов `r()`/`mulberry32`/`hash3` в `treesInChunk`,
  `propsInChunk`, `scatterOne` сохранить. `pickTreeKind` вызывается там же, где раньше `kindFor`, — после
  проверки плотности.
- **Не трогать матрицы травы** и золотые хеши `packages/shared/tests/scatter.test.ts`.
- Не добавлять новые биомы, кольца, зоны и смешивание границ — это следующая задача. Погост остаётся зоной
  (радиус вокруг спавна), а не отдельным биомом; флаг `pogost` лишь говорит, в каком биоме слой растёт.
- Не менять `SNOW_LINE`: снег — свойство мира, не биома.
- Не коммитить.

## Доказательство сохранения поведения

Снимок «до» и «после» должен совпасть побайтово. Скрипт `/tmp/biome-snapshot.ts` (не в репозитории):
`createTerrain(DEFAULT_SEED)`, сетка `biomeAt` −400…400 шаг 8, `treesInChunk` и `propsInChunk` для чанков
−4…4 (полные записи), `groundColor` на сетке −300…300. Запуск:

```
node_modules/.bin/tsx /tmp/biome-snapshot.ts > /tmp/biome-before.json   # до правок
node_modules/.bin/tsx /tmp/biome-snapshot.ts > /tmp/biome-after.json    # после
diff /tmp/biome-before.json /tmp/biome-after.json                       # пусто
```

Плюс гейты: `npm run typecheck && npm test` (было 59 тестов, зелёные). Числа производительности — только
на эталоне: `npm run bench:aio` (сцена `spawn`, 1280×720 @0.5). Сравнивать только с прогоном на том же
коммите: графика между коммитами меняет fps сильнее, чем этот рефакторинг.

## Критерии приёмки

- `biomes.ts` — единственное место, где перечислены биомы и их параметры; в потребителях нет сравнений
  `biome === '…'` и нет дублирующих таблиц.
- Добавление биома = строка в `BIOME_NAMES` + запись в `BIOMES` + место в `BIOME_ORDER`; TypeScript сам
  покажет, где таблица неполна.
- `diff` снимков пуст, `typecheck` и `test` зелёные, `bench:aio` без регрессии.
