# Codex Micro Emulator

This optional Linux feature provides an in-process Codex Micro transport emulator for development and testing. It is disabled by default and has no effect unless explicitly selected in the local Linux feature configuration.

The initial boundary is deliberately fail-closed: it exposes no virtual device, cannot connect, and does not yet accept typed input. Do not enable it expecting a working Codex Micro replacement until the remaining implementation and UAT are complete.

This feature is not a hardware compatibility layer, a production device driver, or a network-accessible service. It does not emulate physical USB or HID hardware outside the Codex Desktop process.

When implemented, traces may contain private upstream RPC payloads, simulated HID frames, and typed input. Treat trace data as sensitive, keep the private Unix socket local to the user session, and do not publish traces without reviewing them.
