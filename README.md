# Vision Restrictor

[![License: GPL v3 or later](https://img.shields.io/badge/License-GPLv3%2B-blue.svg)](LICENSE)

A small Foundry VTT V14 module that caps token vision to a GM-configured maximum range for a scene. Example: set a scene to 75 feet to represent heavy fog, smoke, rain, snow, haze, or other conditions that prevent tokens from seeing farther than 75 feet.

## Installation

Use this URL to install the module: https://github.com/thystra/vision-restrictor-module/releases/latest/download/module.json

Then restart Foundry, enable **Vision Restrictor** in your world, and reload the world.

## Usage

Open **Configure Scene**, go to the **Visibility** tab, and set **Vision Restrictor > Maximum Vision Range**.

- Blank: use the world default.
- `0`: disable the cap on this scene.
- Positive number: cap token vision to that many scene distance units.

You can also use the exposed API from a macro:

```js
game.modules.get("vision-restrictor-module").api.setSceneMaxRange(75);
```

Clear the scene override:

```js
game.modules.get("vision-restrictor-module").api.clearSceneMaxRange();
```

## Design note

This module caps existing vision. It does not grant vision. A token that cannot see in total darkness should still see nothing; a token with darkvision, light, or another valid visibility source should simply be capped at the configured maximum range.


## Release URLs

For a public release, add these fields to `module.json` after you know the repository and release ZIP URLs:

```json
"url": "https://github.com/thystra/vision-restrictor-module",
"manifest": "https://raw.githubusercontent.com/thystra/vision-restrictor-module/main/module.json",
"download": "https://github.com/thystra/vision-restrictor-module/releases/download/v0.1.0/vision-restrictor-module.zip"
```


## Debugging

With one or more tokens selected, this macro reports the active cap and the capped V14 vision source data:

```js
game.modules.get("vision-restrictor-module").api.debugControlledTokens();
```


## Debugging

With one or more tokens selected, this macro reports the active cap and the capped V14 vision source data:

```js
game.modules.get("vision-restrictor-module").api.debugControlledTokens();
```

For a full module/scene state dump:

```js
game.modules.get("vision-restrictor-module").api.debugState();
```

### Hard blackout behavior

Vision Restrictor now applies a hard blackout mask outside the configured range. The range is interpreted in the active scene distance units, such as feet or meters, not grid squares. For example, in a D&D scene where one grid square is 5 feet, a value of `75` means 75 feet, or 15 grid squares.

This is intentional for fog, smoke, haze, blizzards, darkness-like magical obscurity, or other effects that block sight even when the scene has daylight or global illumination enabled. Use `0` on a scene to disable the cap for that scene.

### v0.1.6 behavior note

The configured range is interpreted in the active scene distance units, such as feet or meters, not grid squares. The hard blackout mask uses that configured environmental cap even if the token has a shorter special-sense source such as blindsight. Foundry's own vision calculation still determines what the token can actually see inside the unmasked area.

This version also avoids writing directly to getter-only Foundry V14 `PointVisionSource` properties, which previously caused token control and movement errors.

## Support / Tips

If Vision Restrictor is useful at your table, tips are appreciated. GitHub uses  to populate the repository Sponsor button.

- GitHub Sponsors: https://github.com/sponsors/thystra

## License

Vision Restrictor is licensed under the GNU General Public License v3.0 or later. See [LICENSE](LICENSE).
