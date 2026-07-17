# Codex Micro Emulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a disabled-by-default Linux feature that lets the upstream Codex Micro service connect to a deterministic virtual device, trace its exact JSON-RPC and simulated HID output, and accept validated CLI input without physical hardware.

**Architecture:** Patch only the current Electron main-process construction of `CodexMicroService`, spreading options from a staged CommonJS module into its existing callback object. The module injects fake discovery and communication objects while leaving upstream `createApi` untouched, so the real `RPCApiOAI`, `WLRPCClient`, lighting conversion, request ordering, and request IDs remain active. A private Unix socket exposes typed lifecycle/input commands and a Python standard-library CLI; every outbound request and accepted inbound notification is written to a rotated JSONL trace.

**Tech Stack:** CommonJS on the bundled Electron/Node runtime, Node built-ins (`node:crypto`, `node:fs`, `node:net`, `node:os`, `node:path`), Python 3 standard library, repository Linux feature descriptors, and `node:test`.

## Global Constraints

- The repository supports only the latest upstream `Codex.dmg`; keep one current patch shape and no legacy fallback needles.
- The feature id is `codex-micro-emulator` and `defaultEnabled` is exactly `false`.
- Do not modify `linux-features/features.example.json` or commit `linux-features/features.json`.
- Do not add `stageHook`, `cleanupHook`, `runtimeHooks`, or `packageHooks`; use declarative resources only.
- Stage `emulator.cjs` at `.codex-linux/features/codex-micro-emulator/emulator.cjs` with mode `"0644"`.
- Stage the CLI at `resources/native/codex-micro-emulator` with mode `"0755"`.
- Inject only `discovery` and `createComm`; never inject `createApi`.
- Keep the upstream `CodexMicroService`, `RPCApiOAI`, and `WLRPCClient` in the runtime path.
- HID reports are exactly 64 bytes: report id `0x06`, channel `0x02`, payload length in byte 2, and at most 61 payload bytes copied from `Buffer.from(rawJson)`.
- The trace schema is `1`; common fields are `schema`, `ts`, `session`, `seq`, and `type`.
- Trace event types are exactly `session`, `connection`, `rpc.request`, `hid.frame`, `rpc.response`, and `notify.rx`.
- Rotate before an append would exceed 5 MiB (`5 * 1024 * 1024`) and retain exactly three generations: active, `.1`, and `.2`.
- Use state directory mode `0700`, log mode `0600`, socket parent mode `0700`, and socket mode `0600`.
- The socket path is `${XDG_RUNTIME_DIR}/codex-desktop/codex-micro-emulator.sock`; fail explicitly when `XDG_RUNTIME_DIR` is absent and never fall back to `/tmp`.
- Accept only `AG00`-`AG05`, `ACT06`-`ACT12`, and `ENC_SW`; encode release as `act: 0`, press as `act: 1`, and encoder rotation as `act: 2`.
- A tap is press followed by release after exactly 50 ms; encoder steps are integers in the inclusive range 1-100.
- Map joystick directions to `{a,d}` as `up={0.75,1}`, `right={0,1}`, `down={0.25,1}`, `left={0.5,1}`, and `center={0,0}`.
- The socket accepts newline-delimited JSON up to 16,384 bytes per line and never accepts arbitrary notification methods, filesystem paths, code, or shell commands.
- Any trace or rotation failure changes the virtual device to an error/disconnected state; never continue as an observable connected device.

---

## File Structure

- `linux-features/codex-micro-emulator/feature.json` — opt-in metadata, patch descriptor entrypoint, and the two declarative resources.
- `linux-features/codex-micro-emulator/README.md` — enablement, trace privacy, command usage, runtime paths, troubleshooting, and generated-app UAT.
- `linux-features/codex-micro-emulator/patch.js` — one current-shape, idempotent main-bundle patch plus focused exports for tests.
- `linux-features/codex-micro-emulator/emulator.cjs` — trace writer, HID framing, deterministic RPC responder, fake discovery/communication, Unix socket server, lifecycle, and test-only exports.
- `linux-features/codex-micro-emulator/bin/codex-micro-emulator` — typed Python 3 Unix-socket client with `status`, `watch`, `key`, `encoder`, `joystick`, `connect`, and `disconnect` commands.
- `linux-features/codex-micro-emulator/test.js` — manifest, patch, staging, runtime, socket, CLI, error, permission, and regression tests.

## Runtime Interfaces

`emulator.cjs` must export this stable surface:

```js
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
```

The production entrypoint is:

```js
function createOptions() {
  return defaultRuntime.createOptions();
}
```

`CodexMicroEmulatorRuntime#createOptions()` returns this exact shape, with no `createApi` property:

```js
{
  discovery: new FakeWLDeviceDiscovery(runtime),
  createComm: () => new FakeWLDeviceComm(runtime),
}
```

The fake communication object implements the upstream `WLDeviceComm` subset:

```js
onConnectionEvent(callback)          // () => void
addNotifyHandler(method, handler)    // void
removeNotifyHandler(method)          // void
connect(device)                      // Promise<boolean>
isConnected()                        // boolean
disconnect()                         // Promise<void>
sendLegacyRpcRequest(rpc, args)      // Promise rejection: unsupported
sendJsonRpcRequest(raw, transportId) // Promise<string>
abortJsonRpcRequest(id)              // Promise<void>
cleanCommQueue()                     // void
```

