const MODULE_ID = "vision-restrictor-module";
const FLAG_MAX_RANGE = "maxRange";
const SETTING_DEFAULT_MAX_RANGE = "defaultMaxRange";
const SCENE_CONFIG_MARKER = "data-vision-restrictor-module-scene-config";

let originalSightRangeDescriptor = null;
let originalOptimalSightRangeDescriptor = null;

function localize(key) {
  return game.i18n.localize(`VISIONRESTRICTOR.${key}`);
}

function format(key, data = {}) {
  return game.i18n.format(`VISIONRESTRICTOR.${key}`, data);
}

function normalizeRange(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, number);
}

function getActiveScene() {
  return canvas?.scene ?? game.scenes?.active ?? null;
}

function safeGetFlag(document, scope, key) {
  try {
    return document?.getFlag(scope, key);
  } catch (err) {
    console.warn(`${MODULE_ID} | Could not read flag ${scope}.${key}; ignoring scene override.`, err);
    return undefined;
  }
}

function getSceneMaxRange(scene = getActiveScene()) {
  const sceneValue = normalizeRange(safeGetFlag(scene, MODULE_ID, FLAG_MAX_RANGE));
  if (sceneValue !== null) return sceneValue;

  return normalizeRange(game.settings.get(MODULE_ID, SETTING_DEFAULT_MAX_RANGE)) ?? 0;
}

function rangeUnitsToPixels(rangeUnits) {
  const dimensions = canvas?.dimensions;
  if (!dimensions?.size || !dimensions?.distance) return rangeUnits;
  return (rangeUnits * dimensions.size) / dimensions.distance;
}

function capPixelRange(token, originalRangePx) {
  const maxRangeUnits = getSceneMaxRange(token?.scene ?? getActiveScene());
  if (!maxRangeUnits) return originalRangePx;

  const maxRangePx = rangeUnitsToPixels(maxRangeUnits);
  if (!Number.isFinite(maxRangePx) || maxRangePx <= 0) return originalRangePx;

  // Do not grant vision to tokens that did not already have it. Only cap existing finite or infinite ranges.
  if (originalRangePx === Infinity) return maxRangePx;
  if (!Number.isFinite(originalRangePx)) return originalRangePx;
  return Math.min(originalRangePx, maxRangePx);
}

function findPropertyDescriptor(object, property) {
  let prototype = object;
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (descriptor) return descriptor;
    prototype = Object.getPrototypeOf(prototype);
  }
  return null;
}

function patchTokenRangeGetters() {
  const TokenClass = foundry?.canvas?.placeables?.Token ?? globalThis.Token;
  if (!TokenClass?.prototype) {
    console.warn(`${MODULE_ID} | Could not find Foundry Token class; vision restriction was not installed.`);
    return;
  }

  originalSightRangeDescriptor = findPropertyDescriptor(TokenClass.prototype, "sightRange");
  originalOptimalSightRangeDescriptor = findPropertyDescriptor(TokenClass.prototype, "optimalSightRange");

  if (!originalSightRangeDescriptor?.get || !originalOptimalSightRangeDescriptor?.get) {
    console.warn(`${MODULE_ID} | Could not find Token sightRange accessors; vision restriction was not installed.`);
    return;
  }

  Object.defineProperty(TokenClass.prototype, "sightRange", {
    configurable: true,
    get: function visionRestrictorSightRange() {
      const original = originalSightRangeDescriptor.get.call(this);
      return capPixelRange(this, original);
    }
  });

  Object.defineProperty(TokenClass.prototype, "optimalSightRange", {
    configurable: true,
    get: function visionRestrictorOptimalSightRange() {
      const original = originalOptimalSightRangeDescriptor.get.call(this);
      return capPixelRange(this, original);
    }
  });

  console.log(`${MODULE_ID} | Token vision range cap installed.`);
}

function refreshVision() {
  if (!canvas?.ready) return;

  try {
    for (const token of canvas.tokens?.placeables ?? []) token.initializeSources?.();

    // Foundry V14 removed older render flags such as refreshTiles. A full perception initialization
    // is safest for this module because the cap affects token vision source calculations.
    if (canvas.perception?.initialize) canvas.perception.initialize();
    else canvas.perception?.update?.({
      initializeLighting: true,
      initializeVision: true,
      initializeVisionModes: true,
      refreshLighting: true,
      refreshVision: true,
      refreshVisionSources: true
    });

    canvas.effects?.refreshLighting?.();
    canvas.visibility?.refresh?.();
  } catch (err) {
    console.warn(`${MODULE_ID} | Could not refresh canvas perception.`, err);
  }
}

