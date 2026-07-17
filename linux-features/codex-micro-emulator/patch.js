"use strict";

const PATCH_MARKER = "function codexLinuxCodexMicroEmulatorOptions()";
const SERVICE_IMPORT_PATTERN = /require\(`\.\/codex-micro-service-[^`]+\.js`\)/g;
const CONSTRUCTOR_TAIL =
  "onJoystickEvent:e=>{let t=this.windowManager.getPrimaryWindow();" +
  "t!=null&&this.windowManager.sendMessageToWindow(t,{type:`codex-micro-joystick-event`,event:e})}})";

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

function appendHelper(source) {
  const helper = `;${helperSource()}`;
  const sourceMapIndex = source.lastIndexOf("\n//# sourceMappingURL=");
  if (sourceMapIndex === -1) return `${source}${helper}`;
  return `${source.slice(0, sourceMapIndex)}${helper}${source.slice(sourceMapIndex)}`;
}

function applyCodexMicroEmulatorPatch(source) {
  if (source.includes(PATCH_MARKER)) return source;
  const imports = source.match(SERVICE_IMPORT_PATTERN) ?? [];
  const constructorCount = countOccurrences(source, CONSTRUCTOR_TAIL);
  if (imports.length !== 1 || constructorCount !== 1) {
    console.warn(
      "WARN: current Codex Micro service constructor was not found exactly once - skipping Codex Micro emulator patch",
    );
    return source;
  }
  const replacement = `${CONSTRUCTOR_TAIL.slice(0, -2)},...codexLinuxCodexMicroEmulatorOptions()})`;
  return appendHelper(source.replace(CONSTRUCTOR_TAIL, replacement));
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
  CONSTRUCTOR_TAIL,
  PATCH_MARKER,
  applyCodexMicroEmulatorPatch,
  descriptors,
};
