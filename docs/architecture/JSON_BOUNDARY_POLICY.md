# JSON Boundary Policy

JSON is an external serialization format, never runtime or domain state. The typed runtime receives
validated values from named codec and adapter interfaces; it must not retain a JSON DOM or replace a
typed concept with a JSON-shaped string, wrapper, property bag, or opaque payload. Compiled Project,
package, and save codecs may expose serialized-text entry points so callers do not need to construct a
JSON DOM; this also leaves those artifact interfaces free to gain non-JSON wire-format adapters later.

## Approved boundaries

The only shipped headers that may name `nlohmann::json` are explicit codec or adapter declarations:

- `core/*_codec.hpp` and the internal compiled-project/save codec declarations;
- `core/json_access.hpp`, the audited non-throwing low-level adapter used by JSON implementations;
- `core/editor_runtime_protocol.hpp` and `core/package_export.hpp` for their external protocols;
- `render/material_codec.hpp` and `script/compiled_runtime_loader.hpp` for their named package
  boundaries.

Their implementation files may use JSON locally. Ordinary headers and model/runtime APIs may not
include a nlohmann header, name a JSON type, define ADL `to_json`/`from_json`, or use a nlohmann
serialization macro. `JsonValue`, `JsonObject`, `SerializedPayload`, `JsonPayload`, and `JsonWrapper`
are prohibited wrapper names in shipped headers.

The policy checker also maintains the exact shipped `.cpp` paths that are allowed to mention
nlohmann. Host-only protocol tools such as `tools/editor_tool/font_coverage_tool.cpp`,
`tools/editor_tool/tooling_native_scriptc.cpp`, `tools/editor_tool/tooling_bridge.cpp`, and
`tools/editor_tool/tooling_daemon_broker.cpp`, and the unshipped direct CLI
`tools/editor_tool/native_cli.cpp` are
admitted as explicit editor-tool protocol adapters: JSON terminates at the process/FFI/IPC boundary
and typed engine/runtime interfaces do not retain a JSON DOM. A new implementation file cannot begin
using the library merely because its containing module already links it; the new codec/adapter seam
must be admitted explicitly (or represented by a fully documented temporary allowlist entry).

The standalone CLI has further **exact-path host protocol adapters**, audited in
`CheckJsonBoundaryPolicy.cmake`: `native_cli_agent.cpp` (generated Agent Kit response),
`native_cli_comfyui.cpp`/`native_cli_comfyui_http.cpp` (external ComfyUI HTTP request/response),
`native_cli_media.cpp` (native CLI media command), `native_cli_test_catalog.cpp`
(serialized authored Test catalog), and `native_cli_daemon.cpp` (broker IPC and immutable native
Project-preparation snapshot requests/responses). Their matching JSON-visible headers are admitted
individually. The daemon adapter's Project callback carries only the existing host command protocol;
its snapshot DOM does not enter typed runtime state.
`tooling_runtime_cache_publish_certify.cpp` is the independent, unshipped JSON command-line
certification adapter. These exceptions are *owned protocol entry points*, not permission for
arbitrary native editor-tool translation units to adopt a JSON DOM. The checker explicitly rejects
unlisted `native_cli_*` and `native_runtime_*` headers and sources.

The native Project authoring implementation has a distinct, **host-only** JSON boundary. Unlike
typed gameplay/runtime state, authoring stores a schema-checked, mutable JSON Project tree while
performing validation, normalization, source-aware mutations and transactions. The checker scopes
that boundary to direct `.cpp`/`.hpp` files in `tools/project_authoring/`, and to explicitly named
`tools/editor_tool/tooling_native_project_*.cpp`/`.hpp` CLI Project adapters. These types must not
escape those host-only implementations into engine/runtime/player code, general editor tooling, or
generated structural types. The policy continues to reject JSON markers elsewhere, forbids opaque
JSON wrappers and ADL codecs within these native paths, and forbids PUBLIC/INTERFACE nlohmann
linkage. Its positive/negative tests cover the native roots, unrelated tools, nested paths, and
forbidden declarations. The checker covers jsoncons and jsoncons_ext includes (quoted or bracketed)
and type names in addition to nlohmann. See [Native Project schema contracts](NATIVE_AUTHORING_CONTRACTS.md)
for the native schema adapter and its failure policy.