The runtime additionally uses four internal methods on the fake communication object: `hasNotifyHandler(method): boolean`, `deliverNotification(method, params): boolean`, `forceDisconnect(): Promise<void>` for a CLI disconnect, and `forceError(error: Error): void` for fail-closed trace/socket errors. Delivery returns `false` without invoking anything when a method has no handler. Both force methods set `connected=false` before emitting their lifecycle event and are idempotent.

The socket request objects are exactly:

```js
{ command: "status" }
{ command: "watch" }
{ command: "key", key: "AG00", action: "press" }
{ command: "encoder", direction: "cw", steps: 1 }
{ command: "joystick", direction: "up" }
{ command: "connect" }
{ command: "disconnect" }
```

Successful command responses use `{ok:true,result:{...}}`; failures use `{ok:false,error:{code,message}}`. After the `watch` acknowledgement, each subsequent line is one unwrapped trace record so `watch --raw` can print it unchanged.

---

### Task 1: Add the opt-in feature manifest and current main-bundle patch

**Files:**
- Create: `linux-features/codex-micro-emulator/feature.json`
- Create: `linux-features/codex-micro-emulator/README.md`
- Create: `linux-features/codex-micro-emulator/patch.js`
- Create: `linux-features/codex-micro-emulator/test.js`

**Interfaces:**
- Consumes: the repository `entrypoints.patchDescriptors` and declarative `resources` contracts.
- Produces: `applyCodexMicroEmulatorPatch(source: string): string`, `descriptors: object[]`, and a staged call to `emulator.createOptions()` at the upstream constructor.

- [ ] **Step 1: Write failing manifest, descriptor, and patch-shape tests**

Create `test.js` with the common imports/helper and these first tests:

```js
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
  const missing = source.replace("onJoystickEvent", "onStickEvent");
  assert.equal(applyCodexMicroEmulatorPatch(missing), missing);
  const duplicated = `${source};${source}`;
  assert.equal(applyCodexMicroEmulatorPatch(duplicated), duplicated);
});
```

- [ ] **Step 2: Run the focused test and verify the feature does not exist yet**

Run:

```bash
node --test linux-features/codex-micro-emulator/test.js
```

Expected: FAIL with `Cannot find module './patch.js'` or a missing `feature.json` error.

- [ ] **Step 3: Create the manifest and the minimal README required by feature discovery**

Create `feature.json` exactly as follows:

```json
{
  "id": "codex-micro-emulator",
  "title": "Codex Micro Emulator",
  "description": "Emulates the Codex Micro transport in-process, traces upstream RPC and simulated HID frames, and accepts typed input over a private Unix socket.",
  "defaultEnabled": false,
  "entrypoints": {
    "patchDescriptors": "./patch.js"
  },
  "resources": [
    {
      "source": "emulator.cjs",
      "target": ".codex-linux/features/codex-micro-emulator/emulator.cjs",
      "mode": "0644"
    },
    {
      "source": "bin/codex-micro-emulator",
      "target": "resources/native/codex-micro-emulator",
      "mode": "0755"
    }
  ]
}
```

Create an initial `README.md` containing the title, purpose, explicit disabled-by-default status, non-goals, enablement warning, and private trace-data warning. The feature loader requires this file before it can load the manifest; Task 5 adds the verified command and UAT details after those interfaces exist.

- [ ] **Step 4: Implement the current-shape patch descriptor**

Create `patch.js` with this complete implementation:

```js
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
```

The replacement intentionally inserts the spread after all three upstream callbacks and retains their source byte-for-byte. Do not add a second constructor needle.

- [ ] **Step 5: Add a fail-closed resource boundary so the manifest can be validated in isolation**

Create `emulator.cjs` with:

```js
"use strict";

function createOptions() {
  return {
    discovery: {
      findWLDevices() {
        return [];
      },
    },
    createComm() {
      throw new Error("No virtual Codex Micro is discoverable");
    },
  };
}

module.exports = { createOptions };
```

Create `bin/codex-micro-emulator` with:

```python
#!/usr/bin/env python3
import sys

print("codex-micro-emulator: no virtual device is discoverable", file=sys.stderr)
raise SystemExit(1)
```

These files make the declarative-resource test meaningful and keep an accidentally enabled intermediate build in the upstream `not-detected` state. The first commit therefore cannot pretend to be connected or accept input.

- [ ] **Step 6: Run the Task 1 tests**

Run:

```bash
node --test linux-features/codex-micro-emulator/test.js
```

Expected: PASS for the four Task 1 tests. The drift test may emit the expected warning twice.

- [ ] **Step 7: Commit the opt-in patch boundary**

```bash
git add linux-features/codex-micro-emulator
git commit -m "feat(codex-micro): add optional emulator hook"
```

---

### Task 2: Implement trace rotation, HID framing, deterministic RPC, and the fake transport

**Files:**
- Modify: `linux-features/codex-micro-emulator/emulator.cjs`
- Modify: `linux-features/codex-micro-emulator/test.js`

**Interfaces:**
- Consumes: final serialized JSON passed by upstream `WLRPCClient` to `sendJsonRpcRequest(raw, id)`.
- Produces: `TraceWriter`, `frameJsonRpc(raw, rpcId)`, `buildDeterministicResponse(raw, transportId)`, `FakeWLDeviceDiscovery`, `FakeWLDeviceComm`, and an initially non-advertising `CodexMicroEmulatorRuntime#createOptions()`; Task 3 activates module-load startup after the control socket is complete.

- [ ] **Step 1: Add failing trace, frame, response, and communication tests**

Before requiring `emulator.cjs`, give its production singleton private test paths, then add teardown:

