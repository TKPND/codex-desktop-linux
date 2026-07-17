"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const SCHEMA = 1;
const VERSION = "codex-micro-emulator-1";
const REPORT_SIZE = 64;
const MAX_CHUNK_SIZE = 61;
const REPORT_ID = 0x06;
const RPC_CHANNEL = 0x02;
const MAX_TRACE_BYTES = 5 * 1024 * 1024;
const PREVIOUS_TRACE_FILES = 2;
const MAX_SOCKET_LINE_BYTES = 16_384;
const TAP_DELAY_MS = 50;

const ALLOWED_KEYS = new Set([
  "AG00", "AG01", "AG02", "AG03", "AG04", "AG05",
  "ACT06", "ACT07", "ACT08", "ACT09", "ACT10", "ACT11", "ACT12",
  "ENC_SW",
]);
const KEY_ACTIONS = new Set(["press", "release", "tap"]);
const ENCODER_DIRECTIONS = new Set(["cw", "ccw"]);
const JOYSTICK = Object.freeze({
  up: Object.freeze({ a: 0.75, d: 1 }),
  right: Object.freeze({ a: 0, d: 1 }),
  down: Object.freeze({ a: 0.25, d: 1 }),
  left: Object.freeze({ a: 0.5, d: 1 }),
  center: Object.freeze({ a: 0, d: 0 }),
});
const NOTIFICATION_METHODS = new Set(["v.oai.hid", "v.oai.rad"]);

const TRACE_TYPES = new Set([
  "session",
  "connection",
  "rpc.request",
  "hid.frame",
  "rpc.response",
  "notify.rx",
]);

const VIRTUAL_DEVICE = Object.freeze({
  portPath: "codex-micro-emulator",
  devicePid: String(0x8360),
  connectionType: 1,
  deviceType: "project_2077",
  layoutType: "unknown",
  isUsbConnection: true,
});

function resolveRuntimePaths(env = process.env) {
  const stateBase = env.CODEX_LINUX_APP_STATE_DIR ||
    env.XDG_STATE_HOME && path.join(env.XDG_STATE_HOME, "codex-desktop") ||
    env.HOME && path.join(env.HOME, ".local", "state", "codex-desktop");
  if (!stateBase) throw new Error("Codex Micro emulator state directory is unavailable");
  if (!env.XDG_RUNTIME_DIR) throw new Error("Codex Micro emulator requires XDG_RUNTIME_DIR");
  return {
    stateDir: path.join(stateBase, "codex-micro-emulator"),
    logPath: path.join(stateBase, "codex-micro-emulator", "events.jsonl"),
    socketParent: path.join(env.XDG_RUNTIME_DIR, "codex-desktop"),
    socketPath: path.join(env.XDG_RUNTIME_DIR, "codex-desktop", "codex-micro-emulator.sock"),
  };
}

function commandError(code, message) {
  return { ok: false, error: { code, message } };
}

function hasExactKeys(value, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key));
}

function validateCommand(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    return commandError("invalid_command", "Command must be a plain object");
  }

  switch (value.command) {
    case "status":
    case "watch":
    case "connect":
    case "disconnect":
      if (!hasExactKeys(value, ["command"])) {
        return commandError("invalid_command", `Unknown field for ${value.command} command`);
      }
      return { ok: true, value: { command: value.command } };
    case "key":
      if (!hasExactKeys(value, ["command", "key", "action"])) {
        return commandError("invalid_command", "Key command requires only command, key, and action");
      }
      if (!ALLOWED_KEYS.has(value.key)) {
        return commandError("invalid_key", `Unsupported key: ${String(value.key)}`);
      }
      if (!KEY_ACTIONS.has(value.action)) {
        return commandError("invalid_action", `Unsupported key action: ${String(value.action)}`);
      }
      return { ok: true, value: { command: "key", key: value.key, action: value.action } };
    case "encoder": {
      if (!hasExactKeys(value, ["command", "direction"], ["steps"])) {
        return commandError("invalid_command", "Encoder command requires direction and optional steps");
      }
      if (!ENCODER_DIRECTIONS.has(value.direction)) {
        return commandError("invalid_direction", `Unsupported encoder direction: ${String(value.direction)}`);
      }
      const steps = value.steps ?? 1;
      if (!Number.isInteger(steps) || steps < 1 || steps > 100) {
        return commandError("invalid_steps", "Encoder steps must be an integer from 1 through 100");
      }
      return { ok: true, value: { command: "encoder", direction: value.direction, steps } };
    }
    case "joystick":
      if (!hasExactKeys(value, ["command", "direction"])) {
        return commandError("invalid_command", "Joystick command requires only command and direction");
      }
      if (!Object.hasOwn(JOYSTICK, value.direction)) {
        return commandError("invalid_direction", `Unsupported joystick direction: ${String(value.direction)}`);
      }
      return { ok: true, value: { command: "joystick", direction: value.direction } };
    default:
      return commandError("invalid_command", `Unsupported command: ${String(value.command)}`);
  }
}

