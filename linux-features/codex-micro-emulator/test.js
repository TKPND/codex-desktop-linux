#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { EventEmitter, once } = require("node:events");
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
  stageEnabledLinuxFeatureInstall,
} = require("../../scripts/lib/linux-features.js");

const FEATURE_DIR = __dirname;
const FEATURES_ROOT = path.resolve(FEATURE_DIR, "..");
const CLI = path.join(FEATURE_DIR, "bin", "codex-micro-emulator");
const PYTHON = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0 ? "python3" : null;

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

function cliEnv(runtime) {
  return {
    ...process.env,
    XDG_RUNTIME_DIR: path.dirname(path.dirname(runtime.socketPath)),
  };
}

function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [CLI, ...args], {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function waitFor(predicate, message, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      try {
        if (predicate()) {
          resolve();
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(message));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

async function withCliResponse(responseText, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-cli-response-"));
  const runtimeDir = path.join(root, "runtime");
  const socketDir = path.join(runtimeDir, "codex-desktop");
  const socketPath = path.join(socketDir, "codex-micro-emulator.sock");
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end(`${responseText}\n`));
  });
  try {
    server.listen(socketPath);
    await once(server, "listening");
    return await callback({ runtimeDir, socketPath });
  } finally {
    if (server.listening) {
      server.close();
      await once(server, "close");
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertNormalizedCliFailure(result) {
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^codex-micro-emulator: [^\r\n]+\n$/);
  assert.doesNotMatch(result.stderr, /Traceback/);
  assert.doesNotMatch(result.stderr, /None/);
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

function fakeClientSocket({ writeResults = [] } = {}) {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.writableEnded = false;
  socket.paused = false;
  socket.writes = [];
  socket.ends = [];
  socket.write = (data) => {
    socket.writes.push(data);
    return writeResults.length === 0 ? true : writeResults.shift();
  };
  socket.end = (data) => {
    socket.ends.push(data);
    socket.writableEnded = true;
  };
  socket.destroy = () => {
    if (socket.destroyed) return;
    socket.destroyed = true;
    socket.emit("close");
  };
  socket.pause = () => {
    socket.paused = true;
  };
  return socket;
}

async function assertReplacementSocketSurvivesClose(closeMode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-replacement-"));
  const socketPath = path.join(root, "runtime", "codex-desktop", "emulator.sock");
  const runtime = new CodexMicroEmulatorRuntime({
    stateDir: path.join(root, "state"),
    socketPath,
    autoStart: false,
  });
  const replacement = net.createServer((socket) => socket.end("replacement"));
  try {
    await runtime.start();
    fs.unlinkSync(socketPath);
    replacement.listen(socketPath);
    await once(replacement, "listening");
    const replacementIdentity = fs.lstatSync(socketPath);

    if (closeMode === "sync") {
      const closed = once(runtime.server, "close");
      runtime.closeSync();
      await closed;
    } else {
      await runtime.close();
    }

    assert.equal(fs.existsSync(socketPath), true);
    const currentIdentity = fs.lstatSync(socketPath);
    assert.deepEqual(
      { dev: currentIdentity.dev, ino: currentIdentity.ino },
      { dev: replacementIdentity.dev, ino: replacementIdentity.ino },
    );
    const reply = await new Promise((resolve, reject) => {
      const client = net.createConnection(socketPath);
      let response = "";
      client.once("error", reject);
      client.on("data", (chunk) => {
        response += chunk.toString("utf8");
      });
      client.once("end", () => resolve(response));
    });
    assert.equal(reply, "replacement");
  } finally {
    if (!runtime.closed) await runtime.close();
    if (replacement.listening) {
      const closed = once(replacement, "close");
      replacement.close();
      await closed;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test("declarative staging preserves module and CLI targets and modes", () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-stage-"));
  try {
    withFeatureConfig(["codex-micro-emulator"], () => {
      stageEnabledLinuxFeatureInstall(appDir, { featuresRoot: FEATURES_ROOT });
    });
    const modulePath = path.join(appDir, ".codex-linux", "features", "codex-micro-emulator", "emulator.cjs");
    const cliPath = path.join(appDir, "resources", "native", "codex-micro-emulator");
    assert.equal(fs.statSync(modulePath).mode & 0o777, 0o644);
    assert.equal(fs.statSync(cliPath).mode & 0o777, 0o755);
    assert.equal(fs.readFileSync(modulePath, "utf8"), fs.readFileSync(path.join(FEATURE_DIR, "emulator.cjs"), "utf8"));
    assert.equal(fs.readFileSync(cliPath, "utf8"), fs.readFileSync(path.join(FEATURE_DIR, "bin", "codex-micro-emulator"), "utf8"));
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
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

test("non-object JSON-RPC requests return and trace Invalid Request", async () => {
  for (const raw of ["null", "[]"]) {
    const parsed = buildDeterministicResponse(raw, "transport-id");
    assert.deepEqual(parsed.body, {
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    });
    assert.equal(parsed.method, null);
    assert.equal(parsed.request, null);
    assert.equal(parsed.unsupported, false);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-invalid-rpc-"));
  const runtime = new CodexMicroEmulatorRuntime({
    stateDir: path.join(root, "state"),
    socketPath: path.join(root, "runtime", "codex-desktop", "codex-micro-emulator.sock"),
    autoStart: false,
  });
  try {
    runtime.initializeTrace();
    runtime.desiredConnected = true;
    const options = runtime.createOptions();
    const comm = options.createComm();
    await comm.connect(options.discovery.findWLDevices(["project_2077"])[0]);
    assert.deepEqual(JSON.parse(await comm.sendJsonRpcRequest("null", "transport-id")), {
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    });
    const records = fs.readFileSync(runtime.logPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(records.slice(-4).map(({ type, id, method, raw }) => ({ type, id, method, raw })), [
      { type: "connection", id: undefined, method: undefined, raw: undefined },
      { type: "rpc.request", id: null, method: null, raw: "null" },
      { type: "hid.frame", id: undefined, method: undefined, raw: undefined },
      {
        type: "rpc.response",
        id: null,
        method: null,
        raw: '{"id":null,"error":{"code":-32600,"message":"Invalid Request"}}',
      },
    ]);
  } finally {
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test("rotated trace preserves full RPC and notification record order", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-order-"));
  const runtime = new CodexMicroEmulatorRuntime({
    stateDir: path.join(root, "state"),
    socketPath: path.join(root, "runtime", "codex-desktop", "codex-micro-emulator.sock"),
    autoStart: false,
  });
  try {
    await runtime.start();
    runtime.trace.maxBytes = 900;
    const options = runtime.createOptions();
    const comm = options.createComm();
    const [device] = options.discovery.findWLDevices(["project_2077"]);
    await comm.connect(device);
    comm.addNotifyHandler("v.oai.hid", () => {});
    const raw = JSON.stringify({ method: "v.oai.rgbcfg", params: { payload: "x".repeat(40) }, id: 7 });
    const rawBytes = Buffer.byteLength(raw);
    assert.ok(rawBytes > 61);
    assert.ok(rawBytes <= 122);
    await comm.sendJsonRpcRequest(raw, "7");
    assert.equal(runtime.dispatchNotification("v.oai.hid", { k: "AG00", act: 1 }), true);

    const generations = [
      `${runtime.logPath}.2`,
      `${runtime.logPath}.1`,
      runtime.logPath,
    ];
    assert.deepEqual(generations.map((logPath) => fs.existsSync(logPath)), [true, true, true]);
    const records = generations
      .filter((logPath) => fs.existsSync(logPath))
      .flatMap((logPath) => fs.readFileSync(logPath, "utf8").trim().split("\n"))
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(({ session }) => session === runtime.session);
    const types = records.map(({ type }) => type);
    const frameRecords = records.filter(({ type }) => type === "hid.frame");
    const requestIndex = types.indexOf("rpc.request");
    const responseIndex = types.indexOf("rpc.response");
    const frameIndexes = types.flatMap((type, index) => type === "hid.frame" ? [index] : []);
    assert.ok(frameRecords.length > 1);
    assert.deepEqual(frameRecords.map(({ packet }) => packet), [1, 2]);
    assert.deepEqual(frameRecords.map(({ packetCount }) => packetCount), [2, 2]);
    assert.deepEqual(frameIndexes, [requestIndex + 1, requestIndex + 2]);
    assert.equal(responseIndex, frameIndexes.at(-1) + 1);
    assert.deepEqual(types, [
      "session",
      "connection",
      "connection",
      "rpc.request",
      "hid.frame",
      "hid.frame",
      "rpc.response",
      "notify.rx",
    ]);
    assert.deepEqual(records.map(({ seq }) => seq), records.map((_, index) => index + 1));
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

test("tap release never crosses a disconnect and reconnect boundary", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-tap-identity-"));
  const timers = [];
  const runtime = new CodexMicroEmulatorRuntime({
    stateDir: path.join(root, "state"),
    socketPath: path.join(root, "runtime", "codex-desktop", "codex-micro-emulator.sock"),
    autoStart: false,
    setTimer(callback) {
      const timer = { callback };
      timers.push(timer);
      return timer;
    },
    clearTimer() {},
  });
  try {
    runtime.initializeTrace();
    runtime.desiredConnected = true;
    const options = runtime.createOptions();
    const first = options.createComm();
    await first.connect(options.discovery.findWLDevices(["project_2077"])[0]);
    const firstEvents = [];
    first.addNotifyHandler("v.oai.hid", (params) => firstEvents.push(params));
    assert.equal(runtime.sendKey("ENC_SW", "tap").ok, true);
    assert.deepEqual(firstEvents, [{ k: "ENC_SW", act: 1 }]);
    assert.equal(timers.length, 1);

    await first.disconnect();
    const second = options.createComm();
    await second.connect(options.discovery.findWLDevices(["project_2077"])[0]);
    const secondEvents = [];
    second.addNotifyHandler("v.oai.hid", (params) => secondEvents.push(params));
    timers[0].callback();

    assert.deepEqual(firstEvents, [{ k: "ENC_SW", act: 1 }]);
    assert.deepEqual(secondEvents, []);
  } finally {
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test("connect is idempotent while upstream communication remains connected", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-connect-idempotent-"));
  const runtime = new CodexMicroEmulatorRuntime({
    stateDir: path.join(root, "state"),
    socketPath: path.join(root, "runtime", "codex-desktop", "codex-micro-emulator.sock"),
    autoStart: false,
  });
  try {
    runtime.initializeTrace();
    runtime.desiredConnected = true;
    const options = runtime.createOptions();
    const comm = options.createComm();
    await comm.connect(options.discovery.findWLDevices(["project_2077"])[0]);
    const before = fs.readFileSync(runtime.logPath, "utf8");

    assert.deepEqual(runtime.requestConnect(), { ok: true, result: runtime.status() });
    assert.equal(runtime.state, "connected");
    assert.equal(runtime.desiredConnected, true);
    assert.equal(runtime.currentComm, comm);
    assert.equal(fs.readFileSync(runtime.logPath, "utf8"), before);
  } finally {
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test("watch dedicates one control connection to exactly one trace subscription", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-watch-dedicated-"));
  const runtime = new CodexMicroEmulatorRuntime({
    stateDir: path.join(root, "state"),
    socketPath: path.join(root, "runtime", "codex-desktop", "emulator.sock"),
    autoStart: false,
  });
  const socket = fakeClientSocket();
  try {
    runtime.initializeTrace();
    runtime.acceptClient(socket);
    socket.emit("data", Buffer.from('{"command":"watch"}\n{"command":"watch"}\n'));
    await new Promise(setImmediate);

    assert.equal(runtime.trace.listeners.size, 1);
    assert.equal(socket.writes.length, 1);
    assert.equal(socket.paused, true);
  } finally {
    socket.destroy();
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("watch unsubscribes and destroys its socket on the first write backpressure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-watch-backpressure-"));
  const runtime = new CodexMicroEmulatorRuntime({
    stateDir: path.join(root, "state"),
    socketPath: path.join(root, "runtime", "codex-desktop", "emulator.sock"),
    autoStart: false,
  });
  const socket = fakeClientSocket({ writeResults: [true, false] });
  try {
    runtime.initializeTrace();
    runtime.beginWatch(socket);
    assert.equal(runtime.trace.listeners.size, 1);

    runtime.record("connection", { state: "slow-watch" });
    assert.equal(socket.destroyed, true);
    assert.equal(runtime.trace.listeners.size, 0);
  } finally {
    socket.destroy();
    runtime.closeSync();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("control input bounds queued command count and bytes before dispatch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-control-bounds-"));
  const runtime = new CodexMicroEmulatorRuntime({
    stateDir: path.join(root, "state"),
    socketPath: path.join(root, "runtime", "codex-desktop", "emulator.sock"),
    autoStart: false,
  });
  const countSocket = fakeClientSocket();
  const bytesSocket = fakeClientSocket();
  try {
    runtime.initializeTrace();
    runtime.acceptClient(countSocket);
    countSocket.emit("data", Buffer.from('{"command":"status"}\n'.repeat(33)));
    assert.equal(JSON.parse(countSocket.ends[0]).error.code, "input_overflow");

    runtime.acceptClient(bytesSocket);
    bytesSocket.emit("data", Buffer.from(`${" ".repeat(16_384)}\n`.repeat(9)));
    assert.equal(JSON.parse(bytesSocket.ends[0]).error.code, "input_overflow");
    await new Promise(setImmediate);
    assert.deepEqual(countSocket.writes, []);
    assert.deepEqual(bytesSocket.writes, []);
  } finally {
    countSocket.destroy();
    bytesSocket.destroy();
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI rejects invalid keys and encoder ranges before connecting", { skip: PYTHON == null }, () => {
  const badKey = spawnSync(PYTHON, [CLI, "key", "F13", "press"], { encoding: "utf8" });
  assert.equal(badKey.status, 2);
  assert.match(badKey.stderr, /invalid choice/);
  const badSteps = spawnSync(PYTHON, [CLI, "encoder", "cw", "--steps", "101"], { encoding: "utf8" });
  assert.equal(badSteps.status, 2);
  assert.match(badSteps.stderr, /between 1 and 100/);
});

test("CLI status and typed input use the runtime socket", { skip: PYTHON == null }, async () => {
  await withStartedRuntime(async (runtime) => {
    const options = runtime.createOptions();
    const comm = options.createComm();
    await comm.connect(options.discovery.findWLDevices(["project_2077"])[0]);
    const received = [];
    comm.addNotifyHandler("v.oai.hid", (params) => received.push(params));
    const status = await runCli(["status"], { env: cliEnv(runtime) });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(
      status.stdout,
      `state=connected connected=true discoverable=true log=${runtime.logPath} socket=${runtime.socketPath}\n`,
    );
    const key = await runCli(["key", "ACT06", "press"], { env: cliEnv(runtime) });
    assert.equal(key.status, 0, key.stderr);
    assert.deepEqual(received, [{ k: "ACT06", act: 1 }]);
  });
});

test("CLI normalizes broader socket OSError failures", { skip: PYTHON == null }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-cli-oserror-"));
  const runtimeFile = path.join(root, "runtime-file");
  fs.writeFileSync(runtimeFile, "not a directory");
  try {
    const result = await runCli(["status"], {
      env: { ...process.env, XDG_RUNTIME_DIR: runtimeFile },
    });
    assertNormalizedCliFailure(result);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI rejects a valid JSON response with a non-object top level", { skip: PYTHON == null }, async () => {
  await withCliResponse("[]", async ({ runtimeDir }) => {
    const result = await runCli(["status"], {
      env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir },
    });
    assertNormalizedCliFailure(result);
  });
});

test("CLI rejects a valid JSON response with a malformed error field", { skip: PYTHON == null }, async () => {
  await withCliResponse('{"ok":false,"error":"denied"}', async ({ runtimeDir }) => {
    const result = await runCli(["status"], {
      env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir },
    });
    assertNormalizedCliFailure(result);
  });
});

test("CLI rejects a valid JSON response with a malformed result field", { skip: PYTHON == null }, async () => {
  await withCliResponse('{"ok":true,"result":[]}', async ({ runtimeDir }) => {
    const result = await runCli(["status"], {
      env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir },
    });
    assertNormalizedCliFailure(result);
  });
});

test("CLI rejects an incomplete successful status without printing None fields", { skip: PYTHON == null }, async () => {
  await withCliResponse('{"ok":true,"result":{"state":"connected","connected":true}}', async ({ runtimeDir }) => {
    const result = await runCli(["status"], {
      env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir },
    });
    assertNormalizedCliFailure(result);
  });
});

test("CLI human watch rejects a non-object trace record without a traceback", { skip: PYTHON == null }, async () => {
  await withCliResponse('{"ok":true,"result":{"watching":true}}\nnull', async ({ runtimeDir }) => {
    const result = await runCli(["watch"], {
      env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir },
    });
    assertNormalizedCliFailure(result);
    assert.match(result.stderr, /malformed trace record/);
  });
});

test("CLI raw watch streams byte-preserved trace records and exits with its child", { skip: PYTHON == null }, async () => {
  await withStartedRuntime(async (runtime) => {
    const child = spawn(PYTHON, [CLI, "watch", "--raw"], {
      env: cliEnv(runtime),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let closedResult;
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => {
        closedResult = { status, signal };
        resolve(closedResult);
      });
    });
    let killed = false;
    try {
      await waitFor(
        () => runtime.trace.listeners.size === 1 || child.exitCode != null,
        "CLI watch did not subscribe to the trace",
      );
      assert.equal(runtime.trace.listeners.size, 1, stderr);
      const record = runtime.record("connection", { state: "cli-watch" });
      const expectedLine = `${JSON.stringify(record)}\n`;
      await waitFor(() => stdout.includes('"state":"cli-watch"'), "CLI watch did not stream the trace record");
      assert.equal(stdout.slice(stdout.indexOf(expectedLine)), expectedLine);
    } finally {
      if (child.exitCode == null && child.signalCode == null) killed = child.kill("SIGTERM");
      await closed;
      if (killed) assert.equal(closedResult.signal, "SIGTERM", stderr);
    }
  });
});

test("CLI raw watch treats a closed stdout pipe as a clean exit", { skip: PYTHON == null }, async () => {
  await withStartedRuntime(async (runtime) => {
    const child = spawn(PYTHON, [CLI, "watch", "--raw"], {
      env: cliEnv(runtime),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => resolve({ status, signal }));
    });
    let result;
    try {
      await waitFor(
        () => runtime.trace.listeners.size === 1 || child.exitCode != null,
        "CLI watch did not subscribe before the pipe was closed",
      );
      assert.equal(runtime.trace.listeners.size, 1, stderr);
      child.stdout.destroy();
      runtime.record("connection", { state: "broken-pipe", detail: "x".repeat(128 * 1024) });
      await waitFor(() => child.exitCode != null, "CLI watch did not exit after BrokenPipeError");
      result = await closed;
      assert.deepEqual(result, { status: 0, signal: null });
      assert.equal(stderr, "");
    } finally {
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
      if (result == null) await closed;
    }
  });
});

test("CLI human watch renders high-signal trace fields", { skip: PYTHON == null }, async () => {
  await withStartedRuntime(async (runtime) => {
    const child = spawn(PYTHON, [CLI, "watch"], {
      env: cliEnv(runtime),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let closedResult;
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => {
        closedResult = { status, signal };
        resolve(closedResult);
      });
    });
    let killed = false;
    try {
      await waitFor(
        () => runtime.trace.listeners.size === 1 || child.exitCode != null,
        "CLI human watch did not subscribe to the trace",
      );
      assert.equal(runtime.trace.listeners.size, 1, stderr);
      runtime.record("rpc.request", { id: 7, method: "device.status", raw: '{"method":"device.status","id":7}' });
      runtime.record("hid.frame", {
        rpcId: 7,
        packet: 1,
        packetCount: 2,
        payloadLength: 61,
        reportHex: "0602",
      });
      runtime.record("rpc.response", { id: 7, method: "device.status", raw: '{"id":7,"result":{}}' });
      runtime.record("notify.rx", { method: "v.oai.hid", params: { k: "AG00", act: 1 } });
      const expected = [
        'rpc.request id=7 method=device.status raw={"method":"device.status","id":7}',
        "hid.frame rpc=7 packet=1/2 bytes=61 0602",
        'rpc.response id=7 method=device.status raw={"id":7,"result":{}}',
        'notify.rx method=v.oai.hid params={"k":"AG00","act":1}',
        "",
      ].join("\n");
      await waitFor(
        () => stdout === expected || child.exitCode != null,
        "CLI human watch did not render the trace records",
      );
      assert.equal(stdout, expected, stderr);
    } finally {
      if (child.exitCode == null && child.signalCode == null) killed = child.kill("SIGTERM");
      await closed;
      if (killed) assert.equal(closedResult.signal, "SIGTERM", stderr);
    }
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

test("replacement socket survives asynchronous runtime close", async () => {
  await assertReplacementSocketSurvivesClose("async");
});

test("replacement socket survives synchronous runtime close", async () => {
  await assertReplacementSocketSurvivesClose("sync");
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

test("disconnect trace failure emits upstream ERROR instead of DISCONNECTED", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-disconnect-trace-failure-"));
  let failAppend = false;
  const fsImpl = Object.create(fs);
  fsImpl.appendFileSync = (...args) => {
    if (failAppend) throw new Error("simulated disconnect trace failure");
    return fs.appendFileSync(...args);
  };
  const runtime = new CodexMicroEmulatorRuntime({
    fsImpl,
    stateDir: path.join(root, "state"),
    socketPath: path.join(root, "runtime", "codex-desktop", "emulator.sock"),
    autoStart: false,
  });
  try {
    runtime.initializeTrace();
    runtime.desiredConnected = true;
    const options = runtime.createOptions();
    const comm = options.createComm();
    await comm.connect(options.discovery.findWLDevices(["project_2077"])[0]);
    const events = [];
    comm.onConnectionEvent((event) => events.push(event.type));
    failAppend = true;

    await assert.rejects(comm.disconnect(), /simulated disconnect trace failure/);
    assert.deepEqual(events, [2]);
    assert.equal(comm.isConnected(), false);
    assert.equal(runtime.currentComm, null);
    assert.equal(runtime.state, "error");
  } finally {
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
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
