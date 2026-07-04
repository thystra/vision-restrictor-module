const MODULE_ID = "vision-restrictor-module";
const FLAG_MAX_RANGE = "maxRange";
const SETTING_DEFAULT_MAX_RANGE = "defaultMaxRange";

const WRAPPED_GET_VISION_SOURCE_DATA = Symbol.for(`${MODULE_ID}.wrappedGetVisionSourceData`);
const WRAPPED_SIGHT_RANGE = Symbol.for(`${MODULE_ID}.wrappedSightRange`);
const WRAPPED_OPTIMAL_SIGHT_RANGE = Symbol.for(`${MODULE_ID}.wrappedOptimalSightRange`);

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

function rangeUnitsToPixels(rangeUnits, token = null) {
  if (token?.getLightRadius) return token.getLightRadius(rangeUnits);

  const dimensions = canvas?.dimensions;
  if (!dimensions?.size || !dimensions?.distance) return rangeUnits;
  return (rangeUnits * dimensions.size) / dimensions.distance;
}

function getMaxRangePx(token = null) {
  const maxRangeUnits = getSceneMaxRange(token?.scene ?? getActiveScene());
  if (!maxRangeUnits) return 0;

  const maxRangePx = rangeUnitsToPixels(maxRangeUnits, token);
  if (!Number.isFinite(maxRangePx) || maxRangePx <= 0) return 0;
  return maxRangePx;
}

function capPixelRange(token, originalRangePx) {
  const maxRangePx = getMaxRangePx(token);
  if (!maxRangePx) return originalRangePx;

  // Do not grant vision. Only cap an existing finite or intentionally-infinite range.
  if (originalRangePx === Infinity) return maxRangePx;
  if (!Number.isFinite(originalRangePx)) return originalRangePx;
  if (originalRangePx <= 0) return originalRangePx;

  return Math.min(originalRangePx, maxRangePx);
}

