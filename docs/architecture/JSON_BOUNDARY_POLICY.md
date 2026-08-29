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
nlohmann. A new implementation file cannot begin using the library merely because its containing
module already links it; the new codec/adapter seam must be admitted explicitly (or represented by a
fully documented temporary allowlist entry).

JSON decoding mechanics are concentrated in the content-owned `engine/src/core/json_decoder.hpp`.
That module owns checked member lookup, scalar conversion, object/array validation, JSON-pointer
construction, and diagnostic accumulation on top of `json_access`. Artifact codecs retain their own
schema/version/linking rules and typed result interfaces; the shared decoder is deliberately not a
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
