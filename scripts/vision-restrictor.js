const MODULE_ID = "vision-restrictor-module";
const FLAG_MAX_RANGE = "maxRange";
const SETTING_DEFAULT_MAX_RANGE = "defaultMaxRange";
const SCENE_CONFIG_ATTR = "data-vision-restrictor-module-scene-config";

const WRAPPED_GET_VISION_SOURCE_DATA = Symbol.for(`${MODULE_ID}.wrappedGetVisionSourceData`);
const WRAPPED_INITIALIZE_VISION_SOURCE = Symbol.for(`${MODULE_ID}.wrappedInitializeVisionSource`);
const WRAPPED_SIGHT_RANGE = Symbol.for(`${MODULE_ID}.wrappedSightRange`);
const WRAPPED_OPTIMAL_SIGHT_RANGE = Symbol.for(`${MODULE_ID}.wrappedOptimalSightRange`);

const LIBWRAPPER_REGISTRATIONS = new Set();

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
  if (typeof token?.getLightRadius === "function") return token.getLightRadius(rangeUnits);

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

function capNumericPixelValue(originalValue, maxRangePx) {
  if (!maxRangePx) return originalValue;

  const number = Number(originalValue);
  if (number === Infinity) return maxRangePx;
  if (!Number.isFinite(number)) return originalValue;
  if (number <= 0) return originalValue;
  return Math.min(number, maxRangePx);
}

function capPixelRange(token, originalRangePx) {
  return capNumericPixelValue(originalRangePx, getMaxRangePx(token));
}

function capDetectionModeRanges(token, detectionModes) {
  const maxRangeUnits = getSceneMaxRange(token?.scene ?? getActiveScene());
  if (!Array.isArray(detectionModes) || maxRangeUnits <= 0) return detectionModes;

  return detectionModes.map((mode) => {
    if (!mode || typeof mode !== "object") return mode;
    const range = Number(mode.range);

    if (range === 0 && mode.enabled !== false) return { ...mode, range: maxRangeUnits };
    if (!Number.isFinite(range) || range < 0) return mode;
    return { ...mode, range: Math.min(range, maxRangeUnits) };
  });
}

function capVisionSourceData(token, data) {
  const maxRangePx = getMaxRangePx(token);
  if (!maxRangePx || !data || typeof data !== "object") return data;

  const capped = { ...data };

  for (const key of ["radius", "externalRadius", "sightRange", "visionRange", "range"]) {
    if (key in capped) capped[key] = capNumericPixelValue(capped[key], maxRangePx);
  }

  if ("detectionModes" in capped) capped.detectionModes = capDetectionModeRanges(token, capped.detectionModes);

  return capped;
}