Native **Project compilation and runtime-artifact construction** also belong to this host-only
authoring codec ownership, so their `native_authoring_*`, `native_compiled_project*`,
`native_flow_prediction*`, and `native_runtime_*` implementation/header pairs live directly under
`tools/project_authoring/`. They consume the validated mutable Project tree and emit the current
serialized Compiled Project, Prepared Runtime Artifact, and physical export contract. Their JSON
data is never embedded into engine domain/runtime state; `native_cli.cpp` and the independent
certification adapter terminate that wire and call typed engine package/runtime APIs. These codec
sources are compiled only into the native CLI and its acceptance harness via the explicitly named
`_native_project_compiler_codec_sources` CMake inventory; they are not dependencies of the player.
The directory is a deliberate host-only authoring boundary, **not** a blanket license for JSON in
arbitrary editor or engine code. Nested authoring paths remain unapproved and the fixed checker
fixtures reject relocating unowned native tooling beside the CLI.

Standalone narrative admission has its own exact-path **host-only** authoring
adapter: `tools/narrative/catalog.cpp`, `progression.cpp`, `catalog.hpp`, and
`catalog_internal.hpp`. Its schema-checked Story read model, bounded solver state,
and JSON CLI report never enter a player or any engine domain/runtime API. The
native CLI is its only production consumer. These four paths are admitted
individually; this does not authorize JSON throughout `tools/narrative/` or add
narrative state to engine runtime. See [Narrative CLI](../editor/NARRATIVE_CLI.md).

JSON decoding mechanics are concentrated in the content-owned `engine/src/core/json_decoder.hpp`.
That module owns checked member lookup, scalar conversion, object/array validation, JSON-pointer
construction, and diagnostic accumulation on top of `json_access`. Artifact codecs retain their own
schema/version/linking rules and typed result interfaces. The private content-owned
`engine/src/core/motion_policy_codec.hpp` shares strict reconstructible Motion policy field encoding
between compiled, save, and focused-preview codecs; runtime receives only `MotionPlaybackPolicy`.
The shared decoder is deliberately not a
generic serialization abstraction. `RunningGameLoadInput` contains only an already-decoded
`LoadedCompiledPackage`, so runtime construction cannot fall back to raw JSON.

Runtime-wide textual bans on common method names are not JSON safety mechanisms. In particular,
ordinary `value()` methods are permitted. JSON safety is enforced by keeping raw library types inside
approved codec/adapter paths and by using the audited checked-access module there.

`nlohmann_json::nlohmann_json` must be a private dependency of the target that compiles the boundary;
it must not be linked with `PUBLIC` or `INTERFACE` visibility.

## Verification and exceptions

Run the policy directly with:

```sh
cmake --build --preset linux-debug --target json-boundary-policy
```

It is also part of `cxx-policy`, which is required by Linux and Web builds and checked directly in
the standalone and Android CI policy jobs. The checker runs focused positive/negative fixtures in
addition to the repository audit.

`cmake/json-boundary-allowlist.txt` is intentionally empty when every boundary uses an approved path.
An exception is allowed only for an external boundary that cannot be placed there. Each exact,
repository-relative entry has six pipe-separated fields:

```text
path|exact matched construct|owning subsystem or target|boundary category|rationale|removal condition
```

The category must be `external-boundary-codec`, `package-manifest-codec`, or
`editor-tool-protocol-adapter`. The checker rejects malformed, duplicate, wildcard, stale, or
path-only entries. The removal condition must be objective, or exactly `permanent external boundary`.
Move a proposed boundary into a named codec/adapter first; do not use an allowlist entry to defer
that extraction.

If the policy fails, move the JSON usage to the owning boundary or replace the leaked declaration
with its typed value. Do not silence a failure with a generic JSON wrapper or raw serialized text.
