# Codex Micro Automatic Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start the optional Codex Micro emulator through the existing upstream service-manager path at application launch so generated-app runtime UAT works without the gated renderer bridge.

**Architecture:** Extend the current main-bundle patch with one current-shape service-manager constructor anchor and one fire-and-forget bootstrap helper. The helper calls the existing manager `getState()` once, so upstream `CodexMicroService`, `RPCApiOAI`, `WLRPCClient`, service caching, stop, and disposal remain authoritative; renderer gate `3207467860` and UI visibility remain unchanged. Bootstrap rejection is logged and contained so Electron continues running while the emulator remains unavailable.

**Tech Stack:** CommonJS, repository main-bundle patch descriptors, `node:test`, Node `vm`, generated Electron app runtime, Python 3 standard-library CLI, and shell-based isolated UAT.

## Global Constraints

- The feature id remains `codex-micro-emulator` and `defaultEnabled` remains exactly `false`.
- The repository supports only the latest upstream `Codex.dmg`; keep one current patch shape and no legacy fallback needles.
- Do not modify `linux-features/features.example.json` or commit `linux-features/features.json`.
- Keep the upstream `CodexMicroService`, `RPCApiOAI`, and `WLRPCClient` in the runtime path.
- Inject only `discovery` and `createComm`; never inject `createApi`.
- Automatic bootstrap invokes the existing service manager `getState()` exactly once when that manager is constructed.
- Do not patch the renderer, `CodexMicroBridge`, Statsig gate `3207467860`, webview assets, or UI visibility.
- A rejected bootstrap promise is caught and logged with exact prefix `[codex-micro-emulator] automatic bootstrap failed`; it must not terminate Electron or become an unhandled rejection.
- Require exactly one current service constructor anchor, one current service-manager constructor anchor, and one dynamic service import before changing the bundle; otherwise make no partial change.
- Reapplying the patch to a fully patched bundle is byte-for-byte idempotent. A bundle containing only one helper marker is not accepted as fully patched and is left unchanged with the drift warning.
- Generated-app UAT must set dedicated `CODEX_HOME`, `XDG_RUNTIME_DIR`, `XDG_STATE_HOME`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME` under one new UAT root.
- Do not write, delete, restore, or rewrite anything under the user's ordinary `~/.codex` during implementation or UAT.
- Stop only a watcher child PID captured from `$!` and the Electron PID whose `/proc/<pid>/exe` exactly resolves to the generated candidate's Electron binary; never use `pkill`, `killall`, or process-name matching.

---

## File Structure

- `linux-features/codex-micro-emulator/patch.js` — current-shape constructor anchors, both injected helpers, all-or-nothing patch application, and test exports.
- `linux-features/codex-micro-emulator/test.js` — fixture coverage, injection/idempotence/drift tests, and executable bootstrap-helper behavior.
- `linux-features/codex-micro-emulator/README.md` — automatic startup behavior, unchanged UI gate, contained failure behavior, and updated missing-socket diagnosis.
- `.superpowers/sdd/task-6-report.md` — ignored implementation, RED/GREEN, generated-app UAT, cleanup, and external-state audit evidence; never commit this file.

### Task 6: Bootstrap the upstream service manager and prove the generated runtime

**Files:**
- Modify: `linux-features/codex-micro-emulator/patch.js`
- Modify: `linux-features/codex-micro-emulator/test.js`
- Modify: `linux-features/codex-micro-emulator/README.md`
- Evidence only: `.superpowers/sdd/task-6-report.md`

**Interfaces:**
- Consumes: the current minified service-manager constructor `service=null;servicePromise=null;constructor(e){this.windowManager=e}`, its existing async `getState()` method, the existing service constructor tail, and the dynamic `codex-micro-service-*.js` import.
- Produces: exported `BOOTSTRAP_MARKER`, `SERVICE_MANAGER_CONSTRUCTOR`, and `bootstrapHelperSource()` test surfaces; injected `codexLinuxBootstrapCodexMicroEmulator(manager)`; automatic one-shot invocation from the patched manager constructor.
- Preserves: exported `PATCH_MARKER`, `CONSTRUCTOR_TAIL`, `applyCodexMicroEmulatorPatch()`, `descriptors`, the staged module/CLI paths, and the emulator module interface.

- [ ] **Step 1: Add the current manager shape and failing bootstrap assertions**

Add `const vm = require("node:vm");` to `test.js`. Extend `currentMainBundleFixture()` so its class begins with this exact current manager surface before `getService()`:

```js
"class eS{service=null;servicePromise=null;constructor(e){this.windowManager=e}",
"async getState(){let e=await this.getService();return e.start(),e.getState()}",
```

Replace the test-side warning constant with the new exact message:

```js
const PATCH_SKIP_WARNING =
  "WARN: current Codex Micro service and manager constructors were not found exactly once - skipping Codex Micro emulator patch";
