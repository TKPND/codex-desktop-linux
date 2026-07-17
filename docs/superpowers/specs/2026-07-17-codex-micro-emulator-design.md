# Codex Micro Emulator Design

Date: 2026-07-17
Status: Approved for implementation planning

## Summary

Add an opt-in Linux feature that presents a deterministic virtual Codex Micro
to the upstream Codex Desktop application. The feature keeps the upstream
`CodexMicroService` and `RPCApiOAI` implementations in the active path, replaces
only device discovery and transport, records the exact JSON-RPC requests
produced by Codex, derives the corresponding 64-byte HID reports, and accepts a
small set of simulated device inputs through a user-local Unix socket.

The first deliverable is a protocol investigation tool. It is not an Air60 V2
integration and does not modify keyboard firmware. Once the observed protocol
and useful controls are understood, a later design may map VIA keycodes or QMK
Raw HID messages onto the emulator's validated input interface.

## Goals

- Observe what Codex sends to a connected Codex Micro without possessing the
  physical device.
- Exercise the upstream state-to-lighting and vendor RPC code rather than
  reimplementing it.
- Record both the complete JSON-RPC request and the HID reports that the request
  would occupy on the Work Louder transport.
- Simulate connection lifecycle, key events, encoder events, and joystick
  movement from a command-line client.
- Keep the implementation confined to an optional, disabled-by-default Linux
  feature.
- Detect current-upstream patch drift when the feature is enabled instead of
  silently falling back to an older DMG shape.

## Non-goals

- Pretending to be Work Louder hardware at the Linux kernel or USB descriptor
  level.
- Spoofing Work Louder's USB vendor or product identifiers on the Air60 V2.
- Making the bundled Darwin `node-hid` binary work on Linux.
- Implementing firmware flashing, serial bootloader support, Work Louder Input,
  or a general-purpose HID emulator.
- Adding an in-app debug panel.
- Shipping the feature enabled by default or adding it to
  `linux-features/features.example.json`.
- Installing a new command into `/usr/bin` or another system-wide path.

## Source Findings and Constraints

Inspection of the current upstream DMG found the following relevant behavior:

- The Electron main process dynamically loads `CodexMicroService`.
- `CodexMicroService` accepts injected `discovery`, `createComm`, and
  `createApi` dependencies.
- Keeping `createApi` at its upstream default causes the real `RPCApiOAI` and
  `WLRPCClient` implementations to run on top of the injected communication
  object.
- `node-hid` loads its native binding lazily. Supplying fake discovery and
  communication objects avoids native binding loading while preserving the
  rest of the upstream Work Louder package.
- Device discovery requests `DeviceType.Project2077`.
- Outbound vendor methods currently include:
  - `v.oai.rgbcfg` for key and ambient lighting.
  - `v.oai.thstatus` for six per-task lighting slots.
  - `device.status` for firmware, profile, layer, battery, and charging state.
- Inbound notification methods include:
  - `v.oai.hid` with compact key parameters.
  - `v.oai.rad` with normalized joystick angle and distance.
- HID transport frames use report ID `0x06`, channel `0x02`, a one-byte payload
  length, and at most 61 payload bytes in each 64-byte report.

The Linux feature framework requires repository features to be disabled by
default, include both `feature.json` and `README.md`, use patch descriptors for
ASAR changes, and prefer declarative resources over custom staging hooks.

## Approaches Considered

### 1. Inject fake discovery and communication dependencies

This is the selected approach. It preserves the real Codex service, lighting
model transformation, RPC minimization, request identifiers, and request
ordering. The fake communication boundary receives the final serialized JSON
request, making it the narrowest stable seam that still answers what Codex
would send.

### 2. Replace `node-hid` with a fake native backend

This would also exercise the upstream transport's framing function, but it
would couple the feature to private `node-hid` wrapper and native binding
interfaces. It adds failure modes unrelated to the protocol question and is
not justified for the first version.

### 3. Trace renderer lighting models only

This would be easy to add but would observe data before the upstream service
converts statuses into colors and vendor RPC parameters. It cannot show the
final JSON-RPC or HID representation, so it does not meet the main goal.

## Architecture