function capInitializedVisionSource(token) {
  const maxRangePx = getMaxRangePx(token);
  const source = token?.vision;
  if (!maxRangePx || !source) return;

  try {
    if (source.data && typeof source.data === "object") {
      for (const key of ["radius", "externalRadius", "sightRange", "visionRange", "range"]) {
        if (key in source.data) source.data[key] = capNumericPixelValue(source.data[key], maxRangePx);
      }
    }

    if ("radius" in source) source.radius = capNumericPixelValue(source.radius, maxRangePx);
  } catch (err) {
    console.debug(`${MODULE_ID} | Could not mutate initialized vision source; source-data cap is still active.`, err);
  }
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

function canUseLibWrapper() {
  return typeof globalThis.libWrapper?.register === "function" && game.modules.get("lib-wrapper")?.active;
}

function registerLibWrapperOnce(target, wrapper, type = "WRAPPER") {
  if (!canUseLibWrapper()) return false;
  if (LIBWRAPPER_REGISTRATIONS.has(target)) return true;

  try {
    globalThis.libWrapper.register(MODULE_ID, target, wrapper, type);
    LIBWRAPPER_REGISTRATIONS.add(target);
    return true;
  } catch (err) {
    console.warn(`${MODULE_ID} | libWrapper registration failed for ${target}; falling back where possible.`, err);
    return false;
  }
}

function patchTokenVisionSourceData() {
  const target = "foundry.canvas.placeables.Token.prototype._getVisionSourceData";
  if (registerLibWrapperOnce(target, function visionRestrictorGetVisionSourceData(wrapped, ...args) {
    return capVisionSourceData(this, wrapped(...args));
  })) {
    console.log(`${MODULE_ID} | Token vision source data cap installed with libWrapper.`);
    return true;
  }

  const TokenClass = getTokenClass();
  const proto = TokenClass?.prototype;
  const current = proto?._getVisionSourceData;
  if (typeof current !== "function") {
    console.warn(`${MODULE_ID} | Could not find Token#_getVisionSourceData; vision source data cap was not installed.`);
    return false;
  }
  if (current[WRAPPED_GET_VISION_SOURCE_DATA]) return true;

  const wrapped = function visionRestrictorGetVisionSourceData(...args) {
    return capVisionSourceData(this, current.apply(this, args));
  };
  wrapped[WRAPPED_GET_VISION_SOURCE_DATA] = true;

  Object.defineProperty(proto, "_getVisionSourceData", {
    configurable: true,
    writable: true,
    value: wrapped
  });

  console.log(`${MODULE_ID} | Token vision source data cap installed directly.`);
  return true;
}

function patchTokenInitializeVisionSource() {
  const target = "foundry.canvas.placeables.Token.prototype.initializeVisionSource";
  if (registerLibWrapperOnce(target, function visionRestrictorInitializeVisionSource(wrapped, ...args) {
    const result = wrapped(...args);
    capInitializedVisionSource(this);
    return result;
  })) {
    console.log(`${MODULE_ID} | Token initializeVisionSource post-cap installed with libWrapper.`);
    return true;
  }

  const TokenClass = getTokenClass();
  const proto = TokenClass?.prototype;
  const current = proto?.initializeVisionSource;
  if (typeof current !== "function") return false;
  if (current[WRAPPED_INITIALIZE_VISION_SOURCE]) return true;

  const wrapped = function visionRestrictorInitializeVisionSource(...args) {
    const result = current.apply(this, args);
    capInitializedVisionSource(this);
    return result;
  };
  wrapped[WRAPPED_INITIALIZE_VISION_SOURCE] = true;

  Object.defineProperty(proto, "initializeVisionSource", {
    configurable: true,
    writable: true,
    value: wrapped
  });

  console.log(`${MODULE_ID} | Token initializeVisionSource post-cap installed directly.`);
  return true;
}

function patchTokenRangeGetters() {
  const TokenClass = getTokenClass();
  const proto = TokenClass?.prototype;
  if (!proto) {
    console.warn(`${MODULE_ID} | Could not find Foundry Token class; vision range getter cap was not installed.`);
    return false;
  }

  const sightRangeDescriptor = findPropertyDescriptor(proto, "sightRange");
  const optimalSightRangeDescriptor = findPropertyDescriptor(proto, "optimalSightRange");
  let installed = false;

  if (sightRangeDescriptor?.get && !sightRangeDescriptor.get[WRAPPED_SIGHT_RANGE]) {
    const originalGet = sightRangeDescriptor.get;
    const wrappedGet = function visionRestrictorSightRange() {
      return capPixelRange(this, originalGet.call(this));
    };
    wrappedGet[WRAPPED_SIGHT_RANGE] = true;

    Object.defineProperty(proto, "sightRange", {
      configurable: true,
      get: wrappedGet
    });
    installed = true;
  }

  if (optimalSightRangeDescriptor?.get && !optimalSightRangeDescriptor.get[WRAPPED_OPTIMAL_SIGHT_RANGE]) {
    const originalGet = optimalSightRangeDescriptor.get;
    const wrappedGet = function visionRestrictorOptimalSightRange() {
      return capPixelRange(this, originalGet.call(this));
    };
    wrappedGet[WRAPPED_OPTIMAL_SIGHT_RANGE] = true;

    Object.defineProperty(proto, "optimalSightRange", {
      configurable: true,
      get: wrappedGet
    });
    installed = true;
  }

  if (installed) console.log(`${MODULE_ID} | Token vision range getter cap installed.`);
  return installed;
}

function patchTokenVision() {
  const dataPatch = patchTokenVisionSourceData();
  const initializePatch = patchTokenInitializeVisionSource();
  const getterPatch = patchTokenRangeGetters();
  return dataPatch || initializePatch || getterPatch;
}

function refreshVision() {
  if (!canvas?.ready) return;

  try {
    canvas.visibility?.initializeSources?.();
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
    canvas.visibility?.refreshVisibility?.();
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
  form.querySelector(`[${SCENE_CONFIG_ATTR}]`)?.remove();

  const current = safeGetFlag(scene, MODULE_ID, FLAG_MAX_RANGE);
  const fieldset = document.createElement("fieldset");
  fieldset.classList.add("vision-restrictor-fieldset");
  fieldset.setAttribute(SCENE_CONFIG_ATTR, "true");

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

function getTokenDebug(token) {
  const sourceData = typeof token?._getVisionSourceData === "function" ? token._getVisionSourceData() : null;
  return {
    name: token?.name,
    sceneMaxRangeUnits: getSceneMaxRange(token?.scene),
    maxRangePx: getMaxRangePx(token),
    sightRange: token?.sightRange,
    optimalSightRange: token?.optimalSightRange,
    sourceData,
    initializedVisionSourceData: token?.vision?.data ?? null,
    initializedVisionSourceRadius: token?.vision?.data?.radius ?? token?.vision?.radius ?? null,
    canvasTokenVision: canvas?.visibility?.tokenVision,
    isGM: game.user.isGM,
    controlled: token?.controlled
  };
}

function debugControlledTokens() {
  return (canvas.tokens?.controlled ?? []).map((token) => getTokenDebug(token));
}

function debugState() {
  const scene = getActiveScene();
  return {
    moduleId: MODULE_ID,
    active: game.modules.get(MODULE_ID)?.active,
    libWrapperActive: canUseLibWrapper(),
    scene: scene?.name,
    sceneOverride: safeGetFlag(scene, MODULE_ID, FLAG_MAX_RANGE),
    worldDefault: game.settings.get(MODULE_ID, SETTING_DEFAULT_MAX_RANGE),
    effectiveMaxRangeUnits: getSceneMaxRange(scene),
    canvasReady: canvas?.ready,
    canvasTokenVision: canvas?.visibility?.tokenVision,
    controlledTokens: debugControlledTokens()
  };
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
  patchTokenVision();

  const module = game.modules.get(MODULE_ID);
  module.api = {
    getSceneMaxRange,
    setSceneMaxRange,
    clearSceneMaxRange: (scene = getActiveScene()) => setSceneMaxRange(null, scene),
    refreshVision,
    debugControlledTokens,
    debugState
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