```

Change the injection test to require the not-yet-implemented test exports and make these assertions:

```js
const {
  applyCodexMicroEmulatorPatch,
  BOOTSTRAP_MARKER,
  PATCH_MARKER,
} = require("./patch.js");

assert.equal(patched.split(PATCH_MARKER).length - 1, 1);
assert.equal(patched.split(BOOTSTRAP_MARKER).length - 1, 1);
assert.equal(
  patched.split("codexLinuxBootstrapCodexMicroEmulator(this)").length - 1,
  1,
);
```

Extend the drift test with a manager-anchor removal and both one-marker partial inputs. Import `BOOTSTRAP_MARKER` and `PATCH_MARKER` in that test, then expect one warning for each unchanged input:

```js
const missingService = source.replace("onJoystickEvent", "onStickEvent");
const missingManager = source.replace(
  "service=null;servicePromise=null;constructor(e){this.windowManager=e}",
  "service=null;servicePromise=null;constructor(e){this.windows=e}",
);
const duplicated = `${source};${source}`;
const optionsOnly = `${source};${PATCH_MARKER}`;
const bootstrapOnly = `${source};${BOOTSTRAP_MARKER}`;
assert.equal(applyCodexMicroEmulatorPatch(missingService), missingService);
assert.equal(applyCodexMicroEmulatorPatch(missingManager), missingManager);
assert.equal(applyCodexMicroEmulatorPatch(duplicated), duplicated);
assert.equal(applyCodexMicroEmulatorPatch(optionsOnly), optionsOnly);
assert.equal(applyCodexMicroEmulatorPatch(bootstrapOnly), bootstrapOnly);
assert.deepEqual(warnings, Array(5).fill(PATCH_SKIP_WARNING));
```

Add this helper-behavior test. It evaluates the actual injected helper source rather than a separate reimplementation:

```js
test("automatic bootstrap calls getState once and contains rejection", async () => {
  const { bootstrapHelperSource } = require("./patch.js");
  const errors = [];
  const context = {
    console: { error: (...args) => errors.push(args) },
  };
  vm.runInNewContext(
    `${bootstrapHelperSource()};globalThis.bootstrap=codexLinuxBootstrapCodexMicroEmulator`,
    context,
  );
  const failure = new Error("bootstrap failed");
  let calls = 0;
  const result = context.bootstrap({
    getState() {
      calls += 1;
      return Promise.reject(failure);
    },
  });

  assert.equal(result, undefined);
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  assert.deepEqual(errors, [[
    "[codex-micro-emulator] automatic bootstrap failed",
    failure,
  ]]);
});
```

- [ ] **Step 2: Run the focused tests and preserve the expected RED**

Run:

```bash
node --test --test-name-pattern='patch|bootstrap' linux-features/codex-micro-emulator/test.js
```

Expected: FAIL because `BOOTSTRAP_MARKER` and `bootstrapHelperSource` are not exported and the current patch does not inject `codexLinuxBootstrapCodexMicroEmulator(this)`. Record the exact command, failing test names, and output in `.superpowers/sdd/task-6-report.md`; do not commit the report.

- [ ] **Step 3: Implement the minimal all-or-nothing bootstrap patch**

Add these exact constants to `patch.js`:

```js
const BOOTSTRAP_MARKER = "function codexLinuxBootstrapCodexMicroEmulator(e)";
const SERVICE_MANAGER_CONSTRUCTOR =
  "service=null;servicePromise=null;constructor(e){this.windowManager=e}";
