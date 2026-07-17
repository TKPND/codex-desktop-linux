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

Enabling the feature automatically bootstraps the existing upstream service-manager `getState()` path once at application launch. Renderer gate `3207467860` and Codex Micro UI visibility are unchanged, so the emulator may run without visible Codex Micro UI.

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

If automatic bootstrap rejects, the app logs `[codex-micro-emulator] automatic bootstrap failed`, keeps running, and leaves the emulator unavailable.

## Verify a generated candidate

Use an isolated feature config and candidate directory when checking staging without changing local enablement:

```bash
codex_micro_uat=$(mktemp -d)
mkdir -p "$codex_micro_uat/codex-home"
node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({enabled:["codex-micro-emulator"]}, null, 2)+"\n")' \
  "$codex_micro_uat/enabled-features.json"
CODEX_HOME="$codex_micro_uat/codex-home" \
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

### Isolate generated-app runtime UAT

An isolated runtime test must set a dedicated `CODEX_HOME` as well as every XDG root. XDG roots alone do not isolate bundled plugin marketplace and plugin cache writes, which otherwise use the normal `~/.codex` tree.

The background PID from `$!` belongs to the `start.sh` launcher, not Electron. In `--new-instance` mode the launcher publishes the Electron PID at `$XDG_STATE_HOME/codex-desktop/instances/port-*/app.pid` and waits for that Electron child.

```bash
codex_micro_host_runtime="${XDG_RUNTIME_DIR:?host XDG_RUNTIME_DIR is required}"
codex_micro_wayland_display="${WAYLAND_DISPLAY:?WAYLAND_DISPLAY is required for this Wayland UAT}"
case "$codex_micro_wayland_display" in
  ""|*/*)
    echo "WAYLAND_DISPLAY must be a socket name below the host XDG_RUNTIME_DIR" >&2
    false
    ;;
esac
codex_micro_wayland_socket="$codex_micro_host_runtime/$codex_micro_wayland_display"
if [ ! -S "$codex_micro_wayland_socket" ]; then
  echo "host Wayland socket is unavailable: $codex_micro_wayland_socket" >&2
  false
fi

mkdir -p \
  "$codex_micro_uat/codex-home" \
  "$codex_micro_uat/runtime" \
  "$codex_micro_uat/state" \
  "$codex_micro_uat/config" \
  "$codex_micro_uat/cache"
chmod 700 "$codex_micro_uat/codex-home" "$codex_micro_uat/runtime"
ln -s -- "$codex_micro_wayland_socket" \
  "$codex_micro_uat/runtime/$codex_micro_wayland_display"

CODEX_HOME="$codex_micro_uat/codex-home" \
XDG_RUNTIME_DIR="$codex_micro_uat/runtime" \
WAYLAND_DISPLAY="$codex_micro_wayland_display" \
XDG_STATE_HOME="$codex_micro_uat/state" \
XDG_CONFIG_HOME="$codex_micro_uat/config" \
XDG_CACHE_HOME="$codex_micro_uat/cache" \
  "$codex_micro_uat/codex-app-enabled/start.sh" --new-instance \
  >"$codex_micro_uat/enabled-app.log" 2>&1 &
codex_micro_launcher_pid=$!
codex_micro_electron_pid=""
codex_micro_expected_electron="$codex_micro_uat/codex-app-enabled/electron"
codex_micro_instances="$codex_micro_uat/state/codex-desktop/instances"

for attempt in $(seq 1 120); do
  if ! kill -0 "$codex_micro_launcher_pid" 2>/dev/null; then
    if wait "$codex_micro_launcher_pid"; then
      codex_micro_launcher_status=0
    else
      codex_micro_launcher_status=$?
    fi
    codex_micro_launcher_pid=""
    echo "launcher exited before a validated app.pid (status=$codex_micro_launcher_status)" >&2
    break
  fi

  mapfile -d '' -t codex_micro_pid_files < <(
    find "$codex_micro_instances" -mindepth 2 -maxdepth 2 -type f \
      -path "$codex_micro_instances/port-*/app.pid" -print0 2>/dev/null
  )
  if [ "${#codex_micro_pid_files[@]}" -eq 0 ]; then
    sleep 1
    continue
  fi
  if [ "${#codex_micro_pid_files[@]}" -ne 1 ]; then
    echo "refusing cleanup: expected exactly one isolated app.pid" >&2
    break
  fi

  if ! IFS= read -r codex_micro_candidate_pid < "${codex_micro_pid_files[0]}"; then
    echo "refusing cleanup: unreadable isolated app.pid" >&2
    break
  fi
  case "$codex_micro_candidate_pid" in
    ""|*[!0-9]*)
      echo "refusing cleanup: invalid Electron PID" >&2
      break
      ;;
  esac
  if [ "$codex_micro_candidate_pid" -le 1 ]; then
    echo "refusing cleanup: invalid Electron PID" >&2
    break
  fi

  codex_micro_candidate_exe="$(readlink -f "/proc/$codex_micro_candidate_pid/exe" 2>/dev/null || true)"
  if [ "$codex_micro_candidate_exe" != "$codex_micro_expected_electron" ]; then
    echo "refusing cleanup: app.pid does not name the isolated Electron" >&2
    break
  fi
  codex_micro_electron_pid="$codex_micro_candidate_pid"
  break
