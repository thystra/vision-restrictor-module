const MODULE_ID = "vision-restrictor-module";
const FLAG_MAX_RANGE = "maxRange";
const SETTING_DEFAULT_MAX_RANGE = "defaultMaxRange";
const SETTING_HARD_MASK_ALPHA = "hardMaskAlpha";

const WRAPPED_GET_VISION_SOURCE_DATA = Symbol.for(`${MODULE_ID}.wrappedGetVisionSourceData`);
const WRAPPED_INITIALIZE_VISION_SOURCE = Symbol.for(`${MODULE_ID}.wrappedInitializeVisionSource`);
const WRAPPED_SIGHT_RANGE = Symbol.for(`${MODULE_ID}.wrappedSightRange`);
const WRAPPED_OPTIMAL_SIGHT_RANGE = Symbol.for(`${MODULE_ID}.wrappedOptimalSightRange`);

let originalSightRangeDescriptor = null;
let originalOptimalSightRangeDescriptor = null;
let hardMask = null;
let lastHardMaskHoles = [];

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
  // VisionSource. This caps the underlying source, while the hard mask below
  // handles globally illuminated scenes where the scene itself remains visible.
  for (const key of ["radius", "sightRange", "visionRange", "range", "externalRadius"]) {
    if (key in capped) capped[key] = capPixelRange(token, Number(capped[key]));
  }

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

  if (!current[WRAPPED_GET_VISION_SOURCE_DATA]) {
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
  }

  const currentInitialize = proto.initializeVisionSource;
  if (typeof currentInitialize === "function" && !currentInitialize[WRAPPED_INITIALIZE_VISION_SOURCE]) {
    const wrappedInitialize = function visionRestrictorInitializeVisionSource(...args) {
      const result = currentInitialize.apply(this, args);
      capInitializedVisionSource(this);
      queueHardMaskRefresh();
      return result;
    };
    wrappedInitialize[WRAPPED_INITIALIZE_VISION_SOURCE] = true;
    wrappedInitialize._visionRestrictorOriginal = currentInitialize;

    Object.defineProperty(proto, "initializeVisionSource", {
      configurable: true,
      writable: true,
      value: wrappedInitialize
    });

    console.log(`${MODULE_ID} | Token vision source initialize cap installed.`);
  }

  return true;
}

function setMutableCappedRange(target, key, token) {
  if (!target || typeof target !== "object" || !(key in target)) return;

  const current = Number(target[key]);
  const capped = capPixelRange(token, current);
  if (!Number.isFinite(capped) || capped === current) return;

  try {
    target[key] = capped;
  } catch (err) {
    // Some Foundry V14 VisionSource fields are getter-only. Never let a
    // defensive cap attempt break token control, movement, or player canvas
    // rendering.
    console.debug(`${MODULE_ID} | Skipped read-only vision source field ${key}.`, err);
  }
}