const PATCH_SKIP_WARNING =
  "WARN: current Codex Micro service and manager constructors were not found exactly once - skipping Codex Micro emulator patch";
```

Make `bootstrapHelperSource()` return the production helper exactly:

```js
function bootstrapHelperSource() {
  return [
    "function codexLinuxBootstrapCodexMicroEmulator(e){",
    "void e.getState().catch(e=>console.error(`[codex-micro-emulator] automatic bootstrap failed`,e))",
    "}",
  ].join("");
}
```

Append `bootstrapHelperSource()` beside the existing options helper before the source map. Before any replacement, distinguish fully patched and partial-marker inputs:

```js
const hasOptionsHelper = source.includes(PATCH_MARKER);
const hasBootstrapHelper = source.includes(BOOTSTRAP_MARKER);
if (hasOptionsHelper && hasBootstrapHelper) return source;
if (hasOptionsHelper || hasBootstrapHelper) {
  console.warn(PATCH_SKIP_WARNING);
  return source;
}
```

Require exactly one service import, service constructor tail, and manager constructor. Build both replacements before returning so no anchor failure can leave a partial patch:

```js
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
```

Export `BOOTSTRAP_MARKER`, `SERVICE_MANAGER_CONSTRUCTOR`, and `bootstrapHelperSource`. Keep the existing descriptor id and order unchanged.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run:

```bash
node --test --test-name-pattern='patch|bootstrap' linux-features/codex-micro-emulator/test.js
```

Expected: every selected patch/bootstrap test passes, including injection, byte-idempotence, service-anchor drift, manager-anchor drift, duplicate-anchor drift, and caught rejection behavior.

- [ ] **Step 5: Document automatic startup and the new diagnosis boundary**

Update `README.md` with these facts:

- Enabling the feature automatically bootstraps the existing upstream service-manager `getState()` path once at application launch.
- Renderer gate `3207467860` and Codex Micro UI visibility are unchanged; the emulator may run without visible Codex Micro UI.
- Bootstrap rejection uses log prefix `[codex-micro-emulator] automatic bootstrap failed`, leaves the app running, and leaves the emulator unavailable.
- Replace the old statement that service startup is renderer-lazy. A missing socket now means the generated patch/staged module, automatic-bootstrap log, isolated runtime paths, or emulator startup failed; it is not repaired by forcing a renderer gate.
- Preserve the dedicated `CODEX_HOME` plus four XDG roots and validated Electron-PID cleanup instructions exactly.

- [ ] **Step 6: Run the complete focused and framework regressions**

Run:

```bash
node --test linux-features/codex-micro-emulator/test.js
node --test scripts/lib/linux-features.test.js
node --test scripts/patch-linux-window-ui.test.js
git diff --check
```

Expected: all feature, feature-framework, and main patcher tests pass; `git diff --check` prints nothing. Record commands, counts, and outcomes in `.superpowers/sdd/task-6-report.md`.

- [ ] **Step 7: Commit the reviewed implementation scope**

Review `git diff -- linux-features/codex-micro-emulator/patch.js linux-features/codex-micro-emulator/test.js linux-features/codex-micro-emulator/README.md`, then run:

```bash
git add \
  linux-features/codex-micro-emulator/patch.js \
  linux-features/codex-micro-emulator/test.js \
  linux-features/codex-micro-emulator/README.md
