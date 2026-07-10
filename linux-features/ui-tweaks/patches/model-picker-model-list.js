"use strict";

const MODEL_PICKER_STATE_ASSET_PATTERN =
  /^app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-[^.]+\.js$/;
const MODEL_PICKER_MENU_ASSET_PATTERN =
  /^app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~k0ede4gb-[^.]+\.js$/;
const SIMPLE_MENU_VIEW_PATTERN =
  /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(`composer-model-picker-menu-view-v1`,`simple`\)/;
const ADVANCED_MENU_VIEW_PATTERN =
  /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(`composer-model-picker-menu-view-v2`,`advanced`\)/;
const MODEL_TITLE_MARKER = "composer.intelligenceDropdown.model.title";
const MODEL_ROW_MARKER = "composer.intelligenceDropdown.model.rowLabel";
const EFFORT_TITLE_MARKER = "composer.intelligenceDropdown.effort.title";
const INLINE_MODEL_LIST_RUNTIME_MARKER = "codex-linux-inline-model-list";
const MODEL_ALLOWLIST_MARKER = "l?t.has(n.model):!n.hidden";
const GPT_56_ALLOWLIST_MARKER =
  "l?t.has(n.model)||n.model.startsWith(`gpt-5.6-`)&&!n.hidden:!n.hidden";

function warn(message) {
  console.warn(`WARN: ${message} - skipping ui-tweaks model picker patch`);
}

