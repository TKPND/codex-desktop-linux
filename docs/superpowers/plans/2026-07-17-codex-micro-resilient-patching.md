# Codex Micro Resilient Patching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Codex Micro emulator's fragile exact-string patch with a structure-aware, transactional two-file patch that is accepted by the latest upstream DMG and remains usable from an isolated unsigned-in runtime.

**Architecture:** An `extracted-app:pre-webview` feature descriptor will discover exactly one `main-*.js` bundle and one `codex-micro-service-*.js` chunk. A small local scanner will identify the service export and the service-manager constructor by structural tokens, then the descriptor will syntax-check both in-memory results and write them as one rollback-capable transaction.

**Tech Stack:** Node.js CommonJS, `node:test`, `node:assert/strict`, `node:fs`, `node:path`, `node:vm`, the repository Linux feature descriptor engine, Git/GitHub CLI, and the existing candidate acceptance/runtime UAT scripts.

## Global Constraints

- Support only the latest upstream `CODEX.DMG`; remove the old long minified-string and import-shape patch instead of retaining compatibility branches.
- Keep `codex-micro-emulator` optional, disabled by default, and absent from committed `linux-features/features.example.json` enablement.
- Preserve the upstream `CodexMicroService`, `RPCApiOAI`, and `WLRPCClient`; inject only `discovery` and `createComm` through `emulator.cjs#createOptions()`.
- Use the Work Louder packages already shipped in the upstream application; do not copy, vendor, republish, or describe `@worklouder/device-kit-oai` as a public SDK.
- Do not add a general JavaScript AST dependency. Unsupported or ambiguous generated syntax is feature drift and must fail closed.
- Compute and parse-check both patched sources before either write. On a write failure, restore every already-written original and report a bounded error.
- Missing, duplicate, ambiguous, partially marked, malformed, or syntactically invalid targets must leave both target files byte-for-byte unchanged.
- Do not bypass renderer gate `3207467860`, expose hidden Codex Micro UI, implement the Air60 V2 bridge, or flash keyboard firmware in this stage.
- Do not touch the user's ordinary `/home/abe/.codex` during runtime UAT. Use isolated `CODEX_HOME` and all XDG roots.
- Never use `pkill`, `killall`, or a process-name match for UAT cleanup. Signal only the exact PID whose `/proc/<pid>/exe` resolves to the isolated candidate Electron binary.
- Keep personal `main` as the integration branch. Configure `origin` as `TKPND/codex-desktop-linux` and `upstream` as `ilysenko/codex-desktop-linux`; do not reset personal `main` to upstream.
- Do not automatically merge upstream changes or automatically promote a candidate.

## File Map

- Create `linux-features/codex-micro-emulator/patch-structure.js`: scanner, balanced-range helpers, service export transformation, main bootstrap transformation, markers, and pure two-source patch API.
- Create `linux-features/codex-micro-emulator/patch-structure.test.js`: focused scanner, mutation, ambiguity, idempotence, and source-map placement tests.
- Modify `linux-features/codex-micro-emulator/patch.js`: extracted-app target discovery, syntax validation, transactional writes/rollback, warning normalization, descriptor export, and test seams.
- Modify `linux-features/codex-micro-emulator/test.js`: remove the retired main-bundle exact-string tests, preserve the current double-quoted latest-DMG fixture as focused test input, and update descriptor expectations while retaining runtime/CLI/resource coverage.
- Modify `linux-features/codex-micro-emulator/README.md`: explain the public-export wrapper, structural bootstrap scanner, new descriptor ID, drift behavior, and latest-DMG verification commands.
- Create `docs/superpowers/plans/2026-07-17-codex-micro-resilient-patching.md`: this implementation plan.

---

### Task 1: Add the bounded JavaScript scanner

**Files:**

- Create: `linux-features/codex-micro-emulator/patch-structure.js`
- Create: `linux-features/codex-micro-emulator/patch-structure.test.js`

**Interfaces:**

- Produces: `tokenizeJavaScript(source) -> Token[]`, where each token is `{ type, value, start, end, quote, hasTemplateSubstitution }` and `end` is exclusive.
- Produces: `findMatchingDelimiter(tokens, openIndex) -> closeIndex`, throwing `CodexMicroPatchDriftError` on mismatched or unbalanced delimiters.
- Produces: `classRanges(tokens) -> Array<{ openIndex, closeIndex }>` and `classMethods(tokens, classRange) -> Array<{ name, bodyOpenIndex, bodyCloseIndex }>`.
- Produces: `CodexMicroPatchDriftError`, used by the transformation and filesystem layers to distinguish bounded upstream drift from programming errors.

- [ ] **Step 1: Write failing scanner contract tests**

Create `patch-structure.test.js` with direct tests for comments, identifiers, punctuation, decoded quote variants, template substitutions, balanced delimiters, and class methods. Use fixtures that are semantically current rather than historical-version fixtures:

```js
#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CodexMicroPatchDriftError,
  classMethods,
  classRanges,
  findMatchingDelimiter,
  tokenizeJavaScript,
} = require("./patch-structure.js");

test("scanner decodes service requests across supported quote spellings", () => {
  for (const literal of [
    "'./codex-micro-service-A1.js'",
    '"./codex-micro-service-B2.js"',
    "`./codex-micro-service-C3.js`",
  ]) {
    const tokens = tokenizeJavaScript(`require(${literal})`);
    const request = tokens.find((token) => token.type === "string");
    assert.equal(request.value.match(/^\.\/codex-micro-service-.*\.js$/) != null, true);
    assert.equal(request.hasTemplateSubstitution, false);
  }
});

test("scanner records template substitution instead of accepting it as a module request", () => {
  const request = tokenizeJavaScript("require(`./codex-micro-service-${hash}.js`)")
    .find((token) => token.type === "string");
  assert.equal(request.hasTemplateSubstitution, true);
});

test("scanner skips comments and returns balanced class method bodies", () => {
  const source = "/* class Fake{} */ class Manager{constructor(e){this.w=e}// }\ngetState(){return this.w}}";
  const tokens = tokenizeJavaScript(source);
  const ranges = classRanges(tokens);
  assert.equal(ranges.length, 1);
  assert.deepEqual(classMethods(tokens, ranges[0]).map(({ name }) => name), ["constructor", "getState"]);
  assert.equal(tokens[findMatchingDelimiter(tokens, ranges[0].openIndex)].value, "}");
});

test("scanner rejects mismatched delimiters", () => {
  const tokens = tokenizeJavaScript("class Manager{constructor(){]");
  const openIndex = tokens.findIndex((token) => token.value === "{");
  assert.throws(
    () => findMatchingDelimiter(tokens, openIndex),
    CodexMicroPatchDriftError,
  );
});
```

- [ ] **Step 2: Run the scanner tests and confirm the RED state**

Run:

```bash
node --test linux-features/codex-micro-emulator/patch-structure.test.js
```

Expected: FAIL because `patch-structure.js` does not exist.

- [ ] **Step 3: Implement the scanner without an AST dependency**

Create `patch-structure.js` with the following exports and behaviors:

```js
"use strict";

class CodexMicroPatchDriftError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodexMicroPatchDriftError";
  }
}

function tokenizeJavaScript(source) {
  // Advance one UTF-16 source offset at a time. Skip whitespace plus // and
  // /* */ comments. Emit identifiers, punctuation, and quoted string tokens.
  // Decode escapes needed to compare module requests. Mark a backtick token
  // containing an unescaped ${ as hasTemplateSubstitution: true.
}

function findMatchingDelimiter(tokens, openIndex) {
  // Use a stack for (), {}, and []; reject a wrong closer or end-of-input.
}

function classRanges(tokens) {
  // For each `class` token, accept an optional name and optional `extends`
  // expression, then use the first structural `{` and its matching `}`.
}

function classMethods(tokens, classRange) {
  // Walk only depth-one class members. Recognize identifier method names
  // followed by `(` arguments `)` and a `{` body `}`. Return exact token
  // indexes and ignore fields such as `service=null`.
}

module.exports = {
  CodexMicroPatchDriftError,
  classMethods,
  classRanges,
  findMatchingDelimiter,
  tokenizeJavaScript,
};
```

The implementation must throw `CodexMicroPatchDriftError` for unterminated strings/comments/templates, template nesting it cannot safely skip, and delimiter mismatches. It must never repair or normalize unrelated source bytes.

- [ ] **Step 4: Run the scanner tests and confirm GREEN**

Run:

```bash
node --test linux-features/codex-micro-emulator/patch-structure.test.js
```

Expected: all scanner tests PASS.

- [ ] **Step 5: Commit the scanner unit**

```bash
git add linux-features/codex-micro-emulator/patch-structure.js linux-features/codex-micro-emulator/patch-structure.test.js
git commit -m "feat(codex-micro): add bounded bundle scanner"
```

---

### Task 2: Transform the service export and manager bootstrap structurally

**Files:**

- Modify: `linux-features/codex-micro-emulator/patch-structure.js`
- Modify: `linux-features/codex-micro-emulator/patch-structure.test.js`
- Modify: `linux-features/codex-micro-emulator/test.js`

**Interfaces:**

- Consumes: scanner interfaces from Task 1.
- Produces: `patchServiceSource(source) -> string`.
- Produces: `patchMainSource(source) -> string`.
- Produces: `patchCodexMicroSources({ mainSource, serviceSource }) -> { mainSource, serviceSource, changed }`.
- Produces: `SERVICE_MARKER = "function codexLinuxCodexMicroEmulatorOptions()"` and `BOOTSTRAP_MARKER = "[codex-micro-emulator] automatic bootstrap failed"`.

- [ ] **Step 1: Move the existing latest-DMG RED fixture into focused tests**

