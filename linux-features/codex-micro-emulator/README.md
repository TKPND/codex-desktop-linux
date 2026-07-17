# Codex Micro Emulator

## Purpose

This optional Linux feature provides an in-process Codex Micro transport emulator for protocol investigation without physical Codex Micro hardware. It presents the current desktop app with a deterministic `project_2077` device, records the app's Codex Micro RPC traffic, emits simulated HID frames, and accepts a small typed input surface over a private Unix socket.

The feature is disabled by default. It is a development and testing tool, not a hardware compatibility layer or production device driver.

## Non-goals

The emulator does not:

- emulate USB or HID devices in the kernel;
- spoof Work Louder USB vendor or product IDs;
- modify Air60 V2 firmware; or
- expose arbitrary RPC, JSON, paths, code, or shell commands through its control socket.

## Enable and rebuild

Add `codex-micro-emulator` to the `enabled` array in the gitignored local file `linux-features/features.json`, preserving any other locally enabled features:

```json
{
  "enabled": [
    "codex-micro-emulator"
  ]
}
```

Rebuild the app with the normal repository workflow. Do not edit or enable the feature in `linux-features/features.example.json`; committed defaults must remain empty. A generated app stages the operator CLI at:

```text
codex-app/resources/native/codex-micro-emulator
```

The examples below use that generated path:

```bash
codex_micro_cli=codex-app/resources/native/codex-micro-emulator
"$codex_micro_cli" status
"$codex_micro_cli" watch
"$codex_micro_cli" watch --raw
"$codex_micro_cli" connect
"$codex_micro_cli" disconnect
"$codex_micro_cli" key AG00 tap
"$codex_micro_cli" encoder cw --steps 2
"$codex_micro_cli" joystick left
```

The seven command groups are `status`, `watch`, `connect`, `disconnect`, `key`, `encoder`, and `joystick`. `watch --raw` preserves each JSONL record; plain `watch` renders the high-signal fields.

- `key <name> <action>` allows `AG00` through `AG05`, `ACT06` through `ACT12`, and `ENC_SW`, with `press`, `release`, or `tap`.
- `encoder <direction> [--steps N]` allows `cw` or `ccw`; `N` defaults to 1 and must be from 1 through 100.
- `joystick <direction>` allows `up`, `right`, `down`, `left`, or `center`.

## Runtime files and trace format

`XDG_RUNTIME_DIR` is required by both the emulator and CLI. There is deliberately no shared `/tmp` fallback. The private control socket is:

```text
$XDG_RUNTIME_DIR/codex-desktop/codex-micro-emulator.sock
```

State is stored under `$CODEX_LINUX_APP_STATE_DIR/codex-micro-emulator` when `CODEX_LINUX_APP_STATE_DIR` is set. Otherwise it uses `$XDG_STATE_HOME/codex-desktop/codex-micro-emulator`, or `$HOME/.local/state/codex-desktop/codex-micro-emulator` when `XDG_STATE_HOME` is unset. The durable trace is `events.jsonl` inside that state directory.

Each JSONL line has a session ID and monotonic sequence number. The six record types are:

- `session`: emulator, process, Node/Electron, and app-version context;
- `connection`: discoverable, connected, disconnected, or error lifecycle state;
- `rpc.request`: the upstream Codex Micro JSON-RPC request;
- `hid.frame`: a simulated 64-byte report for the serialized request;
- `rpc.response`: the deterministic emulator response; and
- `notify.rx`: a validated typed key, encoder, or joystick notification delivered to the app.

Simulated HID framing uses report ID `0x06`, channel `0x02`, up to 61 payload bytes per 64-byte report, and zero padding after the payload. The active trace rotates at 5 MiB and retains `events.jsonl.1` and `events.jsonl.2`, for three total generations.

## Privacy and failure behavior

Raw Codex Micro RPC payloads are private debug data. Observed traffic currently concerns device lighting and status rather than prompts, but traces can still reveal app behavior and must be reviewed before sharing.

Trace durability is fail-closed: if the trace or control socket fails, the virtual device disconnects and stops accepting typed input. If the enabled patch no longer matches the current upstream bundle, feature drift rejects the rebuild candidate instead of promoting an app without the requested emulator.

## Verify a generated candidate

Use an isolated feature config and candidate directory when checking staging without changing local enablement:

```bash
codex_micro_uat=$(mktemp -d)
node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({enabled:["codex-micro-emulator"]}, null, 2)+"\n")' \
  "$codex_micro_uat/enabled-features.json"
CODEX_LINUX_FEATURES_CONFIG="$codex_micro_uat/enabled-features.json" \
CODEX_NEXT_APP_DIR="$codex_micro_uat/codex-app-enabled" \
REBUILD_REPORT_DIR="$codex_micro_uat/enabled-report" \
./scripts/rebuild-candidate.sh ./Codex.dmg
```

Verify the exact patch entry and staged permissions:

```bash
node -e 'const r=require(process.argv[1]); const p=r.patches.find((p)=>p.name==="feature:codex-micro-emulator:codex-micro-emulator-main"); if (!p || p.status!=="applied") { console.error(p||"missing feature patch"); process.exit(1); }' \
  "$codex_micro_uat/enabled-report/patch-report.json"
test -r "$codex_micro_uat/codex-app-enabled/.codex-linux/features/codex-micro-emulator/emulator.cjs"
test -x "$codex_micro_uat/codex-app-enabled/resources/native/codex-micro-emulator"
stat -c '%a %n' \
  "$codex_micro_uat/codex-app-enabled/.codex-linux/features/codex-micro-emulator/emulator.cjs" \
  "$codex_micro_uat/codex-app-enabled/resources/native/codex-micro-emulator"
```

The expected modes are `644` for `emulator.cjs` and `755` for the CLI.

## Future Air60 V2 integration

Air60 V2 support is a separate future layer. It should consume these typed commands through VIA shortcuts or QMK Raw HID without spoofing USB identity. This release does not control the Air60 V2.
