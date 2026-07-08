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

AI was used in the creation of this module. 

## License

Vision Restrictor is licensed under the GNU General Public License v3.0 or later. See [LICENSE](LICENSE).


## Release workflow

This repository includes `.github/workflows/release.yml` to package the module and publish a release to FoundryMods when a GitHub release is published.

Before using it, add this repository secret in GitHub:

```text
FOUNDRYMODS_TOKEN
```

Generate the token from the claimed module page on FoundryMods. Use the manual workflow dispatch with `dry_run: true` first. The workflow uploads these release assets to the GitHub release before notifying FoundryMods:

```text
module.json
vision-restrictor-module.zip
```

FoundryMods reads the package id, version, and Foundry compatibility from the release-specific `module.json` asset. The stable Foundry install/update manifest remains:

```text
https://github.com/thystra/vision-restrictor-module/releases/latest/download/module.json
```

## FoundryMods release API troubleshooting

The Foundry package id for this module is `vision-restrictor-module`. The human-readable title is `Vision Restrictor`.

If the FoundryMods release API returns an error like `id mismatch: expected Vision Restrictor`, the release request is using the correct package id but the `fmp_...` token is likely attached to a FoundryMods package record whose internal id was created from the title instead of the manifest id, or the token was created before the package record was corrected.

Do **not** change `module.json` to `Vision Restrictor`; Foundry package ids must be lowercase package identifiers and must match the module folder. On FoundryMods, save the module page with Module ID / URL Slug set to `vision-restrictor-module`, then generate a fresh Package Release Token from that same module page and update the GitHub repository secret named `FOUNDRYMODS_TOKEN`.


### FoundryMods release note

The GitHub Actions workflow sends FoundryMods a version-specific manifest from `raw.githubusercontent.com` for the release tag. This avoids server-side fetch issues with GitHub release-asset redirects while still publishing the packaged release zip as a GitHub release asset.