Do not restore or discard the current uncommitted change in `test.js`. Move its double-quoted current request and hash into the focused fixture, then remove only the retired exact-string patch tests and helper from `test.js`:

```js
function currentMainSource(overrides = {}) {
  const request = overrides.request ?? '"./codex-micro-service-C0OetNTY.js"';
  const className = overrides.className ?? "eS";
  const parameter = overrides.parameter ?? "e";
  const callbacks = overrides.callbacks ?? [
    "onDeviceStateChanged:e=>this.windowManager.sendMessageToAllWindows({state:e})",
    "onHidEvent:e=>this.windowManager.sendMessageToAllWindows({event:e})",
    "onJoystickEvent:e=>this.windowManager.sendMessageToAllWindows({event:e})",
  ];
  return [
    "const untouchedBefore=42;",
    `class ${className}{service=null;servicePromise=null;constructor(${parameter}){this.windowManager=${parameter}}`,
    "async getState(){let e=await this.getService();return e.start(),e.getState()}",
    `getService(){return Promise.resolve().then(()=>require(${request})).then(({CodexMicroService:e})=>new e({${callbacks.join(",")}}))}`,
    "const untouchedAfter=7;",
  ].join("");
}

function currentServiceSource(identifier = "x") {
  return [
    '"use strict";',
    'const kit=require("@worklouder/device-kit-oai");',
    `class ${identifier}{constructor(options){this.options=options;this.api=new kit.RPCApiOAI(options)}}`,
    `exports.CodexMicroService=${identifier};`,
    "\n//# sourceMappingURL=codex-micro-service.js.map",
  ].join("");
}
```

The current working-tree delta that changed `CR6sUcZG`/backticks to `C0OetNTY`/double quotes is thereby preserved as the default current fixture rather than treated as an obsolete import failure.

- [ ] **Step 2: Write failing transformation and mutation tests**

Add table-driven tests that prove all supported non-semantic variants yield the same markers and preserve surrounding bytes:

```js
test("pure patch wraps the public service export and bootstraps the containing manager", () => {
  const original = {
    mainSource: currentMainSource(),
    serviceSource: currentServiceSource("x"),
  };
  const patched = patchCodexMicroSources(original);
  assert.equal(patched.changed, true);
  assert.match(patched.serviceSource, /extends x/);
  assert.match(patched.serviceSource, /super\(\{\.\.\.e,\.\.\.codexLinuxCodexMicroEmulatorOptions\(\)\}\)/);
  assert.match(patched.serviceSource, /new kit\.RPCApiOAI\(options\)/);
  assert.equal(patched.mainSource.split(BOOTSTRAP_MARKER).length - 1, 1);
  assert.match(patched.mainSource, /void this\.getState\(\)\.catch/);
  assert.equal(patched.mainSource.includes("const untouchedBefore=42;"), true);
  assert.equal(patched.mainSource.includes("const untouchedAfter=7;"), true);
  assert.deepEqual(patchCodexMicroSources(patched), patched);
});

for (const request of [
  "'./codex-micro-service-Q1.js'",
  '"./codex-micro-service-Q2.js"',
  "`./codex-micro-service-Q3.js`",
]) {
  test(`module request spelling ${request} is structural`, () => {
    const patched = patchCodexMicroSources({
      mainSource: currentMainSource({ request }),
      serviceSource: currentServiceSource("z9"),
    });
    assert.match(patched.serviceSource, /extends z9/);
    assert.equal(patched.mainSource.includes(BOOTSTRAP_MARKER), true);
  });
}

test("whitespace identifiers and callback ordering are not anchors", () => {
  const source = currentMainSource({
    className: "a0",
    parameter: "windowManager",
    callbacks: [
      "onJoystickEvent:e=>e",
      "onDeviceStateChanged:e=>e",
      "onHidEvent:e=>e",
    ],
  }).replaceAll(";", "; \n");
  const patched = patchCodexMicroSources({
    mainSource: source,
    serviceSource: currentServiceSource("Service9"),
  });
  assert.equal(patched.mainSource.includes(BOOTSTRAP_MARKER), true);
  assert.match(patched.serviceSource, /extends Service9/);
});
```

Add negative tests for zero/two export assignments, zero/two matching class bodies, duplicate constructors, substituted templates, mismatched delimiters, only one marker present, and syntax-breaking fixture input. Each negative test must assert both returned/retained sources equal the originals and that the thrown drift message is one bounded line without bundle contents.

- [ ] **Step 3: Run focused tests and confirm the new transformation tests fail**

Run:

```bash
node --test linux-features/codex-micro-emulator/patch-structure.test.js
```

Expected: scanner tests PASS; transformation tests FAIL because the three pure patch functions are not exported.

- [ ] **Step 4: Implement the service export wrapper**

Add these constants and functions to `patch-structure.js`:

```js
const SERVICE_MARKER = "function codexLinuxCodexMicroEmulatorOptions()";
const BOOTSTRAP_MARKER = "[codex-micro-emulator] automatic bootstrap failed";

function optionsHelperSource() {
  return "function codexLinuxCodexMicroEmulatorOptions(){let e=require(\"node:path\"),t=process.env.CODEX_LINUX_APP_DIR||e.dirname(process.resourcesPath);return require(e.join(t,\".codex-linux\",\"features\",\"codex-micro-emulator\",\"emulator.cjs\")).createOptions()}";
}

function insertBeforeSourceMap(source, insertion) {
  const match = /(?:\r?\n)?\/\/[#@] sourceMappingURL=[^\r\n]*\s*$/u.exec(source);
  if (match == null) return `${source};${insertion}`;
  return `${source.slice(0, match.index)};${insertion}${source.slice(match.index)}`;
}

function patchServiceSource(source) {
  // Require exactly one token sequence:
  // exports . CodexMicroService = <identifier>
  // Replace only the identifier range with a named subclass expression that
  // extends the captured identifier and calls
  // super({...options,...codexLinuxCodexMicroEmulatorOptions()}). Append the
  // helper before the source-map trailer.
}
```

The compact replacement expression must be equivalent to:

```js
class CodexLinuxCodexMicroService extends OriginalCodexMicroService {
  constructor(options) {
    super({ ...options, ...codexLinuxCodexMicroEmulatorOptions() });
  }
}
```

Do not provide `createApi`; the original superclass must continue constructing the upstream API.

- [ ] **Step 5: Implement structural main bootstrap insertion**

Implement `patchMainSource(source)` with this exact decision chain:

```js
function patchMainSource(source) {
  const tokens = tokenizeJavaScript(source);
  // Find string tokens whose decoded value matches
  // /^\.\/codex-micro-service-[^/]+\.js$/ and reject substituted templates.
  // Require exactly one request token.
  // Require exactly one class range containing that request token.
  // Require exactly one constructor method in that class.
  // Insert immediately before the constructor body's closing brace:
  // ;void this.getState().catch(e=>console.error(
  //   "[codex-micro-emulator] automatic bootstrap failed",e))
}
```

Then implement the all-or-nothing pure API:

```js
function patchCodexMicroSources({ mainSource, serviceSource }) {
  const mainMarked = mainSource.includes(BOOTSTRAP_MARKER);
  const serviceMarked = serviceSource.includes(SERVICE_MARKER);
  if (mainMarked !== serviceMarked) {
    throw new CodexMicroPatchDriftError("partial Codex Micro emulator markers");
  }
  if (mainMarked && serviceMarked) {
    return { mainSource, serviceSource, changed: false };
  }
  return {
    mainSource: patchMainSource(mainSource),
    serviceSource: patchServiceSource(serviceSource),
    changed: true,
  };
}
```

- [ ] **Step 6: Run focused tests and confirm GREEN**

Run:

```bash
node --test linux-features/codex-micro-emulator/patch-structure.test.js
```

Expected: all scanner, transformation, mutation, ambiguity, partial-marker, idempotence, and source-map tests PASS.

- [ ] **Step 7: Verify the original runtime feature tests still pass after removing retired patch tests**

Run:

```bash
node --test linux-features/codex-micro-emulator/test.js
```

Expected: runtime, socket, CLI, trace, resource, and lifecycle tests PASS. Descriptor assertions may still be RED until Task 3 and must identify only the pending descriptor ID/phase change.

- [ ] **Step 8: Commit the pure transformation unit**

```bash
git add linux-features/codex-micro-emulator/patch-structure.js linux-features/codex-micro-emulator/patch-structure.test.js linux-features/codex-micro-emulator/test.js
git commit -m "feat(codex-micro): patch service export structurally"
```

---

### Task 3: Add extracted-app discovery and transactional writes

**Files:**

- Modify: `linux-features/codex-micro-emulator/patch.js`
- Modify: `linux-features/codex-micro-emulator/patch-structure.test.js`
- Modify: `linux-features/codex-micro-emulator/test.js`

**Interfaces:**

- Consumes: `patchCodexMicroSources` and markers from Task 2.
- Produces: `applyCodexMicroEmulatorExtractedApp(extractedDir, options?) -> { matched, changed, reason? }`.
- Test seam: `options.fsImpl`, defaulting to `node:fs`; it must provide `existsSync`, `readdirSync`, `readFileSync`, and `writeFileSync`.
- Descriptor: `codex-micro-emulator-extracted-app`, phase `extracted-app:pre-webview`, order `19_700`.

- [ ] **Step 1: Write failing filesystem transaction tests**

Add a fixture builder that creates `.vite/build/main-hw0RxS4P.js` and `.vite/build/codex-micro-service-C0OetNTY.js`, then invoke the exported filesystem function directly:

```js
function writeExtractedFixture(root, overrides = {}) {
  const buildDir = path.join(root, ".vite", "build");
  fs.mkdirSync(buildDir, { recursive: true });
  const mainPath = path.join(buildDir, overrides.mainName ?? "main-hw0RxS4P.js");
  const servicePath = path.join(
    buildDir,
    overrides.serviceName ?? "codex-micro-service-C0OetNTY.js",
  );
  fs.writeFileSync(mainPath, overrides.mainSource ?? currentMainSource());
  fs.writeFileSync(servicePath, overrides.serviceSource ?? currentServiceSource());
  return { mainPath, servicePath };
}

test("extracted-app patch writes both validated sources", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-patch-"));
  try {
    const paths = writeExtractedFixture(root);
    const result = applyCodexMicroEmulatorExtractedApp(root);
    assert.deepEqual(result, { matched: 2, changed: 2 });
    assert.match(fs.readFileSync(paths.mainPath, "utf8"), new RegExp(BOOTSTRAP_MARKER));
    assert.match(fs.readFileSync(paths.servicePath, "utf8"), new RegExp(SERVICE_MARKER.replace(/[()]/g, "\\$&")));
    assert.deepEqual(applyCodexMicroEmulatorExtractedApp(root), { matched: 2, changed: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

Add tests that snapshot both original byte strings and verify no writes for missing build directory, duplicate filename candidates, a service candidate without `@worklouder/device-kit-oai`, ambiguous export/class/constructor, partial markers, and `vm.Script` syntax failure.

For rollback, pass an `fsImpl` wrapper whose second forward write throws once, then permits restoration writes. Assert both files equal their original strings and the result contains `changed: 0` with a bounded reason. Add a second test where restoration itself throws and assert the function throws an error containing `rollback failed` but not source contents.

- [ ] **Step 2: Run transaction tests and confirm RED**

Run:

```bash
node --test linux-features/codex-micro-emulator/patch-structure.test.js
```

Expected: pure scanner/transform tests PASS; extracted-app tests FAIL because `applyCodexMicroEmulatorExtractedApp` is not exported.

- [ ] **Step 3: Replace the old main-bundle descriptor with a transaction orchestrator**

Rewrite `patch.js` around this shape and delete `SERVICE_IMPORT_PATTERN`, `SERVICE_MANAGER_CONSTRUCTOR`, `CONSTRUCTOR_TAIL`, `applyCodexMicroEmulatorPatch`, and both old helper injectors:

```js
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  CodexMicroPatchDriftError,
  patchCodexMicroSources,
} = require("./patch-structure.js");