```js
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

test.after(async () => {
  await defaultRuntime.close();
  if (ORIGINAL_STATE_DIR == null) delete process.env.CODEX_LINUX_APP_STATE_DIR;
  else process.env.CODEX_LINUX_APP_STATE_DIR = ORIGINAL_STATE_DIR;
  if (ORIGINAL_RUNTIME_DIR == null) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = ORIGINAL_RUNTIME_DIR;
  fs.rmSync(MODULE_RUNTIME_ROOT, { recursive: true, force: true });
});
```

Add tests with these exact assertions:

```js
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
```

- [ ] **Step 2: Run the new tests and verify missing runtime exports**

Run:

```bash
node --test linux-features/codex-micro-emulator/test.js
```

Expected: FAIL because `emulator.__test`, `TraceWriter`, and `frameJsonRpc` are not defined.

- [ ] **Step 3: Implement constants, paths, HID framing, and deterministic response construction**

Replace the runtime stub with Node built-in imports and these exact values/functions:

```js
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
      body = { id, result: { version: VERSION, profile_index: 0, layer_index: 0, battery: 100, is_charging: false } };
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
```

An empty serialized request yields no HID reports; malformed JSON still has byte frames because the fake transport observes the attempted outbound bytes before returning the parse error.

- [ ] **Step 4: Implement the JSONL writer with exact rotation and permission behavior**

Implement `TraceWriter` with this complete code:

```js
class TraceWriter {
  constructor({
    stateDir,
    session = crypto.randomUUID(),
    maxBytes = MAX_TRACE_BYTES,
    previousFiles = PREVIOUS_TRACE_FILES,
    now = () => new Date(),
    fsImpl = fs,
    onFatal = () => {},
  }) {
    this.fs = fsImpl;
    this.stateDir = stateDir;
    this.logPath = path.join(stateDir, "events.jsonl");
    this.session = session;
    this.maxBytes = maxBytes;
    this.previousFiles = previousFiles;
    this.now = now;
    this.onFatal = onFatal;
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
    const record = {
      schema: SCHEMA,
      ts: this.now().toISOString(),
      session: this.session,
      seq: ++this.seq,
      type,
      ...fields,
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
    for (const listener of this.listeners) {
      try { listener(record, line); } catch {}
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
```

The write completes before listeners are notified, so watcher output never gets ahead of the durable trace.

- [ ] **Step 5: Implement fake discovery, communication, and the non-socket runtime core**

Implement `FakeWLDeviceDiscovery` so `findWLDevices(filter)` returns a fresh copy of `VIRTUAL_DEVICE` only when the runtime is healthy and `desiredConnected` is true. An explicit filter that omits `"project_2077"` returns `[]`.

Implement `FakeWLDeviceComm` using `Set` for connection listeners and `Map` for notification handlers. Use numeric upstream event types `0=CONNECTED`, `1=DISCONNECTED`, and `2=ERROR`. Its core request method must run in this order:

```js
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
```

`connect(device)` validates `device.deviceType === "project_2077"`, rejects an already-connected instance, claims `runtime.currentComm`, records `connection:connected`, emits type `0`, and returns `true`. `disconnect()` clears handlers, releases `runtime.currentComm`, records `connection:disconnected` when tracing is healthy, emits type `1`, and is idempotent. `sendLegacyRpcRequest()` always rejects with `Legacy RPC is not supported by the Codex Micro emulator`. `abortJsonRpcRequest()` resolves for an absent or already-completed request. `cleanCommQueue()` clears the internal aborted-id set.

Implement `CodexMicroEmulatorRuntime` constructor dependency injection for `fsImpl`, `netImpl`, `now`, `setTimer`, `clearTimer`, `stateDir`, `socketPath`, and `autoStart`. Its non-socket methods are:

```js
initializeTrace()                    // create TraceWriter and append one session record
createOptions()                      // discovery + createComm only
record(type, fields)                // append through TraceWriter or fail
dispatchNotification(method, params)// record notify.rx, then call registered handler
fail(error)                          // state=error, desiredConnected=false, emit transport ERROR
status()                             // serializable state/log/socket/session snapshot
close()                              // async idempotent trace/transport cleanup
closeSync()                          // identity-safe process-exit cleanup
```

The runtime owns a `pendingTimers: Set` for tap releases. Both cleanup methods clear every owned timer through the injected `clearTimer`, clear the set, and tolerate partially initialized trace/server/socket state.

The `session` record includes `pid`, `node`, `electron` (or `null`), `appVersion` from `CODEX_APP_VERSION` (or `null`), and `emulatorVersion: VERSION`.

- [ ] **Step 6: Wire the production export surface without advertising an incomplete device**

At module load, create the singleton in a non-advertising state. Task 3 replaces this final block with module-load socket startup after the input/lifecycle control surface exists:

```js
const defaultRuntime = new CodexMicroEmulatorRuntime({ autoStart: false });

function createOptions() {
  return defaultRuntime.createOptions();
}
```

Export the exact surface listed in “Runtime Interfaces.” Initialize `desiredConnected=false`, so direct use of this intermediate commit returns no discovered device and cannot bypass the missing control socket.

- [ ] **Step 7: Run the Task 2 tests**

Run:

```bash
node --test linux-features/codex-micro-emulator/test.js
```

Expected: PASS for manifest/patch tests plus HID, response, trace, and fake communication tests. No `node-hid` native module is loaded.

- [ ] **Step 8: Commit the deterministic transport boundary**

```bash
git add linux-features/codex-micro-emulator/emulator.cjs linux-features/codex-micro-emulator/test.js
git commit -m "feat(codex-micro): emulate RPC transport and trace"
```

