# Native authoring Project worker (#496)

The host-only Node-API Project adapter lives in
`tools/project_authoring/authoring_node_addon.cpp`. It owns the current
`ProjectSession` on a dedicated Node worker thread and exposes only the native
session handle plus `snapshot`, `observe`, `hint`, `coverageLost`,
`patch`, `save`, and `close`. Native handles never cross worker IPC and
all calls are serialized by the worker event loop.

`editor/src/main/services/native-authoring-worker.ts` polls the C++ source
observer outside the Electron main/renderer threads, initially at 200 ms.
Each observation verifies exact physical source bytes; OS watcher hints are
not evidence. The worker posts a typed initial source snapshot at sequence
zero and subsequently publishes monotonically numbered deltas with
Project-relative paths, exact SHA-256 revisions for changed/added source paths
(`absent` for removals), changed record owners and attributable invalid-source
diagnostics. Physical deltas are **not** interpreted as newly normalized or
compiled record values; resident cross-record reconciliation remains a later
native migration task. Main-thread consumers must not apply these provisional
physical changes as complete semantic Project data.
For changed Room/Map sources, the addon reopens a file only after its bytes
match the observer's exact revision and runs the native sparse-source validator.
Record-scoped diagnostics remain available until a verified repair or deletion;
a malformed record is reported without claiming the physical observer lost
coverage.
After successful normalization, the worker also runs the native Room/Map
local semantic validator (including duplicate exit directions, placement and
presentation invariants), publishing record-absolute paths for both structural
and local semantic errors. This does not substitute Project-wide cross-record
reconciliation.

`native-authoring-session-bridge.ts` is an opt-in **main-process** owner:
the caller supplies a current opaque `projectSessionId`, which it verifies
through `ActiveProjectSessionService.requireActiveProjectRoot` before creating
the worker. Only the main process supplies the canonical root and selected
addon path. No renderer path, daemon subprocess, preload capability, or
production Project writer is introduced by this ticket.
Every worker event is runtime-parsed, checked against its session ID and
generation, and checked against current main-owned Project authority.
Out-of-order deltas and command responses fail the session closed. Project
switch, close, worker crash, invalid messages or a native failure terminate
the worker, revoke pending requests, and permit a fresh authorized `open`.
Subscriber errors cannot break the transport. Native operations never block
the renderer or main-process event loop.

The project-authoring host build disables the Node addon by default. To
certify explicitly on Linux with Node headers installed alongside the Node
executable:

```sh
cmake -S tools/project_authoring -B build/native-authoring-worker \
  -DCMAKE_BUILD_TYPE=Debug -DNOVELTEA_BUILD_AUTHORING_NODE_ADDON=ON
cmake --build build/native-authoring-worker --target noveltea-authoring-node
pnpm -C editor exec vp pack
NOVELTEA_AUTHORING_NODE_ADDON="$PWD/build/native-authoring-worker/noveltea-authoring-node.node" \
  pnpm -C editor exec vp test run src/renderer/test/native-authoring-worker.test.ts
```

The differential test copies canonical Project source fixtures from Feature
Lab into a temporary root, verifies real Node-API loading and Project
snapshot delivery, observes an independent Room-file change without a
renderer request, and exercises concurrent mutation/observation, stale
revision rejection, Project identity rotation, failure and restart. Fake
transport tests verify ordering, authority and worker-crash behavior without
the native binary. The Linux CI host-contract job builds and exercises the
real addon. The binary is **not** installed into any shipped editor or
runtime artifact; platform-specific addon distribution and production
Project model cutover remain separate tasks.