function lstatIfPresent(socketPath, fsImpl) {
  try {
    return fsImpl.lstatSync(socketPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function sameIdentity(left, right) {
  return left != null && right != null && left.dev === right.dev && left.ino === right.ino;
}

async function recoverStaleSocket({ socketPath, fsImpl = fs, netImpl = net }) {
  const original = lstatIfPresent(socketPath, fsImpl);
  if (!original) return;
  if (!original.isSocket()) {
    throw new Error("Codex Micro emulator socket path is not a socket");
  }
  if (typeof process.getuid === "function" && original.uid !== process.getuid()) {
    throw new Error("Codex Micro emulator socket is owned by another user");
  }

  const outcome = await new Promise((resolve) => {
    const probe = netImpl.createConnection(socketPath);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      probe.removeAllListeners("connect");
      probe.removeAllListeners("error");
      probe.destroy?.();
      resolve(result);
    };
    probe.once("connect", () => finish({ active: true }));
    probe.once("error", (error) => finish({ error }));
  });

  if (outcome.active) {
    throw new Error("Codex Micro emulator socket is already active");
  }
  if (outcome.error?.code === "ENOENT") return;
  if (outcome.error?.code !== "ECONNREFUSED") throw outcome.error;

  const current = lstatIfPresent(socketPath, fsImpl);
  if (!current) return;
  if (!sameIdentity(original, current)) {
    throw new Error("Codex Micro emulator socket changed during stale recovery");
  }
  fsImpl.unlinkSync(socketPath);
}

function frameJsonRpc(raw, rpcId) {
  const bytes = Buffer.from(raw);
  const packetCount = Math.ceil(bytes.length / MAX_CHUNK_SIZE);
  const frames = [];
  for (let offset = 0, packet = 1; offset < bytes.length; offset += MAX_CHUNK_SIZE, packet += 1) {
    const payload = bytes.subarray(offset, Math.min(offset + MAX_CHUNK_SIZE, bytes.length));
    const report = Buffer.alloc(REPORT_SIZE);
    report[0] = REPORT_ID;
    report[1] = RPC_CHANNEL;
    report[2] = payload.length;
    payload.copy(report, 3);
    frames.push({ rpcId, packet, packetCount, payloadLength: payload.length, report });
  }
  return frames;
}

function buildDeterministicResponse(raw, transportId) {
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    const body = { id: null, error: { code: -32700, message: "Parse error" } };
    return { body, method: null, request: null, raw: JSON.stringify(body), unsupported: false };
  }
  const id = Object.hasOwn(request, "id") ? request.id : transportId ?? null;
  let body;
  let unsupported = false;
  switch (request.method) {
    case "device.status":
      body = {
        id,
        result: {
          version: VERSION,
          profile_index: 0,
          layer_index: 0,
          battery: 100,
          is_charging: false,
        },
      };
      break;
    case "sys.version":
      body = { id, result: { version: VERSION } };
      break;
    case "v.oai.rgbcfg":
    case "v.oai.thstatus":
    case "lights.preview":
      body = { id, result: {} };
      break;
    default:
      unsupported = true;
      body = { id, error: { code: -32601, message: `Unsupported method: ${String(request.method)}` } };
      break;
  }
  return { body, method: request.method ?? null, request, raw: JSON.stringify(body), unsupported };
}

class TraceWriter {
  constructor({
    stateDir,
    session = crypto.randomUUID(),
    maxBytes = MAX_TRACE_BYTES,
    previousFiles = PREVIOUS_TRACE_FILES,
    now = () => new Date(),
    fsImpl = fs,
    onFatal = () => {},
    onListenerError = (error) => process.emitWarning(error),
  }) {
    this.fs = fsImpl;
    this.stateDir = stateDir;
    this.logPath = path.join(stateDir, "events.jsonl");
    this.session = session;
    this.maxBytes = maxBytes;
    this.previousFiles = previousFiles;
    this.now = now;
    this.onFatal = onFatal;
    this.onListenerError = onListenerError;
    this.seq = 0;
    this.failed = false;
    this.closed = false;
    this.listeners = new Set();
    this.fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    this.fs.chmodSync(this.stateDir, 0o700);
    this.fs.writeFileSync(this.logPath, "", { flag: "a", mode: 0o600 });
    this.fs.chmodSync(this.logPath, 0o600);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  append(type, fields = {}) {
    if (this.closed) throw new Error("Codex Micro trace is closed");
    if (this.failed) throw new Error("Codex Micro trace has failed");
    if (!TRACE_TYPES.has(type)) throw new Error(`Unsupported Codex Micro trace type: ${String(type)}`);
    const eventFields = { ...fields };
    for (const key of ["schema", "ts", "session", "seq", "type"]) delete eventFields[key];
    const record = {
      schema: SCHEMA,
      ts: this.now().toISOString(),
      session: this.session,
      seq: ++this.seq,
      type,
      ...eventFields,
    };
    const line = `${JSON.stringify(record)}\n`;
    try {
      this.rotateFor(Buffer.byteLength(line));
      this.fs.appendFileSync(this.logPath, line, "utf8");
    } catch (error) {
      this.failed = true;
      this.onFatal(error);
      throw error;
    }
    const listenerFailures = [];
    for (const listener of this.listeners) {
      try {
        listener(record, line);
      } catch (error) {
        listenerFailures.push({ error, listener });
      }
    }
    for (const failure of listenerFailures) {
      this.onListenerError(failure.error, {
        listener: failure.listener,
        record,
        line,
      });
    }
    return record;
  }

  rotateFor(nextBytes) {
    const currentBytes = this.fs.statSync(this.logPath).size;
    if (currentBytes + nextBytes <= this.maxBytes) return;
    for (let generation = this.previousFiles; generation >= 1; generation -= 1) {
      const source = generation === 1 ? this.logPath : `${this.logPath}.${generation - 1}`;
      const target = `${this.logPath}.${generation}`;
      if (!this.fs.existsSync(source)) continue;
      if (this.fs.existsSync(target)) this.fs.unlinkSync(target);
      this.fs.renameSync(source, target);
    }
    this.fs.writeFileSync(this.logPath, "", { mode: 0o600 });
    this.fs.chmodSync(this.logPath, 0o600);
  }

  close() {
    this.closed = true;
    this.listeners.clear();
  }
}

class FakeWLDeviceDiscovery {
  constructor(runtime) {
    this.runtime = runtime;
  }

  findWLDevices(filter) {
    if (!this.runtime.isHealthy() || !this.runtime.desiredConnected) return [];
    if (filter != null && !filter.includes(VIRTUAL_DEVICE.deviceType)) return [];
    return [{ ...VIRTUAL_DEVICE }];
  }
}

class FakeWLDeviceComm {
  constructor(runtime) {
    this.runtime = runtime;
    this.connected = false;
    this.connectionListeners = new Set();
    this.notifyHandlers = new Map();
    this.abortedIds = new Set();
  }

  onConnectionEvent(callback) {
    this.connectionListeners.add(callback);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.connectionListeners.delete(callback);
    };
  }

  addNotifyHandler(method, handler) {
    this.notifyHandlers.set(method, handler);
  }

  removeNotifyHandler(method) {
    this.notifyHandlers.delete(method);
  }

  hasNotifyHandler(method) {
    return this.notifyHandlers.has(method);
  }

  deliverNotification(method, params) {
    if (!this.connected) return false;
    const handler = this.notifyHandlers.get(method);
    if (!handler) return false;
    handler(params);
    return true;
  }

  emitConnectionEvent(type, error) {
    const event = error == null ? { type } : { type, error };
    for (const listener of this.connectionListeners) listener(event);
  }

  async connect(device) {
    if (device?.deviceType !== VIRTUAL_DEVICE.deviceType) {
      throw new Error("Codex Micro emulator requires a project_2077 device");
    }
    if (this.connected) throw new Error("Codex Micro emulator is already connected");
    if (!this.runtime.isHealthy() || !this.runtime.desiredConnected) {
      throw new Error("Codex Micro emulator is not discoverable");
    }
    if (this.runtime.currentComm && this.runtime.currentComm !== this) {
      throw new Error("Another Codex Micro emulator communication is already active");
    }
    this.runtime.currentComm = this;
    this.connected = true;
    this.runtime.state = "connected";
    this.runtime.record("connection", { state: "connected" });
    this.emitConnectionEvent(0);
    return true;
  }

  isConnected() {
    return this.connected;
  }

  async disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.notifyHandlers.clear();
    if (this.runtime.currentComm === this) this.runtime.currentComm = null;
    this.runtime.state = this.runtime.desiredConnected ? "discoverable" : "disconnected";
    if (this.runtime.trace && !this.runtime.trace.failed && !this.runtime.trace.closed) {
      this.runtime.record("connection", { state: "disconnected" });
    }
    this.emitConnectionEvent(1);
  }

  async forceDisconnect() {
    await this.disconnect();
  }

  forceError(error) {
    if (!this.connected) return;
    this.connected = false;
    this.notifyHandlers.clear();
    if (this.runtime.currentComm === this) this.runtime.currentComm = null;
    this.emitConnectionEvent(2, error);
  }

  async sendLegacyRpcRequest() {
    throw new Error("Legacy RPC is not supported by the Codex Micro emulator");
  }

  async sendJsonRpcRequest(raw, transportId) {
    if (!this.connected) throw new Error("Codex Micro emulator is disconnected");
    const parsed = buildDeterministicResponse(raw, transportId);
    const requestId = parsed.request && Object.hasOwn(parsed.request, "id") ? parsed.request.id : null;
    this.runtime.record("rpc.request", {
      id: requestId,
      method: parsed.method,
      params: parsed.request?.params ?? null,
      raw,
    });
    for (const frame of frameJsonRpc(raw, requestId)) {
      this.runtime.record("hid.frame", {
        rpcId: requestId,
        simulated: true,
        packet: frame.packet,
        packetCount: frame.packetCount,
        reportId: REPORT_ID,
        channel: RPC_CHANNEL,
        payloadLength: frame.payloadLength,
        reportHex: frame.report.toString("hex"),
      });
    }
    this.runtime.record("rpc.response", {
      id: parsed.body.id,
      method: parsed.method,
      unsupported: parsed.unsupported,
      raw: parsed.raw,
    });
    return parsed.raw;
  }

  async abortJsonRpcRequest(id) {
    this.abortedIds.add(id);
  }

  cleanCommQueue() {
    this.abortedIds.clear();
  }
}