---

### Task 3: Add the private control socket, typed input, watch stream, and failure closure

**Files:**
- Modify: `linux-features/codex-micro-emulator/emulator.cjs`
- Modify: `linux-features/codex-micro-emulator/test.js`

**Interfaces:**
- Consumes: the typed socket request objects in “Runtime Interfaces.”
- Produces: private socket startup/cleanup, structured replies, `notify.rx` dispatch to upstream `v.oai.hid`/`v.oai.rad` handlers, lifecycle control, and raw trace subscriptions.

- [ ] **Step 1: Add failing path, lifecycle, input, watch, and safety tests**

Add helpers that create a runtime with unique real state/runtime directories and exchange one JSON line over a Unix socket:

```js
const net = require("node:net");

async function withStartedRuntime(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-runtime-"));
  const runtime = new CodexMicroEmulatorRuntime({
    stateDir: path.join(root, "state"),
    socketPath: path.join(root, "runtime", "codex-desktop", "codex-micro-emulator.sock"),
    autoStart: false,
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
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  });
}
```

Add these tests:

```js
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
    assert.deepEqual(invalid.error.code, "invalid_key");
    const malformed = await new Promise((resolve, reject) => {
      const socket = net.createConnection(runtime.socketPath);
      let buffer = "";
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (buffer.includes("\n")) resolve(JSON.parse(buffer.trim()));
      });
      socket.once("connect", () => socket.write("{bad\n"));
    });
    assert.deepEqual(malformed.error.code, "malformed_json");
    const disconnected = await socketCommand(runtime.socketPath, { command: "key", key: "AG00", action: "press" });
    assert.deepEqual(disconnected.error.code, "disconnected");

    const oversized = await new Promise((resolve, reject) => {
      const socket = net.createConnection(runtime.socketPath);
      let buffer = "";
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (buffer.includes("\n")) resolve(JSON.parse(buffer.trim()));
      });
      socket.once("connect", () => socket.write(`${"x".repeat(16_385)}\n`));
    });
    assert.deepEqual(oversized.error.code, "line_too_large");
  });
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
```

Add a watch test that opens a socket, sends `{command:"watch"}`, consumes the acknowledgement, calls `runtime.record("connection", {state:"watch-test"})`, and asserts the next raw line has `type === "connection"` and `state === "watch-test"`.

Add a live-socket recovery test: bind a separate `net.Server` at the target path, call `recoverStaleSocket`, assert rejection with `already active`, and assert the original server still accepts a connection. Add a cleanup identity test that replaces the recorded `{dev,ino}` with a different fake stat and asserts `closeSync()` does not unlink the replacement.

Add a trace-failure test using an `fsImpl` wrapper whose `appendFileSync` throws after initial startup. Assert the current communication listener receives event type `2`, `runtime.state === "error"`, `comm.isConnected() === false`, and subsequent input returns `trace_failed` or `disconnected` without invoking handlers.

- [ ] **Step 2: Run the focused suite and verify socket behavior is absent**

Run:

```bash
node --test linux-features/codex-micro-emulator/test.js
```

Expected: FAIL because no socket is listening and `validateCommand`/`recoverStaleSocket` are missing.

- [ ] **Step 3: Implement independent path resolution and stale-socket recovery**

The constructor must allow explicit `stateDir` and `socketPath` test overrides while production uses `resolveRuntimePaths(process.env)`.

Implement `recoverStaleSocket({socketPath, fsImpl = fs, netImpl = net})` as follows:

1. If `lstatSync(socketPath)` returns `ENOENT`, return without mutation.
2. Reject if the existing entry is not a socket.
3. Reject if `process.getuid` exists and the entry uid differs.
4. Probe with `net.createConnection(socketPath)`.
5. If it connects, close the probe and reject with `Codex Micro emulator socket is already active`.
6. Treat `ENOENT` during the probe as an already-disappeared path and return without unlinking.
7. Treat only `ECONNREFUSED` as stale; re-stat the path and unlink only when `{dev,ino}` still matches the pre-probe identity.
8. Propagate every other probe error.

Before recovery, create the socket parent with `{recursive:true,mode:0o700}` and force it to `0700`. After `server.listen(socketPath)` succeeds, call `chmodSync(socketPath, 0o600)` and save `{dev,ino}`. `closeSync()` may unlink only when the current path still matches that saved identity. This prevents deleting a live or replacement socket.

- [ ] **Step 4: Implement strict command validation**

Define immutable validation tables:

```js
const ALLOWED_KEYS = new Set([
  "AG00", "AG01", "AG02", "AG03", "AG04", "AG05",
  "ACT06", "ACT07", "ACT08", "ACT09", "ACT10", "ACT11", "ACT12",
  "ENC_SW",
]);
const KEY_ACTIONS = new Set(["press", "release", "tap"]);
const JOYSTICK = Object.freeze({
  up: { a: 0.75, d: 1 },
  right: { a: 0, d: 1 },
  down: { a: 0.25, d: 1 },
  left: { a: 0.5, d: 1 },
  center: { a: 0, d: 0 },
});
```

`validateCommand(value)` must require a plain object, reject unknown keys for each command, and return one of:

```js
{ ok: true, value: normalizedCommand }
{ ok: false, error: { code: "invalid_command", message: "..." } }
```

Use distinct codes `malformed_json`, `invalid_command`, `invalid_key`, `invalid_action`, `invalid_direction`, `invalid_steps`, `line_too_large`, `disconnected`, `trace_failed`, and `internal_error`. Default omitted encoder steps to `1`; accept only `Number.isInteger(steps) && steps >= 1 && steps <= 100`.

