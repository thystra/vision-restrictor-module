# Vision Restrictor

A small Foundry VTT V14 module that caps token vision to a GM-configured maximum range for a scene. Example: set a scene to 75 feet to represent heavy fog, smoke, rain, snow, haze, or other conditions that prevent tokens from seeing farther than 75 feet.

## Install for local testing

Place this folder at:

```text
{Foundry User Data}/Data/modules/vision-restrictor
```

Then restart Foundry, enable **Vision Restrictor** in your world, and reload the world.

## Usage

Open **Configure Scene** and set **Vision Restrictor > Maximum Vision Range**.

- Blank: use the world default.
- `0`: disable the cap on this scene.
- Positive number: cap token vision to that many scene distance units.

You can also use the exposed API from a macro:

```js
game.modules.get("vision-restrictor").api.setSceneMaxRange(75);
```

Clear the scene override:

```js
game.modules.get("vision-restrictor").api.clearSceneMaxRange();
```

## Design note

This module caps existing vision. It does not grant vision. A token that cannot see in total darkness should still see nothing; a token with darkvision, light, or another valid visibility source should simply be capped at the configured maximum range.


## Release URLs

For a public release, add these fields to `module.json` after you know the repository and release ZIP URLs:

```json
"url": "https://github.com/YOUR-GITHUB-USER/vision-restrictor",
"manifest": "https://raw.githubusercontent.com/YOUR-GITHUB-USER/vision-restrictor/main/module.json",
"download": "https://github.com/YOUR-GITHUB-USER/vision-restrictor/releases/download/v0.1.0/vision-restrictor.zip"
```