class CodexMicroEmulatorRuntime {
  constructor({
    fsImpl = fs,
    netImpl = net,
    now = () => new Date(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    stateDir,
    socketPath,
    autoStart = true,
  } = {}) {
    let runtimePaths;
    if (stateDir == null || socketPath == null) runtimePaths = resolveRuntimePaths();
    this.fs = fsImpl;
    this.net = netImpl;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.stateDir = stateDir ?? runtimePaths.stateDir;
    this.logPath = path.join(this.stateDir, "events.jsonl");
    this.socketPath = socketPath ?? runtimePaths.socketPath;
    this.socketParent = path.dirname(this.socketPath);
    this.autoStart = autoStart;
    this.session = crypto.randomUUID();
    this.state = "idle";
    this.error = null;
    this.desiredConnected = false;
    this.trace = null;
    this.currentComm = null;
    this.server = null;
    this.clients = new Set();
    this.pendingTimers = new Set();
    this.socketIdentity = null;
    this._startingPromise = null;
    this.closed = false;
  }

  isHealthy() {
    return !this.closed && this.state !== "error" && this.trace != null && !this.trace.failed;
  }

  initializeTrace() {
    if (this.trace) return this.trace;
    if (this.closed) throw new Error("Codex Micro emulator runtime is closed");
    this.trace = new TraceWriter({
      stateDir: this.stateDir,
      session: this.session,
      now: this.now,
      fsImpl: this.fs,
      onFatal: (error) => this.fail(error),
    });
    this.trace.append("session", {
      pid: process.pid,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      appVersion: process.env.CODEX_APP_VERSION ?? null,
      emulatorVersion: VERSION,
    });
    return this.trace;
  }

  createOptions() {
    return {
      discovery: new FakeWLDeviceDiscovery(this),
      createComm: () => new FakeWLDeviceComm(this),
    };
  }

  start() {
    if (this.closed) return Promise.reject(new Error("Codex Micro emulator runtime is closed"));
    if (this.state === "discoverable" || this.state === "connected" || this.state === "disconnected") {
      return Promise.resolve(true);
    }
    if (this._startingPromise) return this._startingPromise;
    this._startingPromise = this.startInternal().finally(() => {
      this._startingPromise = null;
    });
    return this._startingPromise;
  }

  async startInternal() {
    this.state = "starting";
    try {
      this.initializeTrace();
      this.fs.mkdirSync(this.socketParent, { recursive: true, mode: 0o700 });
      this.fs.chmodSync(this.socketParent, 0o700);
      await recoverStaleSocket({ socketPath: this.socketPath, fsImpl: this.fs, netImpl: this.net });

      const server = this.net.createServer((socket) => this.acceptClient(socket));
      this.server = server;
      let starting = true;
      server.on("error", (error) => {
        if (!starting) this.handleSocketFailure(error);
      });
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.socketPath);
      });
      starting = false;
      this.fs.chmodSync(this.socketPath, 0o600);
      const socketStat = this.fs.lstatSync(this.socketPath);
      this.socketIdentity = { dev: socketStat.dev, ino: socketStat.ino };
      this.state = "discoverable";
      this.desiredConnected = true;
      this.record("connection", { state: "discoverable" });
      return true;
    } catch (error) {
      if (this.trace && !this.trace.failed && !this.trace.closed) {
        try {
          this.record("connection", { state: "error", error: error instanceof Error ? error.message : String(error) });
        } catch {
          // The trace fatal callback has already closed discovery and communication.
        }
      }
      this.fail(error);
      await this.stopSocketServer();
      this.unlinkOwnedSocket();
      throw error;
    }
  }

  acceptClient(socket) {
    this.clients.add(socket);
    let buffer = Buffer.alloc(0);
    let ended = false;
    let processing = Promise.resolve();
    const cleanup = () => this.clients.delete(socket);
    socket.once("close", cleanup);
    socket.once("error", cleanup);
    socket.on("data", (chunk) => {
      if (ended) return;
      buffer = Buffer.concat([buffer, chunk]);
      let newline;
      while ((newline = buffer.indexOf(0x0a)) !== -1) {
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.length > MAX_SOCKET_LINE_BYTES) {
          ended = true;
          processing = processing.then(() => this.endClientWithError(socket, "line_too_large", "Socket line exceeds 16384 bytes"));
          return;
        }
        processing = processing.then(() => this.processSocketLine(socket, line));
      }
      if (buffer.length > MAX_SOCKET_LINE_BYTES) {
        ended = true;
        processing = processing.then(() => this.endClientWithError(socket, "line_too_large", "Socket line exceeds 16384 bytes"));
      }
    });
  }

  writeSocketResponse(socket, response) {
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify(response)}\n`);
  }

  endClientWithError(socket, code, message) {
    if (socket.destroyed) return;
    socket.end(`${JSON.stringify(commandError(code, message))}\n`);
  }

  async processSocketLine(socket, line) {
    let parsed;
    try {
      parsed = JSON.parse(line.toString("utf8"));
    } catch {
      this.writeSocketResponse(socket, commandError("malformed_json", "Socket line is not valid JSON"));
      return;
    }
    const validated = validateCommand(parsed);
    if (!validated.ok) {
      this.writeSocketResponse(socket, validated);
      return;
    }
    try {
      const response = await this.dispatchCommand(socket, validated.value);
      if (response != null) this.writeSocketResponse(socket, response);
    } catch (error) {
      const traceFailed = this.trace?.failed || this.state === "error" && /trace/i.test(this.error ?? "");
      this.writeSocketResponse(socket, commandError(
        traceFailed ? "trace_failed" : "internal_error",
        error instanceof Error ? error.message : String(error),
      ));
    }
  }

  async dispatchCommand(socket, command) {
    switch (command.command) {
      case "status": return { ok: true, result: this.status() };
      case "watch": return this.beginWatch(socket);
      case "connect": return this.requestConnect();
      case "disconnect": return this.requestDisconnect();
      case "key": return this.sendKey(command.key, command.action);
      case "encoder": return this.sendEncoder(command.direction, command.steps);
      case "joystick": return this.sendJoystick(command.direction);
      default: return commandError("invalid_command", "Unsupported command");
    }
  }

  beginWatch(socket) {
    if (!this.trace || this.trace.failed || this.trace.closed) {
      this.writeSocketResponse(socket, commandError("trace_failed", "Trace is unavailable"));
      return null;
    }
    this.writeSocketResponse(socket, { ok: true, result: { watching: true, session: this.session } });
    const unsubscribe = this.trace.subscribe((_record, line) => {
      if (!socket.destroyed) socket.write(line);
    });
    let active = true;
    const cleanup = () => {
      if (!active) return;
      active = false;
      unsubscribe();
    };
    socket.once("close", cleanup);
    socket.once("error", cleanup);
    return null;
  }

  requestConnect() {
    if (!this.isHealthy()) {
      return commandError(this.trace?.failed ? "trace_failed" : "disconnected", "Emulator is unavailable");
    }
    this.desiredConnected = true;
    this.state = "discoverable";
    this.record("connection", { state: "discoverable" });
    return { ok: true, result: this.status() };
  }

  async requestDisconnect() {
    if (this.state === "error") {
      return commandError(this.trace?.failed ? "trace_failed" : "disconnected", "Emulator is unavailable");
    }
    this.desiredConnected = false;
    this.state = "disconnected";
    const comm = this.currentComm;
    if (comm) await comm.forceDisconnect();
    else this.record("connection", { state: "disconnected" });
    return { ok: true, result: this.status() };
  }

  inputUnavailable() {
    if (this.trace?.failed || this.state === "error") {
      return commandError("trace_failed", "Trace is unavailable");
    }
    return commandError("disconnected", "No connected communication handler is available");
  }

  sendKey(key, action) {
    if (!this.currentComm?.isConnected() || !this.currentComm.hasNotifyHandler("v.oai.hid")) {
      return this.inputUnavailable();
    }
    if (action !== "tap") {
      if (!this.dispatchNotification("v.oai.hid", { k: key, act: action === "press" ? 1 : 0 })) {
        return this.inputUnavailable();
      }
      return { ok: true, result: { sent: true } };
    }
    if (!this.dispatchNotification("v.oai.hid", { k: key, act: 1 })) return this.inputUnavailable();
    const timer = this.setTimer(() => {
      this.pendingTimers.delete(timer);
      if (!this.currentComm?.isConnected()) return;
      try {
        this.dispatchNotification("v.oai.hid", { k: key, act: 0 });
      } catch (error) {
        this.fail(error);
      }
    }, TAP_DELAY_MS);
    this.pendingTimers.add(timer);
    return { ok: true, result: { sent: true } };
  }

  sendEncoder(direction, steps) {
    if (!this.currentComm?.isConnected() || !this.currentComm.hasNotifyHandler("v.oai.hid")) {
      return this.inputUnavailable();
    }
    const key = direction === "cw" ? "ENC_CW" : "ENC_CC";
    for (let step = 0; step < steps; step += 1) {
      if (!this.dispatchNotification("v.oai.hid", { k: key, act: 2 })) return this.inputUnavailable();
    }
    return { ok: true, result: { sent: steps } };
  }

  sendJoystick(direction) {
    if (!this.currentComm?.isConnected() || !this.currentComm.hasNotifyHandler("v.oai.rad")) {
      return this.inputUnavailable();
    }
    if (!this.dispatchNotification("v.oai.rad", { ...JOYSTICK[direction] })) return this.inputUnavailable();
    return { ok: true, result: { sent: true } };
  }

  record(type, fields) {
    if (!this.trace) {
      const error = new Error("Codex Micro trace is not initialized");
      this.fail(error);
      throw error;
    }
    try {
      return this.trace.append(type, fields);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  dispatchNotification(method, params) {
    if (!NOTIFICATION_METHODS.has(method)) return false;
    const comm = this.currentComm;
    if (!comm?.isConnected() || !comm.hasNotifyHandler(method)) return false;
    this.record("notify.rx", { method, params });
    return comm.deliverNotification(method, params);
  }

  fail(error) {
    if (this.state === "error") return;
    this.error = error instanceof Error ? error.message : String(error);
    this.state = "error";
    this.desiredConnected = false;
    this.clearPendingTimers();
    const comm = this.currentComm;
    this.currentComm = null;
    comm?.forceError(new Error(this.error));
  }

  handleSocketFailure(error) {
    if (this.state === "error" || this.closed) return;
    if (this.trace && !this.trace.failed && !this.trace.closed) {
      try {
        this.record("connection", { state: "error", error: error instanceof Error ? error.message : String(error) });
      } catch {
        return;
      }
    }
    this.fail(error);
  }

  status() {
    return {
      state: this.state,
      desiredConnected: this.desiredConnected,
      connected: this.currentComm?.isConnected() ?? false,
      error: this.error,
      session: this.session,
      logPath: this.logPath,
      socketPath: this.socketPath,
    };
  }

  clearPendingTimers() {
    for (const timer of this.pendingTimers) this.clearTimer(timer);
    this.pendingTimers.clear();
  }

  async stopSocketServer() {
    for (const client of this.clients) client.destroy?.();
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (!server?.listening) return;
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  unlinkOwnedSocket() {
    if (!this.socketIdentity) return;
    const current = lstatIfPresent(this.socketPath, this.fs);
    if (sameIdentity(this.socketIdentity, current)) this.fs.unlinkSync(this.socketPath);
    this.socketIdentity = null;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.desiredConnected = false;
    this.clearPendingTimers();
    const comm = this.currentComm;
    this.currentComm = null;
    let firstError = null;
    try {
      await comm?.forceDisconnect();
    } catch (error) {
      firstError = error;
    }
    try {
      await this.stopSocketServer();
    } catch (error) {
      firstError ??= error;
    }
    try {
      this.unlinkOwnedSocket();
    } catch (error) {
      firstError ??= error;
    }
    this.trace?.close();
    this.state = "closed";
    if (firstError) throw firstError;
  }

  closeSync() {
    if (this.closed) return;
    this.closed = true;
    this.desiredConnected = false;
    this.clearPendingTimers();
    const comm = this.currentComm;
    this.currentComm = null;
    if (comm) {
      comm.connected = false;
      comm.notifyHandlers.clear();
    }
    for (const client of this.clients) client.destroy?.();
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (server?.listening) server.close();
    this.unlinkOwnedSocket();
    this.trace?.close();
    this.state = "closed";
  }
}

const defaultRuntime = new CodexMicroEmulatorRuntime();
defaultRuntime.startPromise = defaultRuntime.start().catch((error) => {
  defaultRuntime.fail(error);
  return false;
});
process.once("exit", () => defaultRuntime.closeSync());

function createOptions() {
  return defaultRuntime.createOptions();
}

module.exports = {
  createOptions,
  __test: {
    CodexMicroEmulatorRuntime,
    FakeWLDeviceComm,
    FakeWLDeviceDiscovery,
    TraceWriter,
    buildDeterministicResponse,
    defaultRuntime,
    frameJsonRpc,
    recoverStaleSocket,
    resolveRuntimePaths,
    validateCommand,
  },
};