done

if [ -z "$codex_micro_electron_pid" ]; then
  echo "no Electron PID was validated; no process was signalled" >&2
  false
fi
```

The bounded loop accepts exactly one `app.pid` below the isolated `port-*` instance directory and confirms that `/proc/$pid/exe` resolves to the candidate's Electron binary. If the launcher exits early or validation fails, it does not signal an unknown process; stop the UAT and inspect the isolated logs before proceeding.

Use the same isolated environment variables, including the explicit `WAYLAND_DISPLAY`, for every emulator CLI command in that UAT. If `watch --raw` runs in the background, save its own `$!` as `codex_micro_watch_pid`. Clean up the watcher and application as separate, child-specific operations:

```bash
codex_micro_stop_watch() {
  if [ -n "${codex_micro_watch_pid:-}" ]; then
    kill -TERM -- "$codex_micro_watch_pid" 2>/dev/null || true
    wait "$codex_micro_watch_pid" 2>/dev/null || true
    codex_micro_watch_pid=""
  fi
}

codex_micro_stop_app() {
  local current_exe=""
  if [ -z "${codex_micro_electron_pid:-}" ]; then
    return 0
  fi

  current_exe="$(readlink -f "/proc/$codex_micro_electron_pid/exe" 2>/dev/null || true)"
  if [ "$current_exe" = "$codex_micro_expected_electron" ]; then
    kill -TERM -- "$codex_micro_electron_pid" 2>/dev/null || true
  elif kill -0 "$codex_micro_electron_pid" 2>/dev/null; then
    echo "refusing cleanup: validated Electron PID now names another executable" >&2
    return 1
  fi

  if [ -n "${codex_micro_launcher_pid:-}" ]; then
    wait "$codex_micro_launcher_pid" 2>/dev/null || true
  fi
  codex_micro_electron_pid=""
  codex_micro_launcher_pid=""
}

codex_micro_stop_watch
codex_micro_stop_app
```

Do not replace these checks with `pkill`, `killall`, or a process-name match.

### Troubleshoot a missing socket

The enabled feature bootstraps the upstream service manager automatically at application launch; startup is not renderer-lazy. If the socket never appears, confirm the generated candidate contains the exact applied feature patch and staged files shown above, inspect the `[codex-micro-emulator] automatic bootstrap failed` log path, verify the isolated runtime paths, and diagnose emulator startup. Forcing renderer gate `3207467860` does not repair a missing socket and is not part of emulator troubleshooting.

## Future Air60 V2 integration

Air60 V2 support is a separate future layer. It should consume these typed commands through VIA shortcuts or QMK Raw HID without spoofing USB identity. This release does not control the Air60 V2.