- [ ] **Step 5: Implement the socket server and command dispatcher**

`start()` must initialize the trace before binding the socket. If socket setup fails, record `connection:error` when the trace is healthy, call `fail(error)`, and reject. On success set `state="discoverable"`, `desiredConnected=true`, and record `connection:discoverable`.

After `start()` and `closeSync()` are complete, replace Task 2's non-advertising singleton block with the final module-load startup:

```js
const defaultRuntime = new CodexMicroEmulatorRuntime();
defaultRuntime.startPromise = defaultRuntime.start().catch((error) => {
  defaultRuntime.fail(error);
  return false;
});
process.once("exit", () => defaultRuntime.closeSync());

function createOptions() {
  return defaultRuntime.createOptions();
}
```

For each client, accumulate `Buffer` chunks until newline boundaries. Reject and end the client when a line exceeds `MAX_SOCKET_LINE_BYTES`. Parse each complete line, validate it independently, and serialize exactly one response line.

Dispatch commands as follows:

```js
switch (command.command) {
  case "status": return { ok: true, result: this.status() };
  case "watch":  return this.beginWatch(socket);
  case "connect": return this.requestConnect();
  case "disconnect": return this.requestDisconnect();
  case "key": return this.sendKey(command.key, command.action);
  case "encoder": return this.sendEncoder(command.direction, command.steps);
  case "joystick": return this.sendJoystick(command.direction);
}
```

`dispatchNotification(method, params)` must first ensure a connected current communication object with a registered handler, then append `notify.rx` with `{method,params}`, and only then call `deliverNotification(method, params)`. Use only `"v.oai.hid"` and `"v.oai.rad"`.

Key dispatch is:

```js
const act = action === "press" ? 1 : 0;
if (action !== "tap") return this.dispatchNotification("v.oai.hid", { k: key, act });
this.dispatchNotification("v.oai.hid", { k: key, act: 1 });
const timer = this.setTimer(() => {
  this.pendingTimers.delete(timer);
  if (this.currentComm?.isConnected()) {
    this.dispatchNotification("v.oai.hid", { k: key, act: 0 });
  }
}, TAP_DELAY_MS);
this.pendingTimers.add(timer);
```

Encoder dispatch emits one `{k:"ENC_CW"|"ENC_CC",act:2}` notification per step. Joystick dispatch copies the selected `JOYSTICK` entry.

`disconnect` sets `desiredConnected=false`, calls `forceDisconnect()` on the current communication object, and returns the new status. `connect` sets `desiredConnected=true`, records `connection:discoverable`, and relies on the upstream service's existing retry schedule.

`watch` sends `{ok:true,result:{watching:true,session}}`, then registers `trace.subscribe(record => socket.write(JSON.stringify(record)+"\n"))`. Remove the subscription on `close` or `error`.

- [ ] **Step 6: Close the device on trace/socket failures**

Make `fail(error)` idempotent:

```js
fail(error) {
  if (this.state === "error") return;
  this.error = error instanceof Error ? error.message : String(error);
  this.state = "error";
  this.desiredConnected = false;
  const comm = this.currentComm;
  this.currentComm = null;
  comm?.forceError(new Error(this.error));
}
```

Do not call `record()` from `fail()` after a `TraceWriter` error. Socket startup errors may append their `connection:error` record before calling `fail()` because the trace is still healthy.

- [ ] **Step 7: Run the socket/runtime suite**

Run:

```bash
node --test linux-features/codex-micro-emulator/test.js
```

Expected: PASS, with no leaked Unix socket and no test process hang.

- [ ] **Step 8: Commit the validated control surface**

```bash
git add linux-features/codex-micro-emulator/emulator.cjs linux-features/codex-micro-emulator/test.js
git commit -m "feat(codex-micro): add private emulator control socket"
```

---

### Task 4: Implement and test the typed Python CLI

**Files:**
- Modify: `linux-features/codex-micro-emulator/bin/codex-micro-emulator`
- Modify: `linux-features/codex-micro-emulator/test.js`

**Interfaces:**
- Consumes: the exact socket command/response protocol from Task 3.
- Produces: repository/generated-app CLI commands and human/raw watch output.

- [ ] **Step 1: Add failing CLI argument and protocol tests**

Resolve Python once in the test file and add a helper that runs the CLI with the runtime's `XDG_RUNTIME_DIR`:

```js
const { spawn, spawnSync } = require("node:child_process");
const CLI = path.join(FEATURE_DIR, "bin", "codex-micro-emulator");
const PYTHON = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0 ? "python3" : null;

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
```

Add these tests, guarded with `{ skip: PYTHON == null }`:

```js
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
    assert.match(status.stdout, /state=connected(?:\s|$)/);
    const key = await runCli(["key", "ACT06", "press"], { env: cliEnv(runtime) });
    assert.equal(key.status, 0, key.stderr);
    assert.deepEqual(received, [{ k: "ACT06", act: 1 }]);
  });
});
```

Add an asynchronous watch test: spawn `[CLI,"watch","--raw"]`, wait until its stdout contains the watch acknowledgement or the process is connected, call `runtime.record("connection",{state:"cli-watch"})`, assert stdout contains `"state":"cli-watch"`, then terminate only that child and await `close`.

- [ ] **Step 2: Run the CLI tests and verify the fail-closed boundary exits**

Run:

```bash
node --test linux-features/codex-micro-emulator/test.js
```

Expected: FAIL because the fail-closed CLI exits with `no virtual device is discoverable`.