const PATCH_SKIP_WARNING =
  "WARN: Codex Micro emulator patch drifted - leaving main and service bundles unchanged";

function applyCodexMicroEmulatorExtractedApp(extractedDir, options = {}) {
  const io = options.fsImpl ?? fs;
  const buildDir = path.join(extractedDir, ".vite", "build");
  // Discover exactly one main-*.js containing the structural service request
  // and exactly one codex-micro-service-*.js containing both the Work Louder
  // request and the public export contract. Read both originals once.
  // Call patchCodexMicroSources, then new vm.Script() for each result.
  // Only after both parse checks pass, write service then main.
  // If either write throws, restore every attempted path from the in-memory
  // originals. Return {matched: 2, changed: 2|0}; on bounded drift or a fully
  // restored write failure, console.warn(PATCH_SKIP_WARNING + ": " + reason)
  // and return {matched: 0, changed: 0, reason}.
}

const descriptors = [{
  id: "codex-micro-emulator-extracted-app",
  phase: "extracted-app:pre-webview",
  order: 19_700,
  apply: applyCodexMicroEmulatorExtractedApp,
}];

module.exports = {
  PATCH_SKIP_WARNING,
  applyCodexMicroEmulatorExtractedApp,
  descriptors,
};
```

Discovery must be filename-bounded to direct children of `.vite/build`; it must not recursively scan unrelated generated assets. Parse with:

```js
new vm.Script(patched.serviceSource, { filename: path.basename(servicePath) });
new vm.Script(patched.mainSource, { filename: path.basename(mainPath) });
```

Rollback must remember each attempted path, restore in reverse order, collect restoration errors, and throw one bounded `Error("Codex Micro emulator rollback failed: ...")` if any restoration fails.

- [ ] **Step 4: Update descriptor assertions in the main feature test**

Change the manifest expectation to:

```js
assert.deepEqual(descriptors.map(({ id, phase }) => [id, phase]), [[
  "feature:codex-micro-emulator:codex-micro-emulator-extracted-app",
  "extracted-app:pre-webview",
]]);
```

Retain the assertions that the feature is disabled until selected and stages only `emulator.cjs` mode `0644` plus the CLI mode `0755`.

- [ ] **Step 5: Run both focused feature suites and confirm GREEN**

Run:

```bash
node --test \
  linux-features/codex-micro-emulator/patch-structure.test.js \
  linux-features/codex-micro-emulator/test.js