function capVisionSourceData(token, data) {
  const maxRangePx = getMaxRangePx(token);
  if (!maxRangePx || !data || typeof data !== "object") return data;

  const capped = { ...data };

  // In V14, Token#_getVisionSourceData returns the data used to initialize the
  // VisionSource. Radius is the important value here; getter-only patching can
  // miss module/system overrides which directly build or mutate source data.
  if ("radius" in capped) capped.radius = capPixelRange(token, Number(capped.radius));

  // Some systems/modules expose parallel range fields. Cap them defensively when
  // they are pixel-like numeric fields, but leave absent fields untouched.
  for (const key of ["sightRange", "visionRange", "range"]) {
    if (key in capped) capped[key] = capPixelRange(token, Number(capped[key]));
  }

  // Token detection modes store ranges in scene units, not pixels. Cap those too
  // so modules that lean on detection modes cannot see past the environmental cap.
  const maxRangeUnits = getSceneMaxRange(token?.scene ?? getActiveScene());
  if (Array.isArray(capped.detectionModes) && maxRangeUnits > 0) {
    capped.detectionModes = capped.detectionModes.map((mode) => {
      if (!mode || typeof mode !== "object") return mode;
      const range = Number(mode.range);
      if (!Number.isFinite(range) || range <= 0) return mode;
      return { ...mode, range: Math.min(range, maxRangeUnits) };
    });
  }

  return capped;
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

function getTokenClass() {
  return foundry?.canvas?.placeables?.Token ?? globalThis.Token ?? null;
}

function patchTokenVisionSourceData() {
  const TokenClass = getTokenClass();
  const proto = TokenClass?.prototype;
  if (!proto) {
    console.warn(`${MODULE_ID} | Could not find Foundry Token class; vision source data cap was not installed.`);
    return false;
  }

  const current = proto._getVisionSourceData;
  if (typeof current !== "function") {
    console.warn(`${MODULE_ID} | Could not find Token#_getVisionSourceData; vision source data cap was not installed.`);
    return false;
  }

  if (current[WRAPPED_GET_VISION_SOURCE_DATA]) return true;

  const wrapped = function visionRestrictorGetVisionSourceData(...args) {
    const data = current.apply(this, args);
    return capVisionSourceData(this, data);
  };
  wrapped[WRAPPED_GET_VISION_SOURCE_DATA] = true;
  wrapped._visionRestrictorOriginal = current;

  Object.defineProperty(proto, "_getVisionSourceData", {
    configurable: true,
    writable: true,
    value: wrapped
  });

  console.log(`${MODULE_ID} | Token vision source data cap installed.`);
  return true;
}

function patchTokenRangeGetters() {
  const TokenClass = getTokenClass();
  const proto = TokenClass?.prototype;
  if (!proto) {
    console.warn(`${MODULE_ID} | Could not find Foundry Token class; vision range getter cap was not installed.`);
    return false;
  }

  originalSightRangeDescriptor = findPropertyDescriptor(proto, "sightRange");
  originalOptimalSightRangeDescriptor = findPropertyDescriptor(proto, "optimalSightRange");

  if (originalSightRangeDescriptor?.get && !originalSightRangeDescriptor.get[WRAPPED_SIGHT_RANGE]) {
    const originalGet = originalSightRangeDescriptor.get;
    const wrappedGet = function visionRestrictorSightRange() {
      return capPixelRange(this, originalGet.call(this));
    };
    wrappedGet[WRAPPED_SIGHT_RANGE] = true;

    Object.defineProperty(proto, "sightRange", {
      configurable: true,
      get: wrappedGet
    });
  }

  if (originalOptimalSightRangeDescriptor?.get && !originalOptimalSightRangeDescriptor.get[WRAPPED_OPTIMAL_SIGHT_RANGE]) {
    const originalGet = originalOptimalSightRangeDescriptor.get;
    const wrappedGet = function visionRestrictorOptimalSightRange() {
      return capPixelRange(this, originalGet.call(this));
    };
    wrappedGet[WRAPPED_OPTIMAL_SIGHT_RANGE] = true;

    Object.defineProperty(proto, "optimalSightRange", {
      configurable: true,
      get: wrappedGet
    });
  }

  console.log(`${MODULE_ID} | Token vision range getter cap installed.`);
  return true;
}

function patchTokenVision() {
  const dataPatch = patchTokenVisionSourceData();
  const getterPatch = patchTokenRangeGetters();
  return dataPatch || getterPatch;
}

function refreshVision() {
  if (!canvas?.ready) return;

  try {
    for (const token of canvas.tokens?.placeables ?? []) token.initializeSources?.();

    if (typeof canvas.perception?.initialize === "function") {
      canvas.perception.initialize();
    } else {
      canvas.perception?.update?.({
        initializeLighting: true,
        initializeVision: true,
        refreshLighting: true,
        refreshVision: true,
        refreshVisionSources: true
      }, true);
    }

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

function injectSceneConfig(app, html) {
  if (!game.user.isGM) return;

  const element = html instanceof HTMLElement ? html : html?.[0];
  if (!element) return;

  const scene = app.document ?? app.object;
  if (!scene) return;

  const form = element.querySelector("form") ?? element;
  form.querySelector(`[data-${MODULE_ID}-scene-config]`)?.remove();

  const current = safeGetFlag(scene, MODULE_ID, FLAG_MAX_RANGE);
  const fieldset = document.createElement("fieldset");
  fieldset.classList.add("vision-restrictor-fieldset");
  fieldset.dataset[`${MODULE_ID}SceneConfig`] = "true";

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
  input.placeholder = String(game.settings.get(MODULE_ID, SETTING_DEFAULT_MAX_RANGE) ?? 0);
  input.value = current === null || current === undefined ? "" : String(current);

  inputWrapper.append(input);
  formGroup.append(label, inputWrapper);
  fieldset.append(formGroup);

  const hint = document.createElement("p");
  hint.classList.add("hint");
  hint.textContent = localize("sceneConfig.fieldHint");
  fieldset.append(hint);

  const target =
    form.querySelector('[data-application-part="visibility"]') ??
    form.querySelector('.tab[data-tab="visibility"]') ??
    form.querySelector('[data-tab="visibility"]') ??
    form.querySelector('.tab.active') ??
    form;

  target.append(fieldset);
}

function debugControlledTokens() {
  return (canvas.tokens?.controlled ?? []).map((token) => {
    const sourceData = typeof token._getVisionSourceData === "function" ? token._getVisionSourceData() : null;
    return {
      name: token.name,
      sceneMaxRangeUnits: getSceneMaxRange(token.scene),
      maxRangePx: getMaxRangePx(token),
      sightRange: token.sightRange,
      optimalSightRange: token.optimalSightRange,
      sourceData,
      initializedVisionSourceRadius: token.vision?.data?.radius ?? token.vision?.radius ?? null,
      isGM: game.user.isGM,
      controlled: token.controlled
    };
  });
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

  patchTokenVision();
});

Hooks.once("ready", () => {
  // Re-apply after systems/modules such as dnd5e or Vision 5e finish any late
  // token vision patching. The wrapper is idempotent.
  patchTokenVision();

  const module = game.modules.get(MODULE_ID);
  module.api = {
    getSceneMaxRange,
    setSceneMaxRange,
    clearSceneMaxRange: (scene = getActiveScene()) => setSceneMaxRange(null, scene),
    refreshVision,
    debugControlledTokens
  };

  refreshVision();
});

Hooks.on("canvasReady", () => {
  patchTokenVision();
  refreshVision();
});

Hooks.on("updateScene", (scene, changes) => {
  if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAG_MAX_RANGE}`)) refreshVision();
});

Hooks.on("renderSceneConfig", injectSceneConfig);