- [ ] **Step 3: Implement socket resolution, request exchange, and strict argparse choices**

Replace the fail-closed CLI boundary with a standard-library script structured around these functions:

```python
#!/usr/bin/env python3
import argparse
import json
import os
import socket
import sys

ALLOWED_KEYS = [
    "AG00", "AG01", "AG02", "AG03", "AG04", "AG05",
    "ACT06", "ACT07", "ACT08", "ACT09", "ACT10", "ACT11", "ACT12",
    "ENC_SW",
]

def bounded_steps(value):
    steps = int(value)
    if not 1 <= steps <= 100:
        raise argparse.ArgumentTypeError("steps must be between 1 and 100")
    return steps

def socket_path():
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR")
    if not runtime_dir:
        raise RuntimeError("XDG_RUNTIME_DIR is required")
    return os.path.join(runtime_dir, "codex-desktop", "codex-micro-emulator.sock")

def connect_socket():
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.connect(socket_path())
    return client

def send_request(request):
    with connect_socket() as client:
        client.sendall((json.dumps(request, separators=(",", ":")) + "\n").encode("utf-8"))
        line = client.makefile("r", encoding="utf-8").readline()
    if not line:
        raise RuntimeError("emulator closed the socket without a response")
    response = json.loads(line)
    if not response.get("ok"):
        error = response.get("error") or {}
        raise RuntimeError(error.get("message") or error.get("code") or "emulator command failed")
    return response.get("result") or {}
```

Build subparsers for all seven command groups. `key` uses `choices=ALLOWED_KEYS` and `choices=["press","release","tap"]`; `encoder` uses `choices=["cw","ccw"]`, `--steps`, `type=bounded_steps`, and `default=1`; `joystick` uses the five exact choices. No parser accepts a raw JSON argument.

- [ ] **Step 4: Implement status and watch rendering**

For non-watch commands, send the corresponding object and print a concise success line. Format status exactly as `state=<state> connected=<true|false> discoverable=<true|false> log=<path> socket=<path>` so polling cannot confuse `connected` with `disconnected`.

Implement human watch rendering with exact high-signal fields:

```python
def render_record(record):
    kind = record.get("type", "unknown")
    if kind == "rpc.request":
        return f"rpc.request id={record.get('id')} method={record.get('method')} raw={record.get('raw')}"
    if kind == "hid.frame":
        return (
            f"hid.frame rpc={record.get('rpcId')} "
            f"packet={record.get('packet')}/{record.get('packetCount')} "
            f"bytes={record.get('payloadLength')} {record.get('reportHex')}"
        )
    if kind == "rpc.response":
        return f"rpc.response id={record.get('id')} method={record.get('method')} raw={record.get('raw')}"
    if kind == "notify.rx":
        return f"notify.rx method={record.get('method')} params={json.dumps(record.get('params'), separators=(',', ':'))}"
    return f"{kind} {json.dumps(record, separators=(',', ':'))}"
```

`watch --raw` prints each trace line exactly as received after stripping only its newline. Human watch parses each trace record and calls `render_record`. Flush every printed line so shell pipelines see live data.

Catch `BrokenPipeError` as a clean exit. Catch `FileNotFoundError`, `ConnectionRefusedError`, `json.JSONDecodeError`, and `RuntimeError`, print one `codex-micro-emulator: ...` line to stderr, and exit `1`. Leave argparse errors as exit `2`.

- [ ] **Step 5: Run CLI and syntax checks**

Run:

```bash
python3 -m py_compile linux-features/codex-micro-emulator/bin/codex-micro-emulator
node --test linux-features/codex-micro-emulator/test.js
```

Expected: both commands PASS; the test process exits without hanging after the watch child is closed.

- [ ] **Step 6: Commit the CLI**

```bash
git add linux-features/codex-micro-emulator/bin/codex-micro-emulator linux-features/codex-micro-emulator/test.js
git commit -m "feat(codex-micro): add typed emulator CLI"
```

---

### Task 5: Complete documentation, staging verification, regression coverage, and generated-app UAT

**Files:**
- Modify: `linux-features/codex-micro-emulator/README.md`
- Modify: `linux-features/codex-micro-emulator/test.js`

**Interfaces:**
- Consumes: all production interfaces from Tasks 1-4 and the repository candidate build flow.
- Produces: staged-resource proof, operator documentation, current-DMG patch proof, enabled generated-app UAT, and disabled generated-app absence proof.

- [ ] **Step 1: Add failing declarative staging and full record-order tests**

Import `stageEnabledLinuxFeatureInstall` and add a staging test:

```js
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
```

Add one integration test that connects the fake communication object, sends one `v.oai.rgbcfg` request, dispatches one key notification, reads every rotated/active JSONL line in generation order, filters to the current session, and asserts:

```js
assert.deepEqual(records.map(({ type }) => type), [
  "session",
  "connection", // discoverable or discovering
  "connection", // connected
  "rpc.request",
  "hid.frame",
  "rpc.response",
  "notify.rx",
]);
assert.deepEqual(records.map(({ seq }) => seq), records.map((_, index) => index + 1));
```

Normalize the expected initial connection entries to the exact runtime behavior selected in Task 3; do not weaken the relative order `rpc.request -> all hid.frame records -> rpc.response -> notify.rx`.

- [ ] **Step 2: Run the focused suite before documentation/staging completion**

Run:

```bash
node --test linux-features/codex-micro-emulator/test.js
```

Expected: the staging test fails until `stageEnabledLinuxFeatureInstall` is imported and all files/modes are final; the record-order test exposes any sequence mismatch.

