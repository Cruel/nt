# JSON Boundary Policy

JSON is an external serialization format, never runtime or domain state. The typed runtime receives
validated values from named codec and adapter APIs; it must not retain a JSON DOM or replace a typed
concept with a JSON-shaped string, wrapper, property bag, or opaque payload.

## Approved boundaries

The only shipped headers that may name `nlohmann::json` are explicit codec or adapter declarations:

- `core/*_codec.hpp` and the internal compiled-project/save codec declarations;
- `core/json_access.hpp`, the audited non-throwing helper used by those codecs;
- `core/editor_runtime_protocol.hpp` and `core/package_export.hpp` for their external protocols;
- `render/material_codec.hpp` and `script/compiled_runtime_loader.hpp` for their named package
  boundaries.

Their implementation files may use JSON locally. Ordinary headers and model/runtime APIs may not
include a nlohmann header, name a JSON type, define ADL `to_json`/`from_json`, or use a nlohmann
serialization macro. `JsonValue`, `JsonObject`, `SerializedPayload`, `JsonPayload`, and `JsonWrapper`
are prohibited wrapper names in shipped headers.

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
