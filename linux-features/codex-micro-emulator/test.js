#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
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
  recoverStaleSocket,
  resolveRuntimePaths,
  validateCommand,
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

async function withStartedRuntime(callback, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-runtime-"));
  const runtime = new CodexMicroEmulatorRuntime({
    stateDir: path.join(root, "state"),
    socketPath: path.join(root, "runtime", "codex-desktop", "codex-micro-emulator.sock"),
    autoStart: false,
    ...options,
  });
  try {
    await runtime.start();
    return await callback(runtime);
  } finally {
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function socketCommand(socketPath, request) {
  return socketLine(socketPath, Buffer.from(`${JSON.stringify(request)}\n`));
}

function socketLine(socketPath, line) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.end();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.once("connect", () => socket.write(line));
  });
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

test("module singleton advertises only after private startup resolves", async () => {
  assert.equal(await defaultRuntime.startPromise, true);
  const options = emulator.createOptions();
  assert.deepEqual(Object.keys(options).sort(), ["createComm", "discovery"]);
  assert.equal(defaultRuntime.desiredConnected, true);
  assert.notEqual(defaultRuntime.trace, null);
  assert.equal(fs.statSync(defaultRuntime.socketPath).isSocket(), true);
  assert.equal(options.discovery.findWLDevices(["project_2077"]).length, 1);
});