- [ ] **Step 3: Expand the README with verified operator documentation**

Document these sections and exact facts:

1. Purpose: protocol investigation without physical Codex Micro hardware.
2. Non-goals: no kernel USB/HID emulation, no Work Louder VID/PID spoofing, no Air60 firmware changes.
3. Enablement: add `codex-micro-emulator` to the gitignored `linux-features/features.json`, rebuild, and do not edit `features.example.json`.
4. Generated CLI path: `codex-app/resources/native/codex-micro-emulator`.
5. All seven command forms, including `watch --raw`, encoder `--steps`, and allowed key names.
6. State/log/socket paths and the explicit `XDG_RUNTIME_DIR` requirement.
7. JSONL record types, simulated HID framing, 5 MiB rotation, and three total generations.
8. Privacy: raw Codex Micro RPC is private debug data even though observed traffic is lighting/status, not prompts.
9. Failure behavior: trace or socket failure disconnects the virtual device; enabled patch drift rejects a candidate.
10. Verification commands from Step 5 below.
11. Future Air60 V2 work is a separate layer that should consume typed commands through VIA shortcuts or QMK Raw HID, without USB identity spoofing.

Do not claim that the feature controls the Air60 V2 in this release.

- [ ] **Step 4: Run focused and framework regression suites**

Run each command separately so a hung suite is attributable:

```bash
node --test linux-features/codex-micro-emulator/test.js
node --test scripts/lib/linux-features.test.js
node --test scripts/patch-linux-window-ui.test.js
git diff --check
```

Expected: all Node suites PASS and `git diff --check` prints nothing.

- [ ] **Step 5: Build an enabled current-DMG candidate without changing local feature config**

Create an isolated UAT root/config with Node so no tracked or user-owned config is overwritten:

```bash
codex_micro_uat=$(mktemp -d)
node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({enabled:["codex-micro-emulator"]}, null, 2)+"\n")' "$codex_micro_uat/enabled-features.json"
CODEX_LINUX_FEATURES_CONFIG="$codex_micro_uat/enabled-features.json" \
CODEX_NEXT_APP_DIR="$codex_micro_uat/codex-app-enabled" \
REBUILD_REPORT_DIR="$codex_micro_uat/enabled-report" \
./scripts/rebuild-candidate.sh ./Codex.dmg
```

Expected: candidate verdict is `accepted` or `accepted_with_warnings`. Verify the feature patch entry exactly:

```bash
node -e 'const r=require(process.argv[1]); const p=r.patches.find((p)=>p.name==="feature:codex-micro-emulator:codex-micro-emulator-main"); if (!p || p.status!=="applied") { console.error(p||"missing feature patch"); process.exit(1); }' "$codex_micro_uat/enabled-report/patch-report.json"
```

Verify declarative payloads:

```bash
test -r "$codex_micro_uat/codex-app-enabled/.codex-linux/features/codex-micro-emulator/emulator.cjs"
test -x "$codex_micro_uat/codex-app-enabled/resources/native/codex-micro-emulator"
stat -c '%a %n' \
  "$codex_micro_uat/codex-app-enabled/.codex-linux/features/codex-micro-emulator/emulator.cjs" \
  "$codex_micro_uat/codex-app-enabled/resources/native/codex-micro-emulator"
```

Expected modes: `644` for `emulator.cjs`, `755` for the CLI.

- [ ] **Step 6: Run isolated generated-app UAT and capture outbound traffic**

Use the launcher's built-in multi-instance mode and isolated XDG roots so the active Codex task is not replaced:

```bash
mkdir -p "$codex_micro_uat/runtime" "$codex_micro_uat/state" "$codex_micro_uat/config" "$codex_micro_uat/cache"
chmod 700 "$codex_micro_uat/runtime"
codex_micro_app_pid=""
codex_micro_watch_pid=""
codex_micro_cleanup() {
  [ -z "$codex_micro_watch_pid" ] || kill "$codex_micro_watch_pid" 2>/dev/null || true
  [ -z "$codex_micro_app_pid" ] || kill "$codex_micro_app_pid" 2>/dev/null || true
}
trap codex_micro_cleanup EXIT
XDG_RUNTIME_DIR="$codex_micro_uat/runtime" \
XDG_STATE_HOME="$codex_micro_uat/state" \
XDG_CONFIG_HOME="$codex_micro_uat/config" \
XDG_CACHE_HOME="$codex_micro_uat/cache" \
"$codex_micro_uat/codex-app-enabled/start.sh" --new-instance \
  >"$codex_micro_uat/enabled-app.log" 2>&1 &
codex_micro_app_pid=$!
```

Use the same runtime environment for the CLI and poll for connection:

```bash
for attempt in $(seq 1 120); do
  if XDG_RUNTIME_DIR="$codex_micro_uat/runtime" \
    "$codex_micro_uat/codex-app-enabled/resources/native/codex-micro-emulator" status \
    >"$codex_micro_uat/status.txt" 2>"$codex_micro_uat/status.err" && \
    rg -q 'state=connected([[:space:]]|$)' "$codex_micro_uat/status.txt"; then
    break
  fi
  sleep 1
done
rg -n 'state=connected([[:space:]]|$)' "$codex_micro_uat/status.txt"
```

Start raw watch, exercise every input family, and stop only the UAT watcher/application:

