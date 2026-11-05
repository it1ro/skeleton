# Исходники ассетов

Здесь лежат исходники, из которых `npm run assets` (`scripts/build-assets.ts`) и `npm run assets:rig`
(`scripts/build-meshy.ts`) собирают `.glb` для игры. Готовые `.glb` в `packages/client/src/assets/models/`
закоммичены. Исходники Meshy тоже в git — только так `npm run assets` воспроизводим у всех; пак Quaternius
(около 500 МБ) остаётся локальным.

Должно получиться:

```
assets-src/
  meshy/
    skeleton_m.glb
    skeleton_f.glb
    rigged_m.glb   (локально, не в git)
    rigged_f.glb   (локально, не в git)
  quaternius/
    Universal Animation Library[Standard]/
```

## Meshy: фигуры в саване

`meshy/skeleton_m.glb` и `skeleton_f.glb` — мужской и женский скелеты, сгенерированные в
[Meshy](https://www.meshy.ai): Text to Image, потом Image to 3D, Remesh до 8–10 тысяч граней. Промпты и
настройки — в `docs/meshy-skeletons.md`. Скачаны без рига, в T-позе, высота 1,80 и 1,70 м, начало координат
внизу, формат glb. Риг не нужен: сборка сама сажает модель на кости UAL (см. `docs/assets.md`).

## Meshy: ригованные персонажи

`meshy/rigged_m.glb` и `rigged_f.glb` — мужской и женский скелеты, уже ригованные и анимированные в Meshy
(вкладка Animate). В диалоге скачивания: формат GLB, «Все добавлено», «С кожей», шаблон скелета
**UE5 Mannequin** — его имена совпадают с UAL. Собирает `npm run assets:rig`, подробности — в `docs/assets.md`,
раздел «Свои клипы Meshy».

Рост в диалоге скачивания не задаётся: Meshy ригует на высоту из диалога рига, по умолчанию 1,70. Мужского
сборка дотягивает до 1,80 сама.

## Quaternius (CC0)

Бесплатная версия [Standard]. Распакуйте zip в `assets-src/quaternius/` как есть:

| Пак | Ссылка | Что берём |
| --- | --- | --- |
| Universal Animation Library | https://quaternius.itch.io/universal-animation-library | скелет и анимации |

Лицензия — CC0 1.0: можно использовать в коммерческой игре, указывать автора не обязательно.
Автор — Quaternius (https://quaternius.com, https://www.patreon.com/quaternius).