```text
Codex renderer
    |
    | updateLighting(model)
    v
Upstream CodexMicroService
    |
    | upstream state-to-color/effect conversion
    v
Upstream RPCApiOAI and WLRPCClient
    |
    | serialized JSON-RPC request
    v
Fake WLDeviceComm
    |-- append JSONL records
    |-- derive simulated HID reports
    |-- return deterministic RPC responses
    `-- dispatch validated socket notifications to upstream handlers
```

Only the Electron main-process construction of `CodexMicroService` is patched.
The patch adds options returned by the staged emulator module to the existing
callback object. It does not patch webview assets or the upstream
`codex-micro-service` chunk.

Conceptually, the resulting construction is:

```js
new CodexMicroService({
  onDeviceStateChanged,
  onHidEvent,
  onJoystickEvent,
  ...emulator.createOptions(),
});
```

`createOptions()` returns a fake discovery instance and a `createComm` factory.
It intentionally does not return `createApi`, allowing the upstream default to
construct the real `RPCApiOAI` over the fake communication object.

## Components

### Feature descriptor

`linux-features/codex-micro-emulator/feature.json` declares:

- id `codex-micro-emulator`;
- `defaultEnabled: false`;
- a `patchDescriptors` entrypoint;
- declarative resources for the CommonJS emulator module and CLI;
- quoted file modes, including `"0755"` for the CLI.

The runtime module is staged at
`.codex-linux/features/codex-micro-emulator/emulator.cjs` with mode `"0644"`.
The CLI is staged at `resources/native/codex-micro-emulator` with mode
`"0755"`. No stage hook or package hook is needed.

### Main-bundle patch

`patch.js` targets the current main bundle using semantic anchors around:

- the dynamic `codex-micro-service` import;
- the `CodexMicroService` constructor;
- the three existing renderer event names.

It injects one staged module load and spreads `createOptions()` into the
constructor options. The patch must be idempotent. If an enabled build cannot
find exactly one current constructor site, the descriptor reports feature
drift so candidate acceptance rejects that build.

The feature does not retain alternate needles for old upstream versions.

### Emulator runtime

`emulator.cjs` provides:

- fake Work Louder discovery returning one `project_2077` device;
- a communication object implementing the subset of `WLDeviceComm` exercised
  by the upstream Codex service;
- deterministic request responses;
- JSONL writing and rotation;
- exact byte-oriented HID framing derivation;
- a Unix-domain control server;
- notification handler registration and removal;
- connection and cleanup state.

The communication object implements connection event subscription,
`connect()`, `disconnect()`, `isConnected()`, notification handler management,
`sendJsonRpcRequest()`, queue cleanup, and request abort behavior. Unsupported
legacy or out-of-scope calls return an explicit error rather than fabricating a
success.

### CLI

`bin/codex-micro-emulator` is a small Python 3 client using only the standard
library. It can run directly from the repository and is also staged as
`resources/native/codex-micro-emulator` in generated applications.

It talks only to the emulator's Unix socket. It does not inspect Electron
memory, edit log files, or send arbitrary JSON.

## Runtime Paths

The emulator uses launcher-provided paths where available.

- State directory:
  `$CODEX_LINUX_APP_STATE_DIR/codex-micro-emulator/`
- Fallback state directory:
  `${XDG_STATE_HOME:-$HOME/.local/state}/codex-desktop/codex-micro-emulator/`
- JSONL log:
  `<state-directory>/events.jsonl`
- Control socket:
  `${XDG_RUNTIME_DIR}/codex-desktop/codex-micro-emulator.sock`

If `XDG_RUNTIME_DIR` is unavailable, the control server fails explicitly. It
does not place a control socket in `/tmp` or a shared directory.

The state directory and socket parent use mode `0700`. The log and socket use
mode `0600`.

## Connection Lifecycle

1. The Codex webview requests Codex Micro state.
2. The main process loads the upstream service.
3. The feature-supplied discovery object returns one virtual Project2077
   descriptor.
4. The fake communication object's `connect()` marks itself connected and
   emits the upstream `CONNECTED` event.
5. The real upstream API sends initial lighting and `device.status` requests.
6. The fake communication object logs each request and returns a deterministic
   response.
7. The service reports `connected` to the renderer, enabling the existing
   Codex Micro bridge and settings behavior.
8. CLI input is dispatched only while the virtual communication object is
   connected.
9. `disconnect` emits the upstream disconnect event. `connect` makes the
   device discoverable again and allows the service's normal retry path to
   reconnect.

The control server starts with the staged emulator module, not on the first CLI
connection. It closes on process shutdown. On startup, a pre-existing socket is
probed; a live socket is never removed, while an unreachable stale socket owned
by the current user may be removed before binding.

## Deterministic RPC Responses

The fake communication object parses the serialized request only to identify
the method and construct a matching response. It preserves the request's ID
type in the response.

`device.status` returns:

```json
{
  "result": {
    "version": "codex-micro-emulator-1",
    "profile_index": 0,
    "layer_index": 0,
    "battery": 100,
    "is_charging": false
  }
}
```

`sys.version` returns the same emulator version under `result.version`.
Lighting methods return an empty result object. Unknown methods return a JSON
RPC-style error and are recorded as unsupported.

Response IDs are added at runtime from the corresponding request.

## JSONL Trace Format

Each record contains these common fields:

| Field | Meaning |
|---|---|
| `schema` | Trace schema version, initially `1`. |
| `ts` | UTC timestamp in ISO 8601 format. |
| `session` | Random identifier for one Electron process run. |
| `seq` | Monotonically increasing sequence number within the session. |
| `type` | Event type. |

Event types are:

- `session`: process, Electron, app, and emulator version information when
  available;
- `connection`: discovering, connected, disconnected, and error transitions;
- `rpc.request`: raw serialized JSON plus parsed `id`, `method`, and `params`;
- `hid.frame`: a simulated outbound 64-byte report correlated with an RPC;
- `rpc.response`: the deterministic response or error returned to upstream;
- `notify.rx`: a validated CLI-originated notification delivered to Codex.

Example request and frame records:

```json
{"schema":1,"ts":"2026-07-17T00:00:00.000Z","session":"...","seq":12,"type":"rpc.request","id":317,"method":"v.oai.rgbcfg","params":{},"raw":"..."}
{"schema":1,"ts":"2026-07-17T00:00:00.001Z","session":"...","seq":13,"type":"hid.frame","rpcId":317,"simulated":true,"packet":1,"packetCount":2,"reportId":6,"channel":2,"payloadLength":61,"reportHex":"..."}
```

`hid.frame` is explicitly marked `simulated` because no kernel HID write takes
place. Framing uses `Buffer.from(rawJson)` and slices bytes, not JavaScript
characters, into chunks of at most 61 bytes. Each report is zero-filled to 64
bytes and stores report ID, channel, and payload length in bytes 0 through 2.

The active log rotates at 5 MiB and retains two numbered previous files, for
three generations in total. Rotation occurs before appending a record that
would exceed the limit. A trace write or rotation failure changes the virtual
device to an error state; the feature never continues as a supposedly
observable connected device after logging has failed.

## Control Socket Protocol

The socket uses newline-delimited JSON internally. The CLI exposes only typed
commands and validates arguments before sending. The server independently
validates every received command.

Supported user-facing commands are:

```text
codex-micro-emulator status
codex-micro-emulator watch [--raw]
codex-micro-emulator key <key> <press|release|tap>
codex-micro-emulator encoder <cw|ccw> [--steps N]
codex-micro-emulator joystick <up|right|down|left|center>
codex-micro-emulator connect
codex-micro-emulator disconnect
```

`watch` subscribes to new trace records over the socket. Without `--raw` it
prints a concise human-readable view; with `--raw` it prints the JSONL records
unchanged.

### Key validation and actions

Allowed command and slot keys are:

- `AG00` through `AG05`;
- `ACT06` through `ACT12`;
- synthetic canonical encoder switch key `ENC_SW`.

Actions map to the upstream numeric values:

- `release` -> `act: 0`;
- `press` -> `act: 1`;
- encoder rotation -> `act: 2` with `ENC_CW` or `ENC_CC`.

`tap` emits press followed by release after a bounded 50 ms delay. It is valid
for slot, action, and encoder switch keys. Encoder rotation steps are bounded
to the range 1 through 100.

Joystick direction commands produce the normalized angle and distance values
expected by the current bridge. `center` emits distance zero. Cardinal
directions emit distance one. The mapping is centralized in one table and
covered by tests so upstream direction changes require an intentional update.

Input is rejected while disconnected. Unknown keys, unknown commands,
out-of-range steps, malformed messages, and oversized socket lines return a
structured error and are not delivered to upstream handlers.

## Security and Privacy

- The feature is disabled by default and must be selected explicitly in the
  git-ignored feature configuration.
- The control surface is a user-owned Unix socket, not a TCP listener.
- Peer access is restricted by directory and socket permissions.
- The socket protocol cannot invoke arbitrary commands, evaluate code, select
  filesystem paths, or inject arbitrary notification methods.
- The emulator records raw Codex Micro RPC JSON. Current observed methods carry
  lighting and device-status data rather than prompts or attached file
  contents, but the trace is still treated as private debug data.
- The feature does not change USB identifiers or claim to be physical Work
  Louder hardware outside the Codex process.

## Error Handling

- Failure to create the private state directory, trace, or socket is reported
  as an emulator error.
- Trace failure disconnects the virtual device and prevents further writes.
- Socket failure does not corrupt an already-written trace, but the device is
  not advertised as usable because input and lifecycle control would be
  incomplete.
- A malformed RPC request is recorded and answered with an error.
- An unsupported RPC method is recorded and answered with an error.
- Disconnect clears pending subscriptions and causes subsequent CLI input to
  fail until reconnect succeeds.
- Cleanup is idempotent and may run after partial initialization.

## Testing Strategy

### Patch tests

- Apply the descriptor to a current-shape main-bundle fixture.
- Assert that exactly one emulator module load and options spread are added.
- Reapply the descriptor and assert byte-for-byte idempotence.
- Remove or duplicate the constructor anchor and assert a drift result.
- Confirm unrelated main-bundle content remains unchanged.

### Runtime unit tests

- Discovery returns one Project2077 device only while discoverable.
- Connection events follow connect, disconnect, and reconnect transitions.
- Notification handler registration and removal match the upstream interface.
- `device.status`, `sys.version`, lighting, unknown, and malformed requests
  produce the specified responses.
- Request IDs preserve their original JSON type.
- RPC request, response, connection, and notification records have monotonically
  increasing sequence numbers.
- ASCII and multibyte JSON payloads produce the expected 61-byte HID frame
  boundaries and zero padding.
- Log files and socket paths receive the required permissions.
- Rotation retains exactly three generations in total: the active file and two
  previous files.
- Stale socket recovery does not remove a live socket.
- Logging failure moves the emulator to an error state.

### CLI and socket tests

- `status` reports the current lifecycle state.
- `watch` receives new trace records.
- Key press, release, and tap produce the expected numeric actions.
- Encoder direction and bounded step counts produce exact notifications.
- Cardinal and centered joystick commands produce exact normalized values.
- Invalid, oversized, or disconnected input is rejected without notification
  dispatch.

### Feature and generated-app validation

- Validate the feature manifest through the repository feature loader.
- Run `node --test linux-features/codex-micro-emulator/test.js`.
- Run the relevant patcher regression suite.
- Build a generated app with only `codex-micro-emulator` newly enabled.
- Start the generated app, run `status` and `watch`, exercise connection and
  input commands, and confirm initial `v.oai.rgbcfg`, `v.oai.thstatus`, and
  `device.status` records appear.
- Confirm a build with the feature disabled contains no injected emulator load
  and retains normal not-detected behavior.

No physical device is required for automated or manual acceptance of this
feature.

## Upstream Drift Policy

This repository supports only the latest upstream DMG. The feature therefore
uses one current semantic patch shape and no version-specific compatibility
branches. When the upstream service construction changes:

1. Inspect the new DMG and confirm whether the dependency injection seam still
   exists.
2. Update the feature's patch and current fixture.
3. Revalidate that the real upstream `CodexMicroService` and `RPCApiOAI` remain
   in the path.
4. Remove the obsolete patch shape in the same change.

Because the feature is opt-in, ordinary builds remain unaffected. When the
feature is enabled, patch drift rejects the candidate instead of promoting a
build with a partially active emulator.

## Future Air60 V2 Extension

After the trace establishes the useful Codex Micro inputs and lighting
behavior, a separate design may add one of these layers:

1. VIA-only mappings that emit uncommon keyboard usages or shortcuts and are
   translated into the validated emulator commands.
2. Custom QMK firmware using Raw HID for bidirectional host communication and
   Air60 V2 RGB Matrix feedback.

That later work should consume the emulator's typed command model rather than
spoofing Work Louder VID/PID values or bypassing the observed Codex behavior.
