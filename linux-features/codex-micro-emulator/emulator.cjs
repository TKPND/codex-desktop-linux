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
    const comm = this.currentComm;
    this.currentComm = null;
    comm?.forceError(new Error(this.error));
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

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.desiredConnected = false;
    this.clearPendingTimers();
    const comm = this.currentComm;
    this.currentComm = null;
    await comm?.forceDisconnect();
    for (const client of this.clients) client.destroy?.();
    this.clients.clear();
    if (this.server?.listening) {
      await new Promise((resolve, reject) => {
        this.server.close((error) => error ? reject(error) : resolve());
      });
    }
    this.server = null;
    this.trace?.close();
    this.state = "closed";
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
    this.trace?.close();
    this.state = "closed";
  }
}

const defaultRuntime = new CodexMicroEmulatorRuntime({ autoStart: false });

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
    recoverStaleSocket: undefined,
    resolveRuntimePaths,
    validateCommand: undefined,
  },
};