```

Expected: all tests PASS, including two-file rollback and updated descriptor phase/ID.

- [ ] **Step 6: Commit the extracted-app transaction**

```bash
git add linux-features/codex-micro-emulator/patch.js linux-features/codex-micro-emulator/patch-structure.test.js linux-features/codex-micro-emulator/test.js
git commit -m "feat(codex-micro): patch extracted app transactionally"
```

---

### Task 4: Update operator documentation and run repository regressions

**Files:**

- Modify: `linux-features/codex-micro-emulator/README.md`

**Interfaces:**

- Consumes: the new descriptor ID, phase, markers, and failure behavior.
- Produces: operator instructions that match generated paths and current candidate reports.

- [ ] **Step 1: Update README architecture and drift wording**

Replace the old exact main-bundle description with these facts:

```markdown
The enabled feature patches two extracted upstream bundles as one transaction.
It wraps the public `exports.CodexMicroService` class with an emulator-aware
subclass, preserving the original service/API/RPC implementation, and inserts
one `getState()` bootstrap into the structurally identified service-manager
constructor. Quote style, chunk hashes, minified local names, whitespace, and
callback ordering are not anchors.

If either public export or manager lifecycle is missing, duplicated,
ambiguous, partially marked, or syntactically invalid, neither file is changed.
Because this is an enabled optional feature, that drift rejects candidate
promotion.
```

Update the patch-report lookup from `feature:codex-micro-emulator:codex-micro-emulator-main` to `feature:codex-micro-emulator:codex-micro-emulator-extracted-app`. Keep the existing isolated runtime instructions and exact-PID cleanup safeguards.

- [ ] **Step 2: Run focused and framework regressions**

Run in the login shell so the fnm-managed Node is available:

```bash
bash -lc 'node --test linux-features/codex-micro-emulator/patch-structure.test.js'
bash -lc 'node --test linux-features/codex-micro-emulator/test.js'
bash -lc 'node --test linux-features/*/test.js'
bash -lc 'node --test scripts/patch-linux-window-ui.test.js'
git diff --check
```

Expected: every Node suite PASS and `git diff --check` exits 0 with no output.

- [ ] **Step 3: Prove old fragile anchors are gone**

Run:

```bash
rg -n 'SERVICE_MANAGER_CONSTRUCTOR|CONSTRUCTOR_TAIL|SERVICE_IMPORT_PATTERN|codex-micro-service-CR6sUcZG' \
  linux-features/codex-micro-emulator