test("socket path and files use private permissions", async () => {
  await withStartedRuntime(async (runtime) => {
    assert.equal(fs.statSync(path.dirname(runtime.socketPath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(runtime.socketPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(runtime.trace.logPath).mode & 0o777, 0o600);
  });
});

test("typed key, encoder, and joystick commands reach only registered upstream methods", async () => {
  await withStartedRuntime(async (runtime) => {
    const options = runtime.createOptions();
    const comm = options.createComm();
    const [device] = options.discovery.findWLDevices(["project_2077"]);
    await comm.connect(device);
    const notifications = [];
    comm.addNotifyHandler("v.oai.hid", (params) => notifications.push(["hid", params]));
    comm.addNotifyHandler("v.oai.rad", (params) => notifications.push(["rad", params]));

    assert.equal((await socketCommand(runtime.socketPath, { command: "key", key: "AG00", action: "press" })).ok, true);
    assert.equal((await socketCommand(runtime.socketPath, { command: "key", key: "ENC_SW", action: "tap" })).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal((await socketCommand(runtime.socketPath, { command: "encoder", direction: "ccw", steps: 2 })).ok, true);
    assert.equal((await socketCommand(runtime.socketPath, { command: "joystick", direction: "up" })).ok, true);
    for (const direction of ["right", "down", "left", "center"]) {
      assert.equal((await socketCommand(runtime.socketPath, { command: "joystick", direction })).ok, true);
    }
    assert.deepEqual(notifications, [
      ["hid", { k: "AG00", act: 1 }],
      ["hid", { k: "ENC_SW", act: 1 }],
      ["hid", { k: "ENC_SW", act: 0 }],
      ["hid", { k: "ENC_CC", act: 2 }],
      ["hid", { k: "ENC_CC", act: 2 }],
      ["rad", { a: 0.75, d: 1 }],
      ["rad", { a: 0, d: 1 }],
      ["rad", { a: 0.25, d: 1 }],
      ["rad", { a: 0.5, d: 1 }],
      ["rad", { a: 0, d: 0 }],
    ]);
  });
});

test("invalid, oversized, and disconnected commands are rejected without dispatch", async () => {
  await withStartedRuntime(async (runtime) => {
    const invalid = await socketCommand(runtime.socketPath, { command: "key", key: "F13", action: "press" });
    assert.equal(invalid.error.code, "invalid_key");
    const malformed = await socketLine(runtime.socketPath, Buffer.from("{bad\n"));
    assert.equal(malformed.error.code, "malformed_json");
    const disconnected = await socketCommand(runtime.socketPath, { command: "key", key: "AG00", action: "press" });
    assert.equal(disconnected.error.code, "disconnected");
    const oversized = await socketLine(runtime.socketPath, Buffer.from(`${"あ".repeat(5_462)}\n`));
    assert.equal(oversized.error.code, "line_too_large");
  });
});

test("command validation rejects unknown fields and normalizes encoder steps", () => {
  assert.deepEqual(validateCommand({ command: "encoder", direction: "cw" }), {
    ok: true,
    value: { command: "encoder", direction: "cw", steps: 1 },
  });
  assert.equal(validateCommand({ command: "status", method: "device.status" }).error.code, "invalid_command");
  assert.equal(validateCommand({ command: "encoder", direction: "cw", steps: 0 }).error.code, "invalid_steps");
  assert.equal(validateCommand({ command: "joystick", direction: "north" }).error.code, "invalid_direction");
  assert.equal(validateCommand({ command: "key", key: "AG00", action: "hold" }).error.code, "invalid_action");
  assert.equal(validateCommand(Object.create(null)).error.code, "invalid_command");
});

test("disconnect hides discovery and connect restores it for retry", async () => {
  await withStartedRuntime(async (runtime) => {
    const options = runtime.createOptions();
    const comm = options.createComm();
    await comm.connect(options.discovery.findWLDevices(["project_2077"])[0]);
    assert.equal((await socketCommand(runtime.socketPath, { command: "disconnect" })).ok, true);
    assert.deepEqual(options.discovery.findWLDevices(["project_2077"]), []);
    assert.equal((await socketCommand(runtime.socketPath, { command: "connect" })).ok, true);
    assert.equal(options.discovery.findWLDevices(["project_2077"]).length, 1);
    const reconnected = options.createComm();
    assert.equal(await reconnected.connect(options.discovery.findWLDevices(["project_2077"])[0]), true);
    assert.equal(reconnected.isConnected(), true);
  });
});

test("watch acknowledges before streaming raw trace records", async () => {
  await withStartedRuntime(async (runtime) => {
    const records = await new Promise((resolve, reject) => {
      const socket = net.createConnection(runtime.socketPath);
      let buffer = "";
      const lines = [];
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          lines.push(JSON.parse(buffer.slice(0, newline)));
          buffer = buffer.slice(newline + 1);
          if (lines.length === 1) runtime.record("connection", { state: "watch-test" });
          if (lines.length === 2) {
            socket.end();
            resolve(lines);
          }
        }
      });
      socket.once("connect", () => socket.write('{"command":"watch"}\n'));
    });
    assert.deepEqual(records[0], { ok: true, result: { watching: true, session: runtime.session } });
    assert.equal(records[1].type, "connection");
    assert.equal(records[1].state, "watch-test");
  });
});

test("stale recovery rejects a live socket without stealing its path", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-live-socket-"));
  const socketPath = path.join(root, "emulator.sock");
  const server = net.createServer();
  try {
    server.listen(socketPath);
    await once(server, "listening");
    await assert.rejects(recoverStaleSocket({ socketPath }), /already active/);
    const accepted = once(server, "connection");
    const client = net.createConnection(socketPath);
    await once(client, "connect");
    const [acceptedClient] = await accepted;
    client.destroy();
    acceptedClient.destroy();
  } finally {
    if (server.listening) {
      server.close();
      await once(server, "close");
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("closeSync preserves a replacement whose socket identity changed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-identity-"));
  const socketPath = path.join(root, "runtime", "codex-desktop", "emulator.sock");
  const unlinks = [];
  const fsImpl = Object.create(fs);
  fsImpl.unlinkSync = (target) => {
    unlinks.push(target);
    return fs.unlinkSync(target);
  };
  const runtime = new CodexMicroEmulatorRuntime({
    fsImpl,
    stateDir: path.join(root, "state"),
    socketPath,
    autoStart: false,
  });
  try {
    await runtime.start();
    const originalLstat = fsImpl.lstatSync.bind(fsImpl);
    fsImpl.lstatSync = (target) => {
      const stat = originalLstat(target);
      return target === socketPath ? Object.assign(Object.create(stat), { ino: stat.ino + 1 }) : stat;
    };
    const server = runtime.server;
    runtime.closeSync();
    if (server.listening) await once(server, "close");
    assert.deepEqual(unlinks.filter((target) => target === socketPath), []);
  } finally {
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("trace failure closes discovery and communication before later input dispatch", async () => {
  let failAppend = false;
  const fsImpl = Object.create(fs);
  fsImpl.appendFileSync = (...args) => {
    if (failAppend) throw new Error("simulated trace failure");
    return fs.appendFileSync(...args);
  };
  await withStartedRuntime(async (runtime) => {
    const options = runtime.createOptions();
    const comm = options.createComm();
    await comm.connect(options.discovery.findWLDevices(["project_2077"])[0]);
    const events = [];
    const notifications = [];
    comm.onConnectionEvent((event) => events.push(event.type));
    comm.addNotifyHandler("v.oai.hid", (params) => notifications.push(params));
    failAppend = true;

    const failed = await socketCommand(runtime.socketPath, { command: "key", key: "AG00", action: "press" });
    assert.ok(["trace_failed", "disconnected"].includes(failed.error.code));
    assert.deepEqual(events, [2]);
    assert.equal(runtime.state, "error");
    assert.equal(comm.isConnected(), false);
    assert.deepEqual(options.discovery.findWLDevices(["project_2077"]), []);
    const later = await socketCommand(runtime.socketPath, { command: "key", key: "AG00", action: "press" });
    assert.ok(["trace_failed", "disconnected"].includes(later.error.code));
    assert.deepEqual(notifications, []);
  }, { fsImpl });
});

test("close releases its socket even when the disconnect trace append fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-close-failure-"));
  const socketPath = path.join(root, "runtime", "codex-desktop", "emulator.sock");
  let failAppend = false;
  const fsImpl = Object.create(fs);
  fsImpl.appendFileSync = (...args) => {
    if (failAppend) throw new Error("simulated close trace failure");
    return fs.appendFileSync(...args);
  };
  const runtime = new CodexMicroEmulatorRuntime({
    fsImpl,
    stateDir: path.join(root, "state"),
    socketPath,
    autoStart: false,
  });
  let server;
  try {
    await runtime.start();
    const options = runtime.createOptions();
    const comm = options.createComm();
    await comm.connect(options.discovery.findWLDevices(["project_2077"])[0]);
    server = runtime.server;
    failAppend = true;
    await assert.rejects(runtime.close(), /simulated close trace failure/);
    assert.equal(runtime.server, null);
    assert.equal(server.listening, false);
    assert.equal(fs.existsSync(socketPath), false);
  } finally {
    if (server?.listening) {
      server.close();
      await once(server, "close");
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
