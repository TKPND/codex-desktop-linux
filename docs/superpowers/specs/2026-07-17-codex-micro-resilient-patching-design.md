# Codex Micro Resilient Patching Design

Date: 2026-07-17
Status: Approved for implementation planning

## Summary

Replace the optional Codex Micro emulator's exact minified-string patch with a
structure-aware, all-or-nothing extracted-app patch. The new patch wraps the
upstream `CodexMicroService` public CommonJS export to inject the emulator
transport and performs only the automatic-bootstrap change in the main bundle.

The patch must tolerate non-semantic upstream output changes such as chunk
hashes, JavaScript quote style, whitespace, minified local identifiers, and
callback ordering. It must still fail closed when the upstream service contract
or service-manager lifecycle changes. An enabled feature drift continues to
reject candidate promotion, so a partial or unverified build cannot replace the
working application.

This is stage one of a two-stage effort. Stage two will be a separate Air60 V2
host-bridge design after the desktop emulator is stable.

## Background

The initial feature patched one long constructor tail and one exact
service-manager constructor string in the minified Electron main bundle. The
upstream DMG update from 26.707.91948 to 26.715.21425 changed only the quote
style and chunk hash of the dynamic `codex-micro-service` import, but that was
enough for the enabled feature to reject the candidate.

The rejection was correct fail-closed behavior, but the match boundary was too
syntactic. Tracking each quote or minifier change would create recurring manual
repairs without increasing confidence in the actual integration contract.

Inspection of the current DMG also found these shipped packages:

- `@worklouder/device-kit-oai@0.1.10`;
- `@worklouder/wl-device-kit@0.1.18`.

The OAI package exposes `RPCApiOAI`, `WLDeviceDiscovery`, `WLDeviceCommImpl`, and
`WLRPCClient`, but it is marked `UNLICENSED` and documented as a private GitHub
Package. This feature may use the copy already distributed inside the upstream
application. It must not copy, vendor, republish, or present the package as a
public SDK.

## Goals

- Preserve the upstream `CodexMicroService`, `RPCApiOAI`, and `WLRPCClient` in
  the runtime path.
- Inject only the emulator `discovery` and `createComm` options.
- Keep automatic startup independent of the renderer gate while using the
  upstream service manager's own `getState()` path.
- Tolerate non-semantic changes in generated JavaScript.
- Reject missing, duplicate, ambiguous, or structurally changed contracts
  without modifying either target file.
- Validate the exact latest upstream DMG before merging or promoting a build.
- Keep the feature optional and disabled by default.

## Non-goals

- Supporting old DMG shapes or adding version-specific fallback branches.
- Building or redistributing a standalone Work Louder SDK.
- Replacing the upstream lighting, RPC, or service lifecycle implementation.
- Bypassing the renderer's Codex Micro availability gate or making hidden UI
  visible.
- Introducing a general JavaScript AST dependency into the repository.
- Implementing the Air60 V2 host bridge or flashing keyboard firmware in this
  stage.
- Automatically merging upstream repository changes or automatically promoting
  a newly built application.

## Approaches Considered

### 1. Wrap the service export and structurally scan bootstrap

This is the selected approach. The dedicated service chunk has a narrow public
CommonJS contract: `exports.CodexMicroService`. Wrapping that export avoids
matching the service's minified constructor internals. The main bundle still
needs a patch for automatic startup, but that patch only has to identify the
service-manager class and its constructor.

### 2. Structurally scan everything in the main bundle

This would follow the service import, named export binding, constructor call,
and options object in one file. It avoids a second target file but depends on
more minifier-generated control flow and callback structure than approach 1.

### 3. Intercept modules through `NODE_OPTIONS=--require`

A loader hook might replace Work Louder exports without rewriting ASAR files.
It does not provide a clean reference to the app's service manager for automatic
startup, and it adds Electron startup-policy dependence. It is not selected.

## Architecture

The feature will expose one `extracted-app:pre-webview` descriptor instead of a
`main-bundle` descriptor. That descriptor locates, reads, validates, patches,
and writes both target files as one logical operation.