git commit -m "feat(codex-micro): bootstrap emulator at app launch"
```

Expected: the commit contains only those three feature files. `.superpowers/sdd/task-6-report.md`, generated apps, feature config, and UAT artifacts remain untracked/ignored.

- [ ] **Step 8: Build fresh enabled and disabled candidates in one isolated UAT root**

Create one new UAT root and never reuse `/tmp/codex-micro-task5-uat.1P1E5O`:

```bash
codex_micro_uat=$(mktemp -d /tmp/codex-micro-task6-uat.XXXXXX)
mkdir -p \
  "$codex_micro_uat/codex-home" \
  "$codex_micro_uat/runtime" \
  "$codex_micro_uat/state" \
  "$codex_micro_uat/config" \
  "$codex_micro_uat/cache"
chmod 700 "$codex_micro_uat/codex-home" "$codex_micro_uat/runtime"
node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({enabled:["codex-micro-emulator"]}, null, 2)+"\n")' \
  "$codex_micro_uat/enabled-features.json"
node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({enabled:[]}, null, 2)+"\n")' \
  "$codex_micro_uat/disabled-features.json"
CODEX_HOME="$codex_micro_uat/codex-home" \
CODEX_LINUX_FEATURES_CONFIG="$codex_micro_uat/enabled-features.json" \
CODEX_NEXT_APP_DIR="$codex_micro_uat/codex-app-enabled" \
REBUILD_REPORT_DIR="$codex_micro_uat/enabled-report" \
  ./scripts/rebuild-candidate.sh ./Codex.dmg \
  >"$codex_micro_uat/enabled-build.log" 2>&1
CODEX_HOME="$codex_micro_uat/codex-home" \
CODEX_LINUX_FEATURES_CONFIG="$codex_micro_uat/disabled-features.json" \
CODEX_NEXT_APP_DIR="$codex_micro_uat/codex-app-disabled" \
REBUILD_REPORT_DIR="$codex_micro_uat/disabled-report" \
  ./scripts/rebuild-candidate.sh ./Codex.dmg \
  >"$codex_micro_uat/disabled-build.log" 2>&1
node -e '
const fs = require("node:fs");
for (const reportPath of process.argv.slice(1)) {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (!["accepted", "accepted_with_warnings"].includes(report.verdict)) {
    throw new Error(`${reportPath}: ${report.verdict}`);
  }
}
' \
  "$codex_micro_uat/enabled-report/upstream-dmg-decision.json" \
  "$codex_micro_uat/disabled-report/upstream-dmg-decision.json"
node -e '
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const patch = report.patches.find((entry) => entry.name === "feature:codex-micro-emulator:codex-micro-emulator-main");
if (!patch || patch.status !== "applied") throw new Error(JSON.stringify(patch ?? "missing feature patch"));
' "$codex_micro_uat/enabled-report/patch-report.json"
node -e '
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (report.patches.some((entry) => entry.name === "feature:codex-micro-emulator:codex-micro-emulator-main")) {
  throw new Error("disabled candidate contains feature patch");
}
' "$codex_micro_uat/disabled-report/patch-report.json"
test "$(stat -c %a "$codex_micro_uat/codex-app-enabled/.codex-linux/features/codex-micro-emulator/emulator.cjs")" = 644
test "$(stat -c %a "$codex_micro_uat/codex-app-enabled/resources/native/codex-micro-emulator")" = 755
test ! -e "$codex_micro_uat/codex-app-disabled/.codex-linux/features/codex-micro-emulator/emulator.cjs"
test ! -e "$codex_micro_uat/codex-app-disabled/resources/native/codex-micro-emulator"
```

Expected: both candidate verdicts are `accepted` or `accepted_with_warnings`. The enabled patch report contains `feature:codex-micro-emulator:codex-micro-emulator-main` with status `applied`, and the staged module/CLI modes are `644`/`755`. The disabled patch report contains no feature patch entry, and both `.codex-linux/features/codex-micro-emulator/emulator.cjs` and `resources/native/codex-micro-emulator` are absent. Store the UAT root and verification output in the report.

- [ ] **Step 9: Launch the candidate and validate only its published Electron PID**

Capture the host Wayland socket before overriding the runtime directory, then launch with all five isolated roots:

```bash
codex_micro_host_runtime=${XDG_RUNTIME_DIR:?host XDG_RUNTIME_DIR is required}
codex_micro_wayland=${WAYLAND_DISPLAY:-wayland-0}
ln -s \
  "$codex_micro_host_runtime/$codex_micro_wayland" \
  "$codex_micro_uat/runtime/$codex_micro_wayland"
