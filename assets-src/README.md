# Исходники ассетов

Здесь лежат исходные паки, из которых `npm run assets` (`scripts/build-assets.ts`) собирает `.glb` для игры.
Паки большие и в git не входят. Готовые `.glb` в `packages/client/src/assets/models/` закоммичены,
поэтому паки нужны только для пересборки.

## Quaternius (CC0)

Бесплатные версии [Standard] трёх паков. Распакуйте каждый zip в `assets-src/quaternius/` как есть:

| Пак | Ссылка | Что берём |
| --- | --- | --- |
| Universal Base Characters | https://quaternius.itch.io/universal-base-characters | голова, глаза, брови, борода |
| Modular Character Outfits – Fantasy | https://quaternius.itch.io/modular-character-outfits-fantasy | костюм рейнджера |
| Universal Animation Library | https://quaternius.itch.io/universal-animation-library | анимации |

Должно получиться:

```
assets-src/quaternius/
  Universal Base Characters[Standard]/
  Modular Character Outfits - Fantasy[Standard]/
  Universal Animation Library[Standard]/
```

Лицензия всех трёх паков — CC0 1.0: можно использовать в коммерческой игре, указывать автора не обязательно.
Автор — Quaternius (https://quaternius.com, https://www.patreon.com/quaternius).