```text
extracted app
  |
  |-- locate current main-*.js
  |     `-- structurally identify the class that loads codex-micro-service
  |           `-- inject one fire-and-forget getState() bootstrap
  |
  `-- locate codex-micro-service-*.js
        `-- wrap exports.CodexMicroService with an emulator-aware subclass

runtime
  service manager -> wrapped CodexMicroService -> original CodexMicroService
                                             -> original RPCApiOAI/WLRPCClient
                                             -> fake discovery/communication
```

The descriptor computes and syntax-checks both patched sources before writing
either file. If either contract is not uniquely identified, it returns a drift
warning and leaves both originals byte-for-byte unchanged.

## Target Discovery

### Service chunk

Candidate files must:

- be directly under `.vite/build/`;
- have a basename matching `codex-micro-service-*.js`;
- contain the package request `@worklouder/device-kit-oai`;
- contain exactly one assignment to the public property
  `exports.CodexMicroService`;
- assign that property from exactly one local identifier before patching;
- not already contain the emulator wrapper marker.

Exactly one candidate must satisfy the current contract. The chunk hash is not
part of the contract.

### Main bundle

Main-bundle candidates must be directly under `.vite/build/`, have a basename
matching `main-*.js`, and contain a loader for a relative
`codex-micro-service-*.js` module. Exactly one candidate and exactly one
containing class body must match. No hashed filename is hard-coded.

The loader scanner accepts single-quoted, double-quoted, or no-substitution
template-literal string tokens without treating one form as an old-version
fallback. It compares the decoded literal value and not the original spelling.
A module request containing a template substitution is unsupported drift.

## Structure Scanner

The patch will use a small purpose-built lexical scanner, not a regular
expression over whole minified methods and not a third-party AST parser. The
scanner must:

- skip line comments and block comments;
- tokenize quoted strings and no-substitution template literals while tracking
  their exact source ranges;
- reject template substitutions in the module request used for target
  discovery;
- identify JavaScript identifier and punctuation tokens with source offsets;
- match balanced parentheses, braces, and brackets;
- enumerate class bodies and top-level class methods;
- locate exactly one service-manager class by the semantic module request;
- locate exactly one constructor in that class;
- return insertion and replacement ranges without rewriting unrelated bytes.

The scanner does not attempt to parse all JavaScript grammar. Unsupported or
ambiguous syntax is a drift result, not a reason to guess.

## Service Export Wrapper

The service chunk's original class remains authoritative. The scanner captures
the single local identifier on the original export assignment's right-hand
side and replaces only that right-hand side. Conceptually, the result has this
shape:

```js
const OriginalCodexMicroService = /* current exported class */;
exports.CodexMicroService = class CodexLinuxCodexMicroService
  extends OriginalCodexMicroService {
  constructor(options) {
    super({
      ...options,
      ...codexLinuxCodexMicroEmulatorOptions(),
    });
  }
};
```

The actual injected source is compact because it is appended to a generated
bundle. `codexLinuxCodexMicroEmulatorOptions()` resolves the already staged
`.codex-linux/features/codex-micro-emulator/emulator.cjs` module and calls
`createOptions()`.

Spread order is intentional: the emulator's `discovery` and `createComm`
replace upstream defaults. The emulator does not provide `createApi`, so the
original service still constructs the original `RPCApiOAI`.

The wrapper is inserted before any source-map trailer. Reapplying the patch to
a fully patched pair is byte-for-byte idempotent.

## Automatic Bootstrap

The main-bundle scanner injects one contained call into the identified
service-manager constructor:

```js
void this.getState().catch((error) =>
  console.error("[codex-micro-emulator] automatic bootstrap failed", error),
);
```

This calls the existing manager path once, allowing its `servicePromise` and
`service` caches to prevent duplicate service instances. It does not patch the
renderer bridge, availability gate, or UI.

The injected log prefix is also the bootstrap idempotence marker. A source with
only one of the two feature markers is treated as inconsistent drift and is not
modified further.

## Transaction And Failure Handling

The extracted-app descriptor follows this order:

1. Discover exactly one service chunk and one main bundle.
2. Read both original sources.
3. Reject inconsistent or partial markers.
4. Compute the wrapper and bootstrap changes in memory.
5. Parse-check both patched CommonJS sources with Node's `vm.Script`.
6. Write both files only after every check succeeds.
7. If a write throws, restore any file already written from its in-memory
   original and report the failure.