CODEX_HOME="$codex_micro_uat/codex-home" \
XDG_RUNTIME_DIR="$codex_micro_uat/runtime" \
XDG_STATE_HOME="$codex_micro_uat/state" \
XDG_CONFIG_HOME="$codex_micro_uat/config" \
XDG_CACHE_HOME="$codex_micro_uat/cache" \
WAYLAND_DISPLAY="$codex_micro_wayland" \
  "$codex_micro_uat/codex-app-enabled/start.sh" --new-instance \
  >"$codex_micro_uat/enabled-app.log" 2>&1 &
codex_micro_launcher_pid=$!
```

Use the README's bounded `port-*/app.pid` discovery block unchanged. Continue only after exactly one numeric PID is found and `/proc/$pid/exe` resolves exactly to `$codex_micro_uat/codex-app-enabled/electron`. If validation fails, signal no process and report `BLOCKED` with the isolated logs.

- [ ] **Step 10: Prove automatic connection, trace, input, watch, and reconnect**

Use the generated CLI with the same five isolated environment variables. Define one wrapper so every command has the same isolation:

```bash
codex_micro_cli="$codex_micro_uat/codex-app-enabled/resources/native/codex-micro-emulator"
codex_micro_cli_run() {
  CODEX_HOME="$codex_micro_uat/codex-home" \
  XDG_RUNTIME_DIR="$codex_micro_uat/runtime" \
  XDG_STATE_HOME="$codex_micro_uat/state" \
  XDG_CONFIG_HOME="$codex_micro_uat/config" \
  XDG_CACHE_HOME="$codex_micro_uat/cache" \
    "$codex_micro_cli" "$@"
}

codex_micro_wait_connected() {
  local status_json=$1
  local status_err=$2
  local connected=false
  for attempt in $(seq 1 120); do
    if codex_micro_cli_run status >"$status_json" 2>"$status_err" && \
       node -e 'const s=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.exit(s.connected===true?0:1)' \
         "$status_json"; then
      connected=true
      break
    fi
    sleep 1
  done
  test "$connected" = true
}

codex_micro_wait_connected \
  "$codex_micro_uat/status-initial.json" \
  "$codex_micro_uat/status-initial.err"
```

After connection, start raw watch and exercise typed input:

```bash
codex_micro_cli_run watch --raw \
  >"$codex_micro_uat/watch.jsonl" 2>"$codex_micro_uat/watch.err" &
codex_micro_watch_pid=$!

codex_micro_cli_run key AG00 tap
codex_micro_cli_run encoder cw --steps 2
codex_micro_cli_run joystick left
codex_micro_cli_run disconnect
codex_micro_cli_run connect
codex_micro_wait_connected \
  "$codex_micro_uat/status-reconnect.json" \
  "$codex_micro_uat/status-reconnect.err"