function capInitializedVisionSource(token) {
  const maxRangePx = getMaxRangePx(token);
  if (!maxRangePx || !token?.vision) return;

  const source = token.vision;
  const dataTargets = [];
  if (source.data && typeof source.data === "object") dataTargets.push(source.data);
  if (source._source && typeof source._source === "object" && source._source !== source.data) dataTargets.push(source._source);

  for (const data of dataTargets) {
    for (const key of ["radius", "externalRadius", "sightRange", "visionRange", "range"]) {
      setMutableCappedRange(data, key, token);
    }
  }

  // Do not assign directly to PointVisionSource#radius or similar source
  // accessors. In Foundry V14 some of these are getter-only, and throwing here
  // breaks token control and drag movement. The _getVisionSourceData wrapper is
  // the authoritative cap for newly initialized source data; this function is
  // only best-effort cleanup of mutable data bags.
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

function getSceneRect() {
  const d = canvas?.dimensions;
  if (!d) return { x: 0, y: 0, width: 0, height: 0 };

  const r = d.sceneRect ?? d.rect ?? null;
  if (r && Number.isFinite(r.width) && Number.isFinite(r.height)) {
    return { x: r.x ?? 0, y: r.y ?? 0, width: r.width, height: r.height };
  }

  return {
    x: d.sceneX ?? 0,
    y: d.sceneY ?? 0,
    width: d.sceneWidth ?? d.width ?? 0,
    height: d.sceneHeight ?? d.height ?? 0
  };
}

function getHardMaskAlpha() {
  const alpha = Number(game.settings.get(MODULE_ID, SETTING_HARD_MASK_ALPHA));
  if (!Number.isFinite(alpha)) return 1;
  return Math.clamp ? Math.clamp(alpha, 0, 1) : Math.max(0, Math.min(1, alpha));
}

function ensureHardMask() {
  if (!canvas?.stage || !globalThis.PIXI?.Graphics) return null;

  if (!hardMask || hardMask.destroyed) {
    hardMask = new PIXI.Graphics();
    hardMask.name = `${MODULE_ID}.hardVisionMask`;
    hardMask.eventMode = "none";
    hardMask.interactive = false;
    hardMask.interactiveChildren = false;
    hardMask.hitArea = null;
    hardMask.zIndex = 1_000_000;
  }

  if (hardMask.parent !== canvas.stage) canvas.stage.addChild(hardMask);
  // addChild on an existing child moves it to the top, which matters if other
  // canvas groups are added after us during a redraw.
  canvas.stage.addChild(hardMask);
  return hardMask;
}

function hideHardMask() {
  lastHardMaskHoles = [];
  if (!hardMask) return;
  hardMask.visible = false;
  try { hardMask.clear(); } catch (_) { /* no-op */ }
}

function tokenOwnedByUser(token) {
  if (!token) return false;
  if (game.user?.isGM) return true;
  if (token.document?.hidden) return false;
  if (token.controlled) return true;

  try {
    if (typeof token.actor?.testUserPermission === "function" && token.actor.testUserPermission(game.user, "OWNER")) return true;
  } catch (_) { /* no-op */ }

  try {
    if (typeof token.document?.testUserPermission === "function" && token.document.testUserPermission(game.user, "OWNER")) return true;
  } catch (_) { /* no-op */ }

  return Boolean(token.actor?.isOwner ?? token.document?.isOwner ?? token.isOwner ?? false);
}

function getVisionRestrictorPovTokens() {
  if (!canvas?.tokens) return [];

  const controlled = canvas.tokens.controlled ?? [];
  let tokens = controlled;

  // Players normally see through controlled tokens, but if none are controlled
  // they may still see through all tokens they own. Preserve that behavior.
  if (!tokens.length && !game.user.isGM) {
    tokens = (canvas.tokens.placeables ?? []).filter(tokenOwnedByUser);
  }

  // Do not impose a hard GM mask unless the GM has explicitly hooked/controlled
  // one or more tokens. This keeps scene prep usable.
  if (!tokens.length) return [];

  return tokens.filter((token) => {
    if (!token || token.destroyed) return false;
    if (token.document?.hidden && !game.user.isGM) return false;
    if (token.document?.sight?.enabled === false) return false;
    if (!getMaxRangePx(token)) return false;

    const sourceData = safeVisionSourceData(token);
    if (sourceData?.disabled === true) return false;
    return true;
  });
}

function safeVisionSourceData(token) {
  try {
    return typeof token?._getVisionSourceData === "function" ? token._getVisionSourceData() : null;
  } catch (err) {
    console.warn(`${MODULE_ID} | Could not read token vision source data for ${token?.name ?? "token"}.`, err);
    return null;
  }
}

function getHardMaskRadiusPx(token) {
  // The hard blackout mask represents an environmental visibility limit
  // such as fog, smoke, haze, or magical obscurity. It should use the
  // configured scene-unit range directly, not the token's currently active
  // sense radius. This matters for special senses such as blindsight: a token
  // may have a 10 ft blindsight source while still being in a globally lit
  // scene where the environmental fog cap should be 55 ft.
  return getMaxRangePx(token);
}

function drawHardMaskV8(graphics, rect, holes, alpha) {
  graphics.clear();
  graphics.rect(rect.x, rect.y, rect.width, rect.height).fill({ color: 0x000000, alpha });
  for (const hole of holes) graphics.circle(hole.x, hole.y, hole.radius).cut();
}

function drawHardMaskLegacy(graphics, rect, holes, alpha) {
  graphics.clear();
  graphics.beginFill(0x000000, alpha);
  graphics.drawRect(rect.x, rect.y, rect.width, rect.height);
  for (const hole of holes) {
    graphics.beginHole();
    graphics.drawCircle(hole.x, hole.y, hole.radius);
    graphics.endHole();
  }
  graphics.endFill();
}

function refreshHardMask() {
  if (!canvas?.ready) {
    hideHardMask();
    return;
  }

  const maxRange = getSceneMaxRange();
  if (!maxRange) {
    hideHardMask();
    return;
  }

  // Only mask scenes that use token vision. Without token vision, there is no
  // POV token selection to follow.
  if (canvas.visibility?.tokenVision === false) {
    hideHardMask();
    return;
  }

  const povTokens = getVisionRestrictorPovTokens();
  if (!povTokens.length) {
    hideHardMask();
    return;
  }

  const holes = povTokens.map((token) => {
    const center = token.center ?? { x: token.x, y: token.y };
    return {
      x: center.x,
      y: center.y,
      radius: getHardMaskRadiusPx(token),
      token
    };
  }).filter((hole) => Number.isFinite(hole.x) && Number.isFinite(hole.y) && Number.isFinite(hole.radius) && hole.radius > 0);

  if (!holes.length) {
    hideHardMask();
    return;
  }

  lastHardMaskHoles = holes.map((hole) => ({
    tokenName: hole.token?.name ?? null,
    x: hole.x,
    y: hole.y,
    radius: hole.radius
  }));

  const graphics = ensureHardMask();
  if (!graphics) return;

  const rect = getSceneRect();
  const alpha = getHardMaskAlpha();

  try {
    if (typeof graphics.rect === "function" && typeof graphics.circle === "function" && typeof graphics.cut === "function") {
      drawHardMaskV8(graphics, rect, holes, alpha);
    } else {
      drawHardMaskLegacy(graphics, rect, holes, alpha);
    }
    graphics.visible = alpha > 0;
  } catch (err) {
    console.warn(`${MODULE_ID} | Could not draw hard vision mask.`, err);
    hideHardMask();
  }
}

function queueHardMaskRefresh() {
  if (typeof foundry?.utils?.debounce === "function") return debouncedHardMaskRefresh();
  return setTimeout(refreshHardMask, 0);
}

const debouncedHardMaskRefresh = foundry?.utils?.debounce
  ? foundry.utils.debounce(refreshHardMask, 25)
  : refreshHardMask;

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

  queueHardMaskRefresh();
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
  fieldset.setAttribute(`data-${MODULE_ID}-scene-config`, "true");

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

  const target = form.querySelector('[data-application-part="visibility"]')
    ?? form.querySelector('.tab[data-tab="visibility"]')
    ?? form.querySelector('[data-tab="visibility"]')
    ?? form.querySelector('.tab.active')
    ?? form;

  target.append(fieldset);
}