async function setSceneMaxRange(range, scene = getActiveScene()) {
  if (!game.user.isGM) {
    ui.notifications.warn(localize("notifications.worldOnly"));
    return;
  }
  if (!scene) return;

  const normalized = normalizeRange(range);
  if (normalized === null) {
    await scene.unsetFlag(MODULE_ID, FLAG_MAX_RANGE);
    ui.notifications.info(localize("notifications.sceneCleared"));
  } else {
    await scene.setFlag(MODULE_ID, FLAG_MAX_RANGE, normalized);
    ui.notifications.info(format("notifications.sceneSet", { range: normalized }));
  }
  refreshVision();
}

function getSceneConfigElement(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  return null;
}

function getSceneConfigTarget(element) {
  const form = element.querySelector("form") ?? element;

  // V14 SceneConfig is an ApplicationV2 with a dedicated "visibility" part/tab.
  const visibilityPart =
    form.querySelector('[data-application-part="visibility"]') ??
    form.querySelector('[data-part="visibility"]') ??
    form.querySelector('.tab[data-tab="visibility"]') ??
    form.querySelector('[data-tab="visibility"]');

  if (visibilityPart) return visibilityPart.querySelector(".scrollable") ?? visibilityPart;
  return form.querySelector(".tab.active") ?? form;
}

function injectSceneConfig(app, html) {
  if (!game.user.isGM) return;

  const element = getSceneConfigElement(html);
  if (!element) return;

  const scene = app.document ?? app.object;
  if (!scene) return;

  const existing = element.querySelector(`[${SCENE_CONFIG_MARKER}]`);
  if (existing) existing.remove();

  const current = safeGetFlag(scene, MODULE_ID, FLAG_MAX_RANGE);
  const defaultRange = normalizeRange(game.settings.get(MODULE_ID, SETTING_DEFAULT_MAX_RANGE)) ?? 0;

  const fieldset = document.createElement("fieldset");
  fieldset.classList.add("vision-restrictor-fieldset");
  fieldset.setAttribute(SCENE_CONFIG_MARKER, "true");

  const legend = document.createElement("legend");
  legend.textContent = localize("sceneConfig.legend");
  fieldset.append(legend);

  const formGroup = document.createElement("div");
  formGroup.classList.add("form-group");

  const label = document.createElement("label");
  label.textContent = localize("sceneConfig.fieldLabel");
  label.setAttribute("for", `${MODULE_ID}-max-range`);

  const inputWrapper = document.createElement("div");
  inputWrapper.classList.add("form-fields");

  const input = document.createElement("input");
  input.id = `${MODULE_ID}-max-range`;
  input.type = "number";
  input.min = "0";
  input.step = "1";
  input.name = `flags.${MODULE_ID}.${FLAG_MAX_RANGE}`;
  input.placeholder = String(defaultRange);
  input.value = current === null || current === undefined ? "" : String(current);

  inputWrapper.append(input);
  formGroup.append(label, inputWrapper);
  fieldset.append(formGroup);

  const hint = document.createElement("p");
  hint.classList.add("hint");
  hint.textContent = localize("sceneConfig.fieldHint");
  fieldset.append(hint);

  getSceneConfigTarget(element).append(fieldset);
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_DEFAULT_MAX_RANGE, {
    name: localize("settings.defaultMaxRange.name"),
    hint: localize("settings.defaultMaxRange.hint"),
    scope: "world",
    config: true,
    restricted: true,
    type: Number,
    default: 0,
    onChange: refreshVision
  });

  patchTokenRangeGetters();
});

Hooks.once("ready", () => {
  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = {
      getSceneMaxRange,
      setSceneMaxRange,
      clearSceneMaxRange: (scene = getActiveScene()) => setSceneMaxRange(null, scene),
      refreshVision
    };
  }
});

Hooks.on("canvasReady", refreshVision);
Hooks.on("updateScene", (scene, changes) => {
  if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAG_MAX_RANGE}`)) refreshVision();
});
Hooks.on("renderSceneConfig", injectSceneConfig);