```

Then parse the isolated trace and watch output with this executable assertion:

```bash
codex_micro_trace="$codex_micro_uat/state/codex-desktop/codex-micro-emulator/events.jsonl"
node -e '
const fs = require("node:fs");
const trace = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const watch = fs.readFileSync(process.argv[2], "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
if (trace.length === 0) throw new Error("empty trace");
const session = trace.at(-1).session;
const records = trace.filter((record) => record.session === session);
for (let index = 1; index < records.length; index += 1) {
  if (records[index].seq <= records[index - 1].seq) throw new Error("non-monotonic trace sequence");
}
const states = records.filter((record) => record.type === "connection").map((record) => record.state);
const firstConnected = states.indexOf("connected");
const disconnected = states.indexOf("disconnected", firstConnected + 1);
const reconnected = states.indexOf("connected", disconnected + 1);
if (firstConnected < 0 || disconnected < 0 || reconnected < 0) throw new Error("missing connect-disconnect-reconnect order");
const requiredMethods = new Set(["v.oai.rgbcfg", "v.oai.thstatus", "device.status"]);
for (const method of requiredMethods) {
  const requestIndexes = records.map((record, index) => record.type === "rpc.request" && record.method === method ? index : -1).filter((index) => index >= 0);
  if (requestIndexes.length === 0) throw new Error(`missing rpc.request ${method}`);
  const requestIndex = requestIndexes[0];
  const request = records[requestIndex];
  const responseIndex = records.findIndex((record, index) => index > requestIndex && record.type === "rpc.response" && record.id === request.id);
  if (responseIndex < 0) throw new Error(`missing rpc.response ${method}`);
  const frames = records.slice(requestIndex + 1, responseIndex).filter((record) => record.type === "hid.frame" && record.rpcId === request.id);
  if (frames.length === 0) throw new Error(`missing hid.frame ${method}`);
  if (responseIndex - requestIndex - 1 !== frames.length) throw new Error(`non-contiguous hid.frame ${method}`);
}
const notifyMethods = new Set(records.filter((record) => record.type === "notify.rx").map((record) => record.method));
if (!notifyMethods.has("v.oai.hid") || !notifyMethods.has("v.oai.rad")) throw new Error("missing typed notifications");
if (watch.length === 0 || watch.some((record) => record.schema !== 1 || typeof record.type !== "string")) throw new Error("invalid raw watch records");
console.log(JSON.stringify({records: records.length, watch: watch.length, states, notifyMethods: [...notifyMethods]}));
' "$codex_micro_trace" "$codex_micro_uat/watch.jsonl"
```

The assertion requires:

- at least one `connection` record for `connected`, `disconnected`, and a later `connected`;
- initial `rpc.request` methods `v.oai.rgbcfg`, `v.oai.thstatus`, and `device.status`;
- one or more contiguous `hid.frame` records between each matching `rpc.request` and `rpc.response`;
- `notify.rx` for `v.oai.hid` and `v.oai.rad` after watch acknowledgement;
- strictly increasing `seq` values within the session;
- raw watch lines that parse as unwrapped trace records.

If any required record is absent, preserve the UAT root, stop the validated children, and report `DONE_WITH_CONCERNS`; do not weaken the acceptance assertions.

- [ ] **Step 11: Clean up only validated children and record the read-only external audit**

Run the README's `codex_micro_stop_watch` and `codex_micro_stop_app` functions unchanged. Verify no process has `/proc/<pid>/exe` or command-line ancestry rooted in the new candidate. Do not delete the UAT root.

Append these already-observed read-only audit facts to `.superpowers/sdd/task-6-report.md` without changing `~/.codex`:

- preserved Task 5 launcher log records `browser` and `computer-use` installs requested as `outdated` and succeeding under `/home/abe/.codex/plugins/cache/openai-bundled`;
- current cache directories were rewritten around `2026-07-17 14:37 +0900`, later than the preserved UAT event around `11:56`, so current files cannot be attributed only to that UAT;
- current versions are `browser 26.707.91948` and `computer-use 0.1.2-linux-alpha2`;
- current cache content differs from the preserved Task 5 candidate despite matching version strings;
- no pre-run snapshot exists, so safe rollback targets cannot be identified and no deletion/restoration was attempted.

Finish the report with `DONE` only if all automated tests, generated candidate checks, end-to-end runtime assertions, validated cleanup, clean git status, and no ordinary `~/.codex` write all pass. Otherwise use `DONE_WITH_CONCERNS` or `BLOCKED` and name the exact missing evidence.
