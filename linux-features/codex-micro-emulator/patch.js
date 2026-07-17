"use strict";

const BOOTSTRAP_MARKER = "function codexLinuxBootstrapCodexMicroEmulator(e)";
const PATCH_MARKER = "function codexLinuxCodexMicroEmulatorOptions()";
const SERVICE_IMPORT_PATTERN = /require\(`\.\/codex-micro-service-[^`]+\.js`\)/g;
const SERVICE_MANAGER_CONSTRUCTOR =
  "service=null;servicePromise=null;constructor(e){this.windowManager=e}";
const CONSTRUCTOR_TAIL =
  "onJoystickEvent:e=>{let t=this.windowManager.getPrimaryWindow();" +
  "t!=null&&this.windowManager.sendMessageToWindow(t,{type:`codex-micro-joystick-event`,event:e})}})";
const PATCH_SKIP_WARNING =
  "WARN: current Codex Micro service and manager constructors were not found exactly once - skipping Codex Micro emulator patch";

function countOccurrences(source, needle) {
  let count = 0;
  let index = 0;
  while ((index = source.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function helperSource() {
  return [
    "function codexLinuxCodexMicroEmulatorOptions(){",
    "let e=require(`node:path`),t=process.env.CODEX_LINUX_APP_DIR||e.dirname(process.resourcesPath);",
    "return require(e.join(t,`.codex-linux`,`features`,`codex-micro-emulator`,`emulator.cjs`)).createOptions()",
    "}",
  ].join("");
}

function bootstrapHelperSource() {
  return [
    "function codexLinuxBootstrapCodexMicroEmulator(e){",
    "void e.getState().catch(e=>console.error(`[codex-micro-emulator] automatic bootstrap failed`,e))",
    "}",
  ].join("");
}

function appendHelper(source) {
  const helper = `;${helperSource()};${bootstrapHelperSource()}`;
  const sourceMapIndex = source.lastIndexOf("\n//# sourceMappingURL=");
  if (sourceMapIndex === -1) return `${source}${helper}`;
  return `${source.slice(0, sourceMapIndex)}${helper}${source.slice(sourceMapIndex)}`;
}

function applyCodexMicroEmulatorPatch(source) {
  const hasOptionsHelper = source.includes(PATCH_MARKER);
  const hasBootstrapHelper = source.includes(BOOTSTRAP_MARKER);
  if (hasOptionsHelper && hasBootstrapHelper) return source;
  if (hasOptionsHelper || hasBootstrapHelper) {
    console.warn(PATCH_SKIP_WARNING);
    return source;
  }
  const imports = source.match(SERVICE_IMPORT_PATTERN) ?? [];
  const constructorCount = countOccurrences(source, CONSTRUCTOR_TAIL);
  const managerCount = countOccurrences(source, SERVICE_MANAGER_CONSTRUCTOR);
  if (imports.length !== 1 || constructorCount !== 1 || managerCount !== 1) {
    console.warn(PATCH_SKIP_WARNING);
    return source;
  }

  const serviceReplacement =
    `${CONSTRUCTOR_TAIL.slice(0, -2)},...codexLinuxCodexMicroEmulatorOptions()})`;
  const managerReplacement =
    `${SERVICE_MANAGER_CONSTRUCTOR.slice(0, -1)};codexLinuxBootstrapCodexMicroEmulator(this)}`;
  const patched = source
    .replace(CONSTRUCTOR_TAIL, serviceReplacement)
    .replace(SERVICE_MANAGER_CONSTRUCTOR, managerReplacement);
  return appendHelper(patched);
}

const descriptors = [
  {
    id: "codex-micro-emulator-main",
    phase: "main-bundle",
    order: 19_700,
    apply: applyCodexMicroEmulatorPatch,
  },
];

module.exports = {
  BOOTSTRAP_MARKER,
  CONSTRUCTOR_TAIL,
  PATCH_MARKER,
  SERVICE_MANAGER_CONSTRUCTOR,
  applyCodexMicroEmulatorPatch,
  bootstrapHelperSource,
  descriptors,
};
