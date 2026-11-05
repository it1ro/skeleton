# Два скелета в саване: промпты и настройки Meshy

Мужской и женский скелеты для посадки на кости UAL. Генерим в Meshy, рига нет: меш приходит в T-позе и садится
на манекен скриптом (`assets.md`). Файлы-исходники кладутся в `assets-src/meshy/` и лежат в git:
`npm run assets` должен собираться у всех.

Слово «покрывало» здесь — **саван**, погребальная рубаха из льна. Он же знак мертвеца по лору (`characters.md`).

## Порядок

1. **Text to Image** — 4 варианта на скелет, 3:4, по промпту ниже. Выбрать тот, где руки и ноги явно отделены
   от тела, а ткань не липнет к костям.
2. **Image to 3D** — Pose: **T-Pose**, текстура 2K, без рига. Если форма даёт несколько ракурсов, добавь вид
   сзади; хватает и одного фронта.
3. **Remesh** — 8–10 тыс. граней: бюджет персонажа 15 тыс., у героя 10,4 тыс.
4. **Скачать GLB** без рига и анимаций; в Download Settings — **Resize**: высота 1,80 м (мужской) или 1,70 м
   (женский), Origin — **Bottom**.
5. **Blender** — рост, начало координат, оси, применение трансформаций (ниже).
6. Положить в `assets-src/meshy/` как `skeleton_m.glb` и `skeleton_f.glb`.

## Промпты (до 800 знаков)

Лимит Meshy — 800 символов на промпт. Общая часть (стиль и кадр) — 288 знаков, мужской вариант — 413,
женский — 463; с общей частью выходит 702 и 752. Ниже готовые промпты целиком:
копируй одним блоком.

### Мужской — 702 знака

```text
Stylised low-poly game art, matte hand-painted texture, pale ivory bone, oatmeal linen, muted palette, no gore, no blood, no metal, no gloss, no cape. Orthographic full-body front view at chest height, flat light-grey background, soft even light, no shadows, no ground, no props, no text.
Single male skeleton, 1.80 m, broad shoulders, wide ribcage, narrow pelvis, standing in a T-pose, in an undyed linen burial shirt: wide open collar showing clavicles and ribs, rope belt, sleeves to the elbows, side slits, hem at mid-thigh. Arms straight out, palms down, fingers apart, feet shoulder-width, legs not touching. Bare skull, forearms, hands, shins, feet; hollow eye sockets, clean teeth, empty hands.
```

### Женский — 752 знака

```text
Stylised low-poly game art, matte hand-painted texture, pale ivory bone, oatmeal linen, muted palette, no gore, no blood, no metal, no gloss, no cape. Orthographic full-body front view at chest height, flat light-grey background, soft even light, no shadows, no ground, no props, no text.
Single female skeleton, 1.70 m, narrow shoulders, wide pelvis, smaller skull, standing in a T-pose, in an undyed linen burial shirt: wide open collar showing clavicles and ribs, rope belt, sleeves to the elbows, side slits, hem just above the knees, linen kerchief tied over the skull, face open. Arms straight out, palms down, fingers apart, feet shoulder-width, legs not touching. Bare forearms, hands, shins, feet; hollow eye sockets, clean teeth, empty hands.
```

Разница читается с любого ракурса: рост, плечи, таз, платок и длина рубахи. Пол по костям не угадывается —
это игра, а не судмедэкспертиза.

## Настройки Meshy

| Шаг | Что ставить |
| --- | --- |
| Text to Image | 3:4, 4 варианта; negative: `gore, blood, metal armour, hood over the face, long skirt below the knee, extra limbs, props, text` |
| Image to 3D | **Pose: T-Pose**, симметрия включена; топология треугольная; текстура 2048 |
| Split (Разделить) | **выключен**: это резка на детали для 3D-печати, не для рига |
| Remesh | 8 000–10 000 граней |
| Rig | не включать: сборка сажает меш на UAL сама |
| Скачивание | GLB; **Resize**: Height 1,80 м / 1,70 м, Origin **Bottom**; без анимаций |

## Почему именно так

- **Рубаха выше колена.** В сборке каждая вершина идёт за ближайшей костью: подол между ног прилипнет
  к левому и правому бедру разом и на шаге растянется. Боковые разрезы и подол выше колена это снимают.
  Ткань ниже колена в игре не заработает без ручных весов.
- **Широкий ворот.** Видно, что внутри скелет: иначе читается как человек в рубахе.
- **Руки в стороны, ладони вниз, пальцы врозь.** T-поза нужна сборке, а разделённые пальцы — чтобы кисть
  не слиплась в варежку.
- **Ноги на ширине плеч.** Между бёдрами должен быть просвет, иначе Meshy слепит ноги в одну колонну.
- **Пустые руки.** Всё, что персонаж держит, прирастает к кисти и изгибается вместе с ней.
- **Без капюшона на лице и без плаща.** Полотно на голове и длинная накидка дают ткань, которая при
  авториге и на клипах UAL ведёт себя непредсказуемо.
- **Без Split.** «Разделить» режет модель на водонепроницаемые куски для печати, требует выключенной текстуры
  и +10 кредитов. На выходе швы и отдельные меши — под UAL и авториг это не годится. Если саван понадобится
  отдельной деталью, его отделяют в Blender по материалу, уже после генерации.
- **Треугольники, не квады.** glTF хранит только треугольники: 10 тыс. квадов на экспорте станут 20 тыс.
  треугольников и выбьют бюджет. Квады выигрывают, когда топологию правят руками и ригуют весами по петлям;
  здесь веса считаются по расстоянию до костей, петли никто не разводит, а при том же числе граней квады
  отдают меньше детали — рёбрам, пальцам и зубам это дорого.

## Blender перед сборкой

1. Импорт GLB. Если двигал или масштабировал — **Ctrl+A → All Transforms** перед экспортом.
2. Рост: мужской 1,80 м, женский 1,70 м. Масштабируй по Z и примени трансформации.
3. Начало координат — у ступней, по центру; модель стоит на Z = 0 и смотрит вдоль −Y (вид Front).
4. Проверь: до 15 тыс. треугольников, до 5 материалов, металличность 0.
5. Экспорт: glTF Binary (`.glb`), только выбранный объект, +Y Up, без анимаций.

## Сборка

`npm run assets` собирает всех персонажей из списка `CHARACTERS` в `scripts/build-assets.ts`: у каждого свой
исходник, своя таблица суставов и своя пара файлов — `player_m.glb` с `anims_humanoid_m.glb`, `player_f.glb`
с `anims_humanoid_f.glb`. Клипы пекутся под рост модели, потому что высота таза в них запечена.

Клиент грузит обе фигуры: игрок выбирает мужской или женский скелет в меню, рядом с именем (#47).
Подол савана на шаге тянется: у ткани нет своих костей, веса жёсткие.

## Если Meshy выдал брак

| Что не так | Что менять |
| --- | --- |
| Подол прилип к ногам, между бёдрами перемычка | короче подол, шире ноги, боковые разрезы в промпте |
| Рукава срослись с рёбрами | руки дальше от тела, «visible gap under the sleeves» |
| Пустая рубаха без костей | «wide open collar showing collarbones and ribs», крупнее ворот |
| Лицо закрыто тканью | «face left open», убрать капюшон и платок с лица |
| Пальцы-варежка | «fingers relaxed and apart», крупнее кисть в кадре |
| Слишком много граней | Remesh 8–10 тыс., потом риг не нужен |
