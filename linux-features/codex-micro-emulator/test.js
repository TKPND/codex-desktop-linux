#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  enabledLinuxFeatureIds,
  enabledLinuxFeatureInstallPlan,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");

const FEATURE_DIR = __dirname;
const FEATURES_ROOT = path.resolve(FEATURE_DIR, "..");
const PATCH_SKIP_WARNING =
  "WARN: current Codex Micro service constructor was not found exactly once - skipping Codex Micro emulator patch";

function withFeatureConfig(enabled, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-feature-"));
  const configPath = path.join(root, "features.json");
  const previous = process.env.CODEX_LINUX_FEATURES_CONFIG;
  fs.writeFileSync(configPath, `${JSON.stringify({ enabled })}\n`);
  process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
  try {
    return callback();
  } finally {
    if (previous == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    else process.env.CODEX_LINUX_FEATURES_CONFIG = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function currentMainBundleFixture() {
  return [
    "const codexMicroUntouchedBefore=42;",
    "class eS{getService(){return this.service==null?(this.servicePromise??=",
    "Promise.resolve().then(()=>require(`./codex-micro-service-CR6sUcZG.js`))",
    ".then(({CodexMicroService:e})=>{let t=new e({",
    "onDeviceStateChanged:e=>{this.windowManager.sendMessageToAllWindows({type:`codex-micro-device-state-changed`,state:e})},",
    "onHidEvent:e=>{let t=this.windowManager.getPrimaryWindow();t!=null&&this.windowManager.sendMessageToWindow(t,{type:`codex-micro-hid-event`,event:e})},",
    "onJoystickEvent:e=>{let t=this.windowManager.getPrimaryWindow();t!=null&&this.windowManager.sendMessageToWindow(t,{type:`codex-micro-joystick-event`,event:e})}",
    "});return this.service=t,t}))}",
    ";const codexMicroUntouchedAfter=7;",
  ].join("");
}

test("codex-micro-emulator remains disabled until selected", () => {
  withFeatureConfig([], () => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: FEATURES_ROOT }), []);
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot: FEATURES_ROOT }), []);
  });
});

test("manifest exposes one patch and two declarative resources", () => {
  withFeatureConfig(["codex-micro-emulator"], () => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: FEATURES_ROOT }), ["codex-micro-emulator"]);
    const descriptors = loadLinuxFeaturePatchDescriptors({ featuresRoot: FEATURES_ROOT });
    assert.deepEqual(descriptors.map(({ id }) => id), [
      "feature:codex-micro-emulator:codex-micro-emulator-main",
    ]);
    const plan = enabledLinuxFeatureInstallPlan({ featuresRoot: FEATURES_ROOT });
    assert.deepEqual(
      plan.resources.map(({ target, mode }) => [target, mode]),
      [
        [".codex-linux/features/codex-micro-emulator/emulator.cjs", 0o644],
        ["resources/native/codex-micro-emulator", 0o755],
      ],
    );
    assert.deepEqual(plan.runtimeHooks, []);
  });
});

test("patch injects one staged module load and is byte-idempotent", () => {
  const { applyCodexMicroEmulatorPatch, PATCH_MARKER } = require("./patch.js");
  const source = currentMainBundleFixture();
  const patched = applyCodexMicroEmulatorPatch(source);
  assert.notEqual(patched, source);
  assert.equal(applyCodexMicroEmulatorPatch(patched), patched);
  assert.equal(patched.split(PATCH_MARKER).length - 1, 1);
  assert.match(patched, /\.\.\.codexLinuxCodexMicroEmulatorOptions\(\)/);
  assert.match(patched, /\.codex-linux.*codex-micro-emulator.*emulator\.cjs/);
  assert.match(patched, /onDeviceStateChanged/);
  assert.match(patched, /onHidEvent/);
  assert.match(patched, /onJoystickEvent/);
  assert.equal(patched.split("const codexMicroUntouchedBefore=42;").length - 1, 1);
  assert.equal(patched.split("const codexMicroUntouchedAfter=7;").length - 1, 1);
});

test("patch fails closed when the current constructor is absent or duplicated", () => {
  const { applyCodexMicroEmulatorPatch } = require("./patch.js");
  const source = currentMainBundleFixture();
  const warnings = [];
  const previousWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const missing = source.replace("onJoystickEvent", "onStickEvent");
    assert.equal(applyCodexMicroEmulatorPatch(missing), missing);
    const duplicated = `${source};${source}`;
    assert.equal(applyCodexMicroEmulatorPatch(duplicated), duplicated);
  } finally {
    console.warn = previousWarn;
  }
  assert.deepEqual(warnings, [PATCH_SKIP_WARNING, PATCH_SKIP_WARNING]);
});
