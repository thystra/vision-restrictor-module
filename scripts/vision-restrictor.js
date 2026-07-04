const MODULE_ID = "vision-restrictor-module";
const FLAG_MAX_RANGE = "maxRange";
const SETTING_DEFAULT_MAX_RANGE = "defaultMaxRange";

let originalSightRangeDescriptor = null;
let originalOptimalSightRangeDescriptor = null;
let tokenRangeGettersPatched = false;

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

function getWorldDefaultRange() {
  try {
    return normalizeRange(game.settings.get(MODULE_ID, SETTING_DEFAULT_MAX_RANGE)) ?? 0;
  } catch (err) {
    console.warn(`${MODULE_ID} | Could not read world default vision range; treating as disabled.`, err);
    return 0;
  }
}

function getSceneMaxRange(scene = getActiveScene()) {
  const sceneValue = normalizeRange(safeGetFlag(scene, MODULE_ID, FLAG_MAX_RANGE));
  if (sceneValue !== null) return sceneValue;

  return getWorldDefaultRange();
}

function rangeUnitsToPixels(rangeUnits) {
  const dimensions = canvas?.dimensions;
  if (!dimensions?.size || !dimensions?.distance) return null;
  return (rangeUnits * dimensions.size) / dimensions.distance;
}

function getTokenScene(token) {
  return token?.scene ?? token?.document?.parent ?? getActiveScene();
}

function capPixelRange(token, originalRangePx) {
  const maxRangeUnits = getSceneMaxRange(getTokenScene(token));
  if (!maxRangeUnits) return originalRangePx;

  const maxRangePx = rangeUnitsToPixels(maxRangeUnits);
  if (!Number.isFinite(maxRangePx) || maxRangePx <= 0) return originalRangePx;

  // Do not grant vision. Only cap vision that already exists.
  if (originalRangePx === Number.POSITIVE_INFINITY) return maxRangePx;
  if (!Number.isFinite(originalRangePx)) return originalRangePx;
  if (originalRangePx <= 0) return originalRangePx;

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
  if (tokenRangeGettersPatched) return;

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

  tokenRangeGettersPatched = true;
  console.log(`${MODULE_ID} | Token vision range cap installed.`);
}

function refreshVision() {
  if (!canvas?.ready) return;

  for (const token of canvas.tokens?.placeables ?? []) {
    try {
      token.initializeSources?.();
    } catch (err) {
      console.warn(`${MODULE_ID} | Could not reinitialize vision sources for token ${token?.name ?? token?.id ?? "unknown"}.`, err);
    }
  }

  try {
    canvas.perception?.update?.({
      initializeLighting: true,
      initializeVision: true,
      refreshLighting: true,
      refreshVision: true,
      refreshTiles: true
    }, true);
  } catch (err) {
    console.warn(`${MODULE_ID} | Could not refresh canvas perception.`, err);
  }

  try {
    canvas.effects?.refreshLighting?.();
    canvas.visibility?.refresh?.();
  } catch (err) {
    console.warn(`${MODULE_ID} | Could not refresh lighting or visibility layers.`, err);
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

function getFormElement(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  return null;
}

function findSceneConfigTarget(form) {
  const selectors = [
    '[data-application-part="visibility"]',
    '.tab[data-tab="visibility"]',
    'section[data-tab="visibility"]',
    '[data-tab="visibility"]',
    '.tab.active',
    'section.active'
  ];

  for (const selector of selectors) {
    const target = form.querySelector(selector);
    if (target) return target;
  }

  return form;
}

function injectSceneConfig(app, html) {
  if (!game.user.isGM) return;

  const element = getFormElement(html);
  if (!element) return;

  const scene = app.document ?? app.object;
  if (!scene) return;

  const form = element.querySelector("form") ?? element;
  const existing = form.querySelector(`[data-${MODULE_ID}-scene-config]`);
  if (existing) existing.remove();

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
  input.placeholder = String(getWorldDefaultRange());
  input.value = current === null || current === undefined ? "" : String(current);

  inputWrapper.append(input);
  formGroup.append(label, inputWrapper);
  fieldset.append(formGroup);

  const hint = document.createElement("p");
  hint.classList.add("hint");
  hint.textContent = localize("sceneConfig.fieldHint");
  fieldset.append(hint);

  findSceneConfigTarget(form).append(fieldset);
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
  const exactFlagPath = `flags.${MODULE_ID}.${FLAG_MAX_RANGE}`;
  const moduleFlagPath = `flags.${MODULE_ID}`;

  if (
    foundry.utils.hasProperty(changes, exactFlagPath)
    || foundry.utils.hasProperty(changes, moduleFlagPath)
  ) {
    refreshVision();
  }
});

Hooks.on("renderSceneConfig", injectSceneConfig);