A process crash can still interrupt filesystem writes, but builds occur in a
disposable candidate directory. Candidate acceptance remains the promotion
boundary and will not promote an incomplete candidate.

Drift conditions include:

- no matching target;
- more than one matching target;
- missing or duplicate public export assignment;
- no unique containing manager class or constructor;
- mismatched or unbalanced delimiters;
- partial feature markers;
- syntax-check failure;
- write or rollback failure.

Every drift path emits one bounded warning without embedding the full upstream
bundle in logs.

## Testing

### Focused contract tests

Tests will begin with failing current-shape fixtures and then cover:

- current service export wrapping;
- current manager bootstrap injection;
- byte-for-byte idempotence;
- all-or-nothing behavior across both files;
- preserved original service and API path;
- single, double, and template quote spellings;
- changed service chunk hashes;
- changed minified local identifiers;
- whitespace and callback-order mutations that preserve the semantic contract;
- missing, duplicate, malformed, and partially patched contracts;
- syntax-check and write-failure rollback;
- source-map trailer placement.

Mutation fixtures model non-semantic variants of the current contract. They are
not fixtures for older upstream architectures.

### Repository regression tests

Run the complete feature suite, the Linux feature framework suite, the main
patcher suite, and `git diff --check`.

### Latest-DMG acceptance

Build a fresh enabled candidate from the exact current upstream DMG. Require:

- verdict `accepted` or `accepted_with_warnings`;
- the Codex Micro feature descriptor status `applied`;
- staged resource modes `0644` and `0755`;
- a clean source commit recorded in acceptance evidence.

### Runtime UAT

Launch the candidate with dedicated `CODEX_HOME`, `XDG_RUNTIME_DIR`,
`XDG_STATE_HOME`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME`. The login screen is
an expected result in the isolated profile. Without signing in, verify:

- automatic virtual-device connection;
- status, watch, key, encoder, joystick, disconnect, and reconnect commands;
- RPC and simulated HID trace ordering;
- private socket and state-file modes;
- no writes under the user's ordinary `~/.codex`;
- cleanup by exact validated Electron PID only.

## Fork And Upstream Operations

Create `TKPND/codex-desktop-linux` as the durable personal fork. Configure:

```text
origin   -> TKPND/codex-desktop-linux
upstream -> ilysenko/codex-desktop-linux
```

Keep the current personal `main` as the integration branch; do not reset it to
the upstream branch. Push the Codex Micro feature branch before local merge so
the work is recoverable independently.

Upstream updates are fetched and merged only through a reviewed local round.
Reuse the repository's existing upstream DMG watchdog and immutable enabled
feature snapshot. Do not enable automatic upstream merges or automatic
candidate promotion. An accepted latest-DMG build is required before the
personal integration branch is treated as usable.

## Stage Two Boundary: Air60 V2

The Air60 V2 host bridge will receive a separate design after this stage. The
known starting constraints are:

- the keyboard officially uses QMK/VIA and exposes an RGB matrix;
- the official NuPhy QMK fork contains the Air60 V2 target and VIA keymap;
- the stock VIA build does not define a Codex-specific per-key status protocol;
- normal key events and a dedicated VIA layer can provide a no-flash input
  path;
- stock global RGB control should be tested before any firmware change;
- per-key Agent Keys behavior may require a small Raw HID extension in a
  separately maintained NuPhy firmware branch.

The Air60 bridge must not depend on copying the private Work Louder package. It
may consume the emulator's typed control interface or public Codex hook/session
signals, depending on the later design and real-device capability tests.

## Acceptance Criteria

This stage is complete when:

- no exact long minified constructor or import string remains in the feature
  patch;
- the patch uses the public service export and a structure-aware bootstrap
  scanner;
- all focused mutation, rollback, and regression tests pass;
- the exact latest DMG produces an accepted enabled candidate;
- isolated runtime UAT passes without logging in or changing ordinary Codex
  state;
- the work is committed and pushed to the personal fork;
- the personal integration branch contains the verified result.