function debugState() {
  return {
    moduleId: MODULE_ID,
    active: game.modules.get(MODULE_ID)?.active ?? false,
    libWrapperActive: Boolean(globalThis.libWrapper?.register),
    scene: getActiveScene()?.name ?? null,
    sceneOverride: safeGetFlag(getActiveScene(), MODULE_ID, FLAG_MAX_RANGE),
    worldDefault: game.settings.get(MODULE_ID, SETTING_DEFAULT_MAX_RANGE),
    effectiveMaxRangeUnits: getSceneMaxRange(),
    hardMaskAlpha: getHardMaskAlpha(),
    hardMaskVisible: hardMask?.visible ?? false,
    hardMaskParent: hardMask?.parent?.name ?? hardMask?.parent?.constructor?.name ?? null,
    hardMaskHoles: lastHardMaskHoles,
    canvasReady: canvas?.ready ?? false,
    canvasTokenVision: canvas?.visibility?.tokenVision ?? null,
    controlledTokens: debugControlledTokens()
  };
}

function debugControlledTokens() {
  return (canvas.tokens?.controlled ?? []).map((token) => {
    const sourceData = safeVisionSourceData(token);
    const initializedVisionSourceData = token.vision?.data ?? token.vision?._source ?? null;

    return {
      name: token.name,
      sceneMaxRangeUnits: getSceneMaxRange(token.scene),
      maxRangePx: getMaxRangePx(token),
      hardMaskRadiusPx: getHardMaskRadiusPx(token),
      sightRange: token.sightRange,
      optimalSightRange: token.optimalSightRange,
      sourceData,
      initializedVisionSourceData,
      initializedVisionSourceRadius: token.vision?.data?.radius ?? token.vision?.radius ?? null,
      canvasTokenVision: canvas?.visibility?.tokenVision ?? null,
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

  game.settings.register(MODULE_ID, SETTING_HARD_MASK_ALPHA, {
    name: localize("settings.hardMaskAlpha.name"),
    hint: localize("settings.hardMaskAlpha.hint"),
    scope: "world",
    config: true,
    restricted: true,
    type: Number,
    default: 1,
    onChange: queueHardMaskRefresh
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
    refreshHardMask,
    debugState,
    debugControlledTokens
  };

  refreshVision();
});

Hooks.on("canvasReady", () => {
  patchTokenVision();
  refreshVision();
});

Hooks.on("canvasTearDown", () => {
  hideHardMask();
  hardMask = null;
});

Hooks.on("updateScene", (scene, changes) => {
  if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAG_MAX_RANGE}`)) refreshVision();
});

Hooks.on("controlToken", queueHardMaskRefresh);
Hooks.on("refreshToken", queueHardMaskRefresh);
Hooks.on("updateToken", queueHardMaskRefresh);
Hooks.on("createToken", queueHardMaskRefresh);
Hooks.on("deleteToken", queueHardMaskRefresh);
Hooks.on("sightRefresh", queueHardMaskRefresh);
Hooks.on("visibilityRefresh", queueHardMaskRefresh);
Hooks.on("renderSceneConfig", injectSceneConfig);