function modelPickerConfig(context) {
  const defaults = context?.feature?.manifest?.tweaks?.modelPicker?.showModelsByDefault;
  const settings = context?.feature?.settings?.tweaks?.modelPicker?.showModelsByDefault;
  return {
    ...(defaults != null && typeof defaults === "object" && !Array.isArray(defaults) ? defaults : {}),
    ...(settings != null && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
  };
}

function enabled(context) {
  return modelPickerConfig(context).enabled !== false;
}

function applyDefaultAdvancedViewPatch(source, context = {}) {
  try {
    if (typeof source !== "string") {
      warn("Asset source is not a string");
      return source;
    }
    if (!enabled(context) || ADVANCED_MENU_VIEW_PATTERN.test(source)) {
      return source;
    }
    if (!SIMPLE_MENU_VIEW_PATTERN.test(source)) {
      if (context.warnOnMissingMarkers === true) {
        warn("Could not find the persisted model picker view marker");
      }
      return source;
    }

    return source.replace(
      SIMPLE_MENU_VIEW_PATTERN,
      '$1=$2(`composer-model-picker-menu-view-v2`,`advanced`)',
    );
  } catch (error) {
    warn(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return source;
  }
}

function findInlineModelListVariable(source) {
  const titleIndex = source.indexOf(MODEL_TITLE_MARKER);
  const rowIndex = source.indexOf(MODEL_ROW_MARKER, titleIndex);
  if (titleIndex < 0 || rowIndex < 0) {
    return null;
  }

  const section = source.slice(titleIndex, rowIndex);
  const assignments = [
    ...section.matchAll(/let\s+([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*),[A-Za-z_$][\w$]*;/g),
  ];
  return assignments.at(-1)?.[1] ?? null;
}

function applyInlineModelListPatch(source, context = {}) {
  try {
    if (typeof source !== "string") {
      warn("Asset source is not a string");
      return source;
    }
    if (!enabled(context) || source.includes(INLINE_MODEL_LIST_RUNTIME_MARKER)) {
      return source;
    }

    const inlineModelListVariable = findInlineModelListVariable(source);
    const effortIndex = source.indexOf(EFFORT_TITLE_MARKER);
    if (inlineModelListVariable == null || effortIndex < 0) {
      if (context.warnOnMissingMarkers === true) {
        warn("Could not find the model list and advanced picker markers");
      }
      return source;
    }

    const tail = source.slice(effortIndex);
    const advancedChildrenPattern =
      /(let\s+[A-Za-z_$][\w$]*=\(0,([A-Za-z_$][\w$]*)\.jsxs\)\(\2\.Fragment,\{children:\[)([A-Za-z_$][\w$]*),/;
    const match = tail.match(advancedChildrenPattern);
    if (match == null) {
      if (context.warnOnMissingMarkers === true) {
        warn("Could not find the advanced picker child list");
      }
      return source;
    }

    const patchedTail = tail.replace(
      advancedChildrenPattern,
      `$1${inlineModelListVariable},/*${INLINE_MODEL_LIST_RUNTIME_MARKER}*/`,
    );
    return source.slice(0, effortIndex) + patchedTail;
  } catch (error) {
    warn(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return source;
  }
}

function applyGpt56AllowlistPatch(source, context = {}) {
  try {
    if (typeof source !== "string") {
      warn("Asset source is not a string");
      return source;
    }
    if (!enabled(context) || source.includes(GPT_56_ALLOWLIST_MARKER)) {
      return source;
    }
    if (!source.includes(MODEL_ALLOWLIST_MARKER)) {
      if (context.warnOnMissingMarkers === true) {
        warn("Could not find the model availability allowlist marker");
      }
      return source;
    }

    return source.replace(MODEL_ALLOWLIST_MARKER, GPT_56_ALLOWLIST_MARKER);
  } catch (error) {
    warn(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return source;
  }
}

function applyModelPickerModelListPatch(source, context = {}) {
  return applyInlineModelListPatch(
    applyGpt56AllowlistPatch(applyDefaultAdvancedViewPatch(source, context), context),
    context,
  );
}

const descriptors = [
  {
    id: "model-picker-default-advanced-view",
    phase: "webview-asset",
    order: 20_794,
    ciPolicy: "optional",
    pattern: MODEL_PICKER_STATE_ASSET_PATTERN,
    missingDescription: "composer model picker state bundle",
    skipDescription: "ui-tweaks model picker default advanced view patch",
    apply: (source, context = {}) =>
      applyDefaultAdvancedViewPatch(source, { ...context, warnOnMissingMarkers: true }),
  },
  {
    id: "model-picker-include-gpt-5-6",
    phase: "webview-asset",
    order: 20_795,
    ciPolicy: "optional",
    pattern: MODEL_PICKER_MENU_ASSET_PATTERN,
    missingDescription: "composer model picker menu bundle",
    skipDescription: "ui-tweaks GPT-5.6 model allowlist patch",
    apply: (source, context = {}) =>
      applyGpt56AllowlistPatch(source, { ...context, warnOnMissingMarkers: true }),
  },
  {
    id: "model-picker-inline-model-list",
    phase: "webview-asset",
    order: 20_796,
    ciPolicy: "optional",
    pattern: MODEL_PICKER_MENU_ASSET_PATTERN,
    missingDescription: "composer model picker menu bundle",
    skipDescription: "ui-tweaks model picker inline model list patch",
    apply: (source, context = {}) =>
      applyInlineModelListPatch(source, { ...context, warnOnMissingMarkers: true }),
  },
];

module.exports = {
  ADVANCED_MENU_VIEW_PATTERN,
  EFFORT_TITLE_MARKER,
  GPT_56_ALLOWLIST_MARKER,
  INLINE_MODEL_LIST_RUNTIME_MARKER,
  MODEL_ALLOWLIST_MARKER,
  MODEL_PICKER_MENU_ASSET_PATTERN,
  MODEL_PICKER_STATE_ASSET_PATTERN,
  MODEL_ROW_MARKER,
  MODEL_TITLE_MARKER,
  SIMPLE_MENU_VIEW_PATTERN,
  applyDefaultAdvancedViewPatch,
  applyGpt56AllowlistPatch,
  applyInlineModelListPatch,
  applyModelPickerModelListPatch,
  descriptors,
  findInlineModelListVariable,
};