```

Expected: no matches. The current `C0OetNTY` hash may appear only in current test fixtures or captured verification docs, never in production patch logic.

- [ ] **Step 4: Commit documentation and any regression-only correction**

```bash
git add linux-features/codex-micro-emulator/README.md linux-features/codex-micro-emulator
git commit -m "docs(codex-micro): explain resilient extracted patch"
```

Before committing, verify `git diff --cached --name-only` contains only the feature files named in this plan.

---

### Task 5: Validate the exact latest DMG and isolated runtime

**Files:**

- Verify only: `/tmp/Codex-ChatGPT-latest.dmg`
- Generated evidence: a new `/tmp/codex-micro-resilient-uat.*` directory
- Do not commit generated candidates, reports, state, sockets, logs, or feature config.

**Interfaces:**

- Consumes: clean committed feature head and latest pinned DMG.
- Produces: accepted candidate report plus runtime command/trace evidence.

- [ ] **Step 1: Invoke verification-before-completion and capture a clean source head**

At execution time, read and follow `superpowers:verification-before-completion`. Then run:

```bash
git status --short
git rev-parse HEAD
sha256sum /tmp/Codex-ChatGPT-latest.dmg
```

Expected: clean worktree; a full commit SHA; DMG SHA `ff459150991612007549270d2d28c5e78cec6bd6ac200a7ada5ed6c031369b87` unless the repository's latest pinned upstream has intentionally changed. If the pin changed, inspect the newly pinned DMG and restart current-shape fixture/acceptance work rather than treating the old hash as compatible.

- [ ] **Step 2: Build a fresh enabled candidate**

```bash
codex_micro_uat=$(mktemp -d /tmp/codex-micro-resilient-uat.XXXXXX)
mkdir -p "$codex_micro_uat/codex-home"
node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({enabled:["codex-micro-emulator"]}, null, 2)+"\n")' \
  "$codex_micro_uat/enabled-features.json"
