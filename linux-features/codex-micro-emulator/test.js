#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const MODULE_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-module-"));
const ORIGINAL_STATE_DIR = process.env.CODEX_LINUX_APP_STATE_DIR;
const ORIGINAL_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
process.env.CODEX_LINUX_APP_STATE_DIR = path.join(MODULE_RUNTIME_ROOT, "state");
process.env.XDG_RUNTIME_DIR = path.join(MODULE_RUNTIME_ROOT, "runtime");
fs.mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });

const emulator = require("./emulator.cjs");
const {
  CodexMicroEmulatorRuntime,
  TraceWriter,
  buildDeterministicResponse,
  defaultRuntime,
  frameJsonRpc,
  resolveRuntimePaths,
} = emulator.__test;

const {
  enabledLinuxFeatureIds,
  enabledLinuxFeatureInstallPlan,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");

const FEATURE_DIR = __dirname;
const FEATURES_ROOT = path.resolve(FEATURE_DIR, "..");
const PATCH_SKIP_WARNING =
  "WARN: current Codex Micro service constructor was not found exactly once - skipping Codex Micro emulator patch";

test.after(async () => {
  await defaultRuntime.close();
  if (ORIGINAL_STATE_DIR == null) delete process.env.CODEX_LINUX_APP_STATE_DIR;
  else process.env.CODEX_LINUX_APP_STATE_DIR = ORIGINAL_STATE_DIR;
  if (ORIGINAL_RUNTIME_DIR == null) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = ORIGINAL_RUNTIME_DIR;
  fs.rmSync(MODULE_RUNTIME_ROOT, { recursive: true, force: true });
});

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

test("HID framing uses byte boundaries, headers, and zero padding", () => {
  const raw = JSON.stringify({ method: "v.oai.rgbcfg", params: { label: "あ".repeat(30) }, id: 7 });
  const bytes = Buffer.from(raw);
  const frames = frameJsonRpc(raw, 7);
  assert.equal(frames.length, Math.ceil(bytes.length / 61));
  assert.deepEqual(Buffer.concat(frames.map(({ report }) => report.subarray(3, 3 + report[2]))), bytes);
  for (const [index, frame] of frames.entries()) {
    assert.equal(frame.packet, index + 1);
    assert.equal(frame.packetCount, frames.length);
    assert.equal(frame.report.length, 64);
    assert.equal(frame.report[0], 0x06);
    assert.equal(frame.report[1], 0x02);
    assert.ok(frame.report[2] >= 1 && frame.report[2] <= 61);
    assert.ok(frame.report.subarray(3 + frame.report[2]).every((byte) => byte === 0));
  }
});

test("HID framing emits no report for an empty serialized request", () => {
  assert.deepEqual(frameJsonRpc("", null), []);
});

test("runtime paths use launcher state first and require XDG_RUNTIME_DIR", () => {
  assert.deepEqual(resolveRuntimePaths({
    CODEX_LINUX_APP_STATE_DIR: "/state/codex-desktop",
    XDG_RUNTIME_DIR: "/run/user/1000",
  }), {
    stateDir: "/state/codex-desktop/codex-micro-emulator",
    logPath: "/state/codex-desktop/codex-micro-emulator/events.jsonl",
    socketParent: "/run/user/1000/codex-desktop",
    socketPath: "/run/user/1000/codex-desktop/codex-micro-emulator.sock",
  });
  assert.equal(
    resolveRuntimePaths({ HOME: "/home/test", XDG_RUNTIME_DIR: "/run/user/1000" }).stateDir,
    "/home/test/.local/state/codex-desktop/codex-micro-emulator",
  );
  assert.throws(
    () => resolveRuntimePaths({ HOME: "/home/test" }),
    /requires XDG_RUNTIME_DIR/,
  );
});

test("deterministic responses preserve valid JSON id types", () => {
  assert.deepEqual(
    buildDeterministicResponse('{"method":"device.status","params":null,"id":17}', "17").body,
    {
      id: 17,
      result: {
        version: "codex-micro-emulator-1",
        profile_index: 0,
        layer_index: 0,
        battery: 100,
        is_charging: false,
      },
    },
  );
  assert.deepEqual(
    buildDeterministicResponse('{"method":"sys.version","params":null,"id":"s-1"}', "s-1").body,
    { id: "s-1", result: { version: "codex-micro-emulator-1" } },
  );
  for (const method of ["v.oai.rgbcfg", "v.oai.thstatus", "lights.preview"]) {
    assert.deepEqual(
      buildDeterministicResponse(JSON.stringify({ method, params: {}, id: 8 }), "8").body,
      { id: 8, result: {} },
    );
  }
  assert.deepEqual(
    buildDeterministicResponse('{"method":"unknown.method","params":null,"id":3}', "3").body,
    { id: 3, error: { code: -32601, message: "Unsupported method: unknown.method" } },
  );
  assert.deepEqual(
    buildDeterministicResponse("{bad", "9").body,
    { id: null, error: { code: -32700, message: "Parse error" } },
  );
});

test("trace sequence, modes, and rotation retain active plus two previous files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-trace-"));
  try {
    const writer = new TraceWriter({
      stateDir: root,
      session: "session-test",
      maxBytes: 220,
      now: () => new Date("2026-07-17T00:00:00.000Z"),
    });
    const records = Array.from({ length: 12 }, (_, index) =>
      writer.append("connection", { state: `state-${index}` }),
    );
    assert.deepEqual(records.map(({ seq }) => seq), Array.from({ length: 12 }, (_, index) => index + 1));
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(root, "events.jsonl")).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(root, "events.jsonl.1")), true);
    assert.equal(fs.existsSync(path.join(root, "events.jsonl.2")), true);
    assert.equal(fs.existsSync(path.join(root, "events.jsonl.3")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("trace fixes its envelope, validates its six types, and reports listener errors", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-envelope-"));
  const listenerErrors = [];
  try {
    const writer = new TraceWriter({
      stateDir: root,
      session: "session-fixed",
      now: () => new Date("2026-07-17T00:00:00.000Z"),
      onListenerError: (error) => listenerErrors.push(error.message),
    });
    let durableBeforeNotify = false;
    let laterListenerCalled = false;
    writer.subscribe((record, line) => {
      durableBeforeNotify = fs.readFileSync(writer.logPath, "utf8").endsWith(line);
      assert.equal(record.type, "connection");
      throw new Error("listener failed");
    });
    writer.subscribe(() => {
      laterListenerCalled = true;
    });
    const record = writer.append("connection", {
      schema: 99,
      ts: "caller-ts",
      session: "caller-session",
      seq: 99,
      type: "notify.rx",
      state: "connected",
    });
    assert.deepEqual(record, {
      schema: 1,
      ts: "2026-07-17T00:00:00.000Z",
      session: "session-fixed",
      seq: 1,
      type: "connection",
      state: "connected",
    });
    assert.equal(durableBeforeNotify, true);
    assert.equal(laterListenerCalled, true);
    assert.deepEqual(listenerErrors, ["listener failed"]);
    for (const type of ["session", "rpc.request", "hid.frame", "rpc.response", "notify.rx"]) {
      writer.append(type);
    }
    assert.throws(() => writer.append("other"), /Unsupported Codex Micro trace type: other/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fake discovery and communication implement upstream lifecycle and RPC", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-comm-"));
  const runtime = new CodexMicroEmulatorRuntime({
    stateDir: path.join(root, "state"),
    socketPath: path.join(root, "runtime", "codex-desktop", "codex-micro-emulator.sock"),
    autoStart: false,
  });
  try {
    runtime.initializeTrace();
    runtime.desiredConnected = true;
    const options = runtime.createOptions();
    assert.equal(Object.hasOwn(options, "createApi"), false);
    const [device] = options.discovery.findWLDevices(["project_2077"]);
    assert.equal(device.deviceType, "project_2077");
    assert.equal(device.connectionType, 1);
    const comm = options.createComm();
    const events = [];
    comm.onConnectionEvent((event) => events.push(event.type));
    assert.equal(await comm.connect(device), true);
    assert.equal(comm.isConnected(), true);
    const raw = '{"method":"device.status","params":null,"id":21}';
    assert.deepEqual(JSON.parse(await comm.sendJsonRpcRequest(raw, "21")), {
      id: 21,
      result: {
        version: "codex-micro-emulator-1",
        profile_index: 0,
        layer_index: 0,
        battery: 100,
        is_charging: false,
      },
    });
    const notifications = [];
    comm.addNotifyHandler("v.oai.hid", (params) => notifications.push(params));
    assert.equal(comm.deliverNotification("v.oai.hid", { k: "AG00", act: 1 }), true);
    comm.removeNotifyHandler("v.oai.hid");
    assert.equal(comm.deliverNotification("v.oai.hid", { k: "AG00", act: 0 }), false);
    assert.deepEqual(notifications, [{ k: "AG00", act: 1 }]);
    await comm.abortJsonRpcRequest("missing");
    comm.cleanCommQueue();
    await comm.disconnect();
    assert.equal(comm.isConnected(), false);
    assert.deepEqual(events, [0, 1]);
  } finally {
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("module singleton stays non-advertising until the socket task activates it", () => {
  const options = emulator.createOptions();
  assert.deepEqual(Object.keys(options).sort(), ["createComm", "discovery"]);
  assert.equal(defaultRuntime.desiredConnected, false);
  assert.equal(defaultRuntime.trace, null);
  assert.deepEqual(options.discovery.findWLDevices(["project_2077"]), []);
});
