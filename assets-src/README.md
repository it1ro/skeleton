# Исходники ассетов

Здесь лежат исходники, из которых `npm run assets` (`scripts/build-assets.ts`) собирает `.glb` для игры.
Они большие и в git не входят. Готовые `.glb` в `packages/client/src/assets/models/` закоммичены,
поэтому исходники нужны только для пересборки.

Должно получиться:

```
assets-src/
  meshy/
    skeleton.glb
  quaternius/
    Universal Animation Library[Standard]/
```

## Meshy: модель героя

`meshy/skeleton.glb` — скелет, сгенерированный в [Meshy](https://www.meshy.ai): Text to Image, потом Image to 3D,
Remesh до 10 000 граней. Скачан без рига, в T-позе, высота 1,8 м, начало координат внизу, формат glb.
Риг не нужен: сборка сама сажает модель на кости UAL (см. `docs/assets.md`).

## Quaternius (CC0)

Бесплатная версия [Standard]. Распакуйте zip в `assets-src/quaternius/` как есть:

| Пак | Ссылка | Что берём |
| --- | --- | --- |
| Universal Animation Library | https://quaternius.itch.io/universal-animation-library | скелет и анимации |

Лицензия — CC0 1.0: можно использовать в коммерческой игре, указывать автора не обязательно.
Автор — Quaternius (https://quaternius.com, https://www.patreon.com/quaternius).