CODEX_HOME="$codex_micro_uat/codex-home" \
CODEX_LINUX_FEATURES_CONFIG="$codex_micro_uat/enabled-features.json" \
CODEX_NEXT_APP_DIR="$codex_micro_uat/codex-app-enabled" \
REBUILD_REPORT_DIR="$codex_micro_uat/enabled-report" \
./scripts/rebuild-candidate.sh /tmp/Codex-ChatGPT-latest.dmg
```

Expected: command exits 0 and the candidate verdict is `accepted` or `accepted_with_warnings`.

- [ ] **Step 3: Assert descriptor status, source head, and resource modes**

```bash
node - "$codex_micro_uat/enabled-report/patch-report.json" "$codex_micro_uat/enabled-report/upstream-dmg-decision.json" "$(git rev-parse HEAD)" <<'NODE'
const fs = require("node:fs");
const [reportPath, decisionPath, head] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const decision = JSON.parse(fs.readFileSync(decisionPath, "utf8"));
const patch = report.patches.find((entry) =>
  entry.name === "feature:codex-micro-emulator:codex-micro-emulator-extracted-app"
);
if (patch?.status !== "applied") throw new Error(JSON.stringify(patch ?? "missing patch"));
if (!["accepted", "accepted_with_warnings"].includes(decision.verdict)) {
  throw new Error(`unexpected verdict ${decision.verdict}`);
}
if (decision.source?.dirty !== false) {
  throw new Error(`acceptance source is dirty: ${decision.source?.dirty}`);
}
if (decision.source?.commit !== head) {
  throw new Error(`acceptance head ${decision.source?.commit} != ${head}`);
}
NODE
stat -c '%a %n' \
  "$codex_micro_uat/codex-app-enabled/.codex-linux/features/codex-micro-emulator/emulator.cjs" \
  "$codex_micro_uat/codex-app-enabled/resources/native/codex-micro-emulator"
```

Expected modes: `644` and `755`; `source.commit` equals the clean feature head and `source.dirty` is `false`.

- [ ] **Step 4: Launch with fully isolated Codex and XDG roots**

Follow the validated launcher/PID procedure already documented in `linux-features/codex-micro-emulator/README.md`. Create dedicated `runtime`, `state`, `config`, `cache`, and `runtime-codex-home` directories beneath `$codex_micro_uat`, link only the host Wayland socket into the isolated runtime directory, and start:

```bash
CODEX_HOME="$codex_micro_uat/runtime-codex-home" \
XDG_RUNTIME_DIR="$codex_micro_uat/runtime" \
XDG_STATE_HOME="$codex_micro_uat/state" \
XDG_CONFIG_HOME="$codex_micro_uat/config" \
XDG_CACHE_HOME="$codex_micro_uat/cache" \
WAYLAND_DISPLAY="$WAYLAND_DISPLAY" \
  "$codex_micro_uat/codex-app-enabled/start.sh" --new-instance \
  >"$codex_micro_uat/app.log" 2>&1 &
codex_micro_launcher_pid=$!
```

Expected UI: the isolated profile may show only the ChatGPT login screen. That is a valid runtime result; emulator verification is performed through the private socket and trace, without signing in.

- [ ] **Step 5: Verify automatic connection and every typed command**

Using the same environment roots, save the CLI path and run:

```bash
codex_micro_cli="$codex_micro_uat/codex-app-enabled/resources/native/codex-micro-emulator"
"$codex_micro_cli" status
"$codex_micro_cli" watch --raw >"$codex_micro_uat/watch.jsonl" 2>"$codex_micro_uat/watch.err" &
codex_micro_watch_pid=$!
"$codex_micro_cli" key AG00 tap
"$codex_micro_cli" encoder cw --steps 2
"$codex_micro_cli" joystick left
"$codex_micro_cli" disconnect
"$codex_micro_cli" connect
"$codex_micro_cli" status
```

Expected: initial automatic state is connected; typed commands succeed; disconnect/reconnect changes state; `watch.jsonl` contains ordered `session`, `connection`, `rpc.request`, `hid.frame`, `rpc.response`, and `notify.rx` records with increasing sequence values.

- [ ] **Step 6: Verify private modes and ordinary Codex isolation**

Capture `/home/abe/.codex` metadata before launch and compare it after UAT. Check:

```bash
stat -c '%a %n' \
  "$codex_micro_uat/runtime/codex-desktop/codex-micro-emulator.sock" \
  "$codex_micro_uat/state/codex-desktop/codex-micro-emulator/events.jsonl"
find "$codex_micro_uat/runtime-codex-home" -maxdepth 2 -type f -print | sort
```

Expected: runtime directory/socket access remains private, state files are not group/world writable, all Codex writes are under the isolated tree, and ordinary `/home/abe/.codex` is unchanged by this run.

- [ ] **Step 7: Stop only validated child processes**

Stop the saved watcher PID separately. Resolve the single isolated `app.pid`, validate it is numeric and greater than 1, and require:

```bash
readlink -f "/proc/$codex_micro_electron_pid/exe"
```

to equal:

```text
$codex_micro_uat/codex-app-enabled/electron
```

Only then send `TERM` to that exact Electron PID and wait on the saved launcher PID. If validation fails, signal nothing and inspect the isolated logs.

- [ ] **Step 8: Record fresh evidence in the handoff, not in Git**

Retain the `/tmp/codex-micro-resilient-uat.*` path through merge verification. Record the DMG SHA, source head, verdict, patch status, command summary, trace ordering result, file modes, and validated Electron PID in the final user handoff.

---

### Task 6: Create the durable fork, push, merge, and clean the worktree

**Files:**

- Git metadata and GitHub repository state only.
- No source changes are expected in this task.

**Interfaces:**

- Produces: `origin -> https://github.com/TKPND/codex-desktop-linux.git`.
- Produces: `upstream -> https://github.com/ilysenko/codex-desktop-linux.git`.
- Produces: remote `codex/codex-micro-emulator` and personal `main` containing the verified feature.