```bash
XDG_RUNTIME_DIR="$codex_micro_uat/runtime" \
  "$codex_micro_uat/codex-app-enabled/resources/native/codex-micro-emulator" watch --raw \
  >"$codex_micro_uat/watch.jsonl" 2>"$codex_micro_uat/watch.err" &
codex_micro_watch_pid=$!
sleep 1
XDG_RUNTIME_DIR="$codex_micro_uat/runtime" "$codex_micro_uat/codex-app-enabled/resources/native/codex-micro-emulator" key AG00 tap
XDG_RUNTIME_DIR="$codex_micro_uat/runtime" "$codex_micro_uat/codex-app-enabled/resources/native/codex-micro-emulator" encoder cw --steps 2
XDG_RUNTIME_DIR="$codex_micro_uat/runtime" "$codex_micro_uat/codex-app-enabled/resources/native/codex-micro-emulator" joystick left
XDG_RUNTIME_DIR="$codex_micro_uat/runtime" "$codex_micro_uat/codex-app-enabled/resources/native/codex-micro-emulator" disconnect
XDG_RUNTIME_DIR="$codex_micro_uat/runtime" "$codex_micro_uat/codex-app-enabled/resources/native/codex-micro-emulator" connect
sleep 2
kill "$codex_micro_watch_pid"
wait "$codex_micro_watch_pid" 2>/dev/null || true
codex_micro_watch_pid=""
kill "$codex_micro_app_pid"
wait "$codex_micro_app_pid" 2>/dev/null || true
codex_micro_app_pid=""
trap - EXIT
```

Verify the durable trace, not only watcher output:

```bash
codex_micro_events=$(sed -n 's/.* log=\([^[:space:]]*\) socket=.*/\1/p' "$codex_micro_uat/status.txt")
test -n "$codex_micro_events"
test -r "$codex_micro_events"
rg -n '"method":"v\.oai\.rgbcfg"|"method":"v\.oai\.thstatus"|"method":"device\.status"' "$codex_micro_events"
rg -n '"type":"hid\.frame".*"simulated":true' "$codex_micro_events"
rg -n '"type":"notify\.rx".*"method":"v\.oai\.(hid|rad)"' "$codex_micro_events"
```

Expected: initial upstream `v.oai.rgbcfg`, `v.oai.thstatus`, and `device.status` requests exist; each request has simulated HID frame records; the CLI inputs produce validated `notify.rx` records.

- [ ] **Step 7: Build a disabled candidate and prove there is no injection**

```bash
node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({enabled:[]}, null, 2)+"\n")' "$codex_micro_uat/disabled-features.json"
CODEX_LINUX_FEATURES_CONFIG="$codex_micro_uat/disabled-features.json" \
CODEX_NEXT_APP_DIR="$codex_micro_uat/codex-app-disabled" \
REBUILD_REPORT_DIR="$codex_micro_uat/disabled-report" \
./scripts/rebuild-candidate.sh ./Codex.dmg
```

Expected:

```bash
test ! -e "$codex_micro_uat/codex-app-disabled/.codex-linux/features/codex-micro-emulator/emulator.cjs"
test ! -e "$codex_micro_uat/codex-app-disabled/resources/native/codex-micro-emulator"
node -e 'const r=require(process.argv[1]); if (r.patches.some((p)=>p.name.startsWith("feature:codex-micro-emulator:"))) process.exit(1)' "$codex_micro_uat/disabled-report/patch-report.json"
```

Extract the current main bundle with `npx --yes asar` in a fresh subdirectory and assert the marker is absent:

```bash
mkdir -p "$codex_micro_uat/disabled-asar"
(
  cd "$codex_micro_uat/disabled-asar"
  codex_micro_main=$(npx --yes asar list "$codex_micro_uat/codex-app-disabled/resources/app.asar" | sed -n '/^\/\.vite\/build\/main-.*\.js$/p' | head -n 1)
  test -n "$codex_micro_main"
  npx --yes asar extract-file "$codex_micro_uat/codex-app-disabled/resources/app.asar" "${codex_micro_main#/}"
  ! rg -q 'codexLinuxCodexMicroEmulatorOptions' "$(basename "$codex_micro_main")"
)
```

This checks the generated ASAR, while the patch unit test checks byte-idempotence and drift behavior.

- [ ] **Step 8: Final self-check and commit**

Run:

```bash
rg -n 'T[B]D|T[O]DO|F[I]XME|legacy fallback|features\.example\.json' linux-features/codex-micro-emulator
git diff --check
git status --short
```

Expected: no implementation placeholders; the only `features.example.json` mention is documentation saying not to edit it; formatting is clean; only the feature files are modified.

Commit:

```bash
git add linux-features/codex-micro-emulator/README.md linux-features/codex-micro-emulator/test.js
git commit -m "docs(codex-micro): document and verify emulator workflow"
```

---

## Completion Gate

The implementation is complete only when all of the following are true:

- The feature remains absent from committed enablement config and from `features.example.json`.
- Current-shape patching is byte-idempotent and drift leaves the source unchanged with a feature warning.
- `createOptions()` has no `createApi`, and the generated app trace proves upstream `v.oai.rgbcfg`, `v.oai.thstatus`, and `device.status` requests reached the fake communication boundary.
- Multibyte framing, 61-byte chunking, 64-byte reports, zero padding, permissions, three-generation rotation, response ID types, and sequence ordering have automated coverage.
- Live sockets and replacement inodes are never removed as stale/owned paths.
- Invalid, oversized, disconnected, and trace-failed inputs never reach notification handlers.
- `status`, human/raw `watch`, key, encoder, joystick, connect, and disconnect work through the staged CLI.
- Enabled generated-app UAT passes with no physical hardware, while a disabled generated app contains neither staged resources nor the patch marker.