- [ ] **Step 1: Invoke finishing-a-development-branch and inspect both worktrees**

At execution time, read and follow `superpowers:finishing-a-development-branch`. Then run:

```bash
git -C /home/abe/src/codex-desktop-linux/.worktrees/codex-micro-emulator status --short
git -C /home/abe/src/codex-desktop-linux status --short
git -C /home/abe/src/codex-desktop-linux remote -v
gh auth status
gh repo view TKPND/codex-desktop-linux --json nameWithOwner,isFork,parent
```

Expected: feature worktree clean, root worktree has no unrelated edits, GitHub account `TKPND` active. If the fork does not yet exist, only the final `gh repo view` command may fail.

- [ ] **Step 2: Create the fork if absent and configure remotes**

If `TKPND/codex-desktop-linux` is absent, run:

```bash
gh repo fork ilysenko/codex-desktop-linux --clone=false --remote=false
```

Then, after verifying no conflicting `upstream` remote exists, run from the root checkout:

```bash
git remote rename origin upstream
git remote add origin https://github.com/TKPND/codex-desktop-linux.git
git remote -v
```

Expected: fetch/push URLs match the two approved mappings exactly. Do not force-push and do not reset either local branch.

- [ ] **Step 3: Push the recoverable feature branch before integration**

```bash
git -C /home/abe/src/codex-desktop-linux/.worktrees/codex-micro-emulator push -u origin codex/codex-micro-emulator
```

Expected: branch exists on `TKPND/codex-desktop-linux` and local tracking is set.

- [ ] **Step 4: Fast-forward personal main to the verified feature**

From `/home/abe/src/codex-desktop-linux`:

```bash
git switch main
git merge --ff-only codex/codex-micro-emulator
```

Expected: fast-forward succeeds. If it does not, stop and inspect ancestry; do not create an unreviewed merge or reset.

- [ ] **Step 5: Re-run focused verification on merged main**

```bash
bash -lc 'node --test linux-features/codex-micro-emulator/patch-structure.test.js'
bash -lc 'node --test linux-features/codex-micro-emulator/test.js'
bash -lc 'node --test linux-features/*/test.js'
bash -lc 'node --test scripts/patch-linux-window-ui.test.js'
git diff --check
git status --short
```

Expected: all tests PASS, diff check clean, and main worktree clean.

- [ ] **Step 6: Push personal main without force**

```bash
git push -u origin main
```

Expected: personal fork `main` advances to the verified feature head through a normal fast-forward push.

- [ ] **Step 7: Verify remote ancestry and preserve upstream review flow**

```bash
git fetch --prune origin
git fetch --prune upstream
git rev-parse main
git rev-parse origin/main
git merge-base --is-ancestor upstream/main main
```

Expected: local `main` equals `origin/main`, and current `upstream/main` is an ancestor of personal `main` for this integration round. Future upstream changes remain manual reviewed fetch/merge work using the existing watchdog; no automation is enabled here.

- [ ] **Step 8: Remove only the merged local worktree and branch**

After Steps 5-7 and latest-DMG evidence remain successful:

```bash
git worktree remove /home/abe/src/codex-desktop-linux/.worktrees/codex-micro-emulator
git branch -d codex/codex-micro-emulator
git worktree list
```

Expected: the feature is recoverable from the remote branch and personal `main`; only the merged local feature worktree/branch are removed. Do not delete the remote feature branch as part of this plan.

---

## Final Completion Checklist

- [ ] Production patch code contains no exact current chunk hash and no long minified constructor/callback anchor.
- [ ] Service export wrapper retains the original superclass and does not inject `createApi`.
- [ ] Bootstrap scanner accepts quote/hash/identifier/whitespace/callback-order mutations and rejects ambiguous structure.
- [ ] Partial markers, syntax errors, and transaction failures do not leave a half-patched pair.
- [ ] Focused feature tests, all Linux feature tests, main patcher tests, and `git diff --check` pass.
- [ ] Exact latest DMG candidate is accepted with the feature descriptor `applied`.
- [ ] Isolated login-screen runtime automatically connects and all seven CLI command groups work.
- [ ] Ordinary `/home/abe/.codex` remains unchanged and cleanup used only validated child PIDs.
- [ ] Feature branch and personal `main` are pushed to `TKPND/codex-desktop-linux`.
- [ ] `origin`/`upstream` mappings are correct, personal `main` is verified, and no automatic merge/promotion was enabled.
- [ ] Air60 V2 work remains a separate follow-up design.
