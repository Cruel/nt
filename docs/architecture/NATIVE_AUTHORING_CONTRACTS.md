# Native Project schema contracts

## Ownership and scope

Zod 4 remains the authoritative declaration of Project shapes and Zod-level normalization and
refinements. `editor/scripts/native-schema/sources.ts` inventories the effective Project, every
record family, source-reference schemas, and the actual workspace manifest, Traits, tracked/local
editor, and split localization source schemas. These are not a second handwritten schema hierarchy.
One additional `ZodRecordKeyCertification` witness exists only to test normalized record-key collisions
while real localization key validation still has an unimplemented native operation.

`tools/project_authoring/` is a **parallel, certification-only host boundary** for #475 / #474.
It does not replace workspace admission, Project-wide semantic validation, editor working state,
CLI validation, or the authoring compiler. No production caller uses it. Later family tickets must
implement their registered native operations and cross-record validation before native admission can
be authoritative. Sparse YAML decoding/default provenance and comment-aware persistence remain with
the existing workspace implementation; this slice accepts decoded JSON-shaped records only.

## Generation

Run from the repository root:

```sh
node editor/scripts/generate-native-schema.mjs
node editor/scripts/generate-native-schema.mjs --check
```

The generator is tested against the lockfile's Zod **4.4.3**; changing that version fails generation
until the visitor and differential tests are reviewed. Structural JSON Schema comes from Zod's
public `toJSONSchema` API, with input semantics and explicit tuple cardinality. A narrow visitor over
the documented Zod Core definition/check interfaces inventories semantics and generates traversal
metadata. Recursive lazies use the public cached `unwrap()` interface rather than invoking getters
independently. Generation therefore does not rely solely on private Zod representations or the
reference-document exporter's deliberately permissive `unrepresentable: 'any'` behavior.

Committed outputs under `tools/project_authoring/generated/` are deterministic:

- `contracts.json`: structural JSON Schemas, node/child relationships, ordered check stages, roots,
  semantic operation references, and literal defaults;
- `project_types.hpp`: C++20 structural records, enums (with exact numeric/boolean literal values), tagged `std::variant` unions, optional fields,
  arrays, maps, and boxed recursive nodes, without a JSON-library dependency;
- `operations.hpp`: stable native operation IDs and kinds.

The artifacts are same-build generated implementation data, not an independently versioned protocol.
`--check` rejects changed, missing, or unexpected artifacts. `--output <directory>` supports isolated
regeneration/staleness tests. The editor `check` task and Build CI enforce freshness. CMake consumes
only committed artifacts; ordinary native configuration/build does not execute Node or Zod.

## Semantic registration and failure policy

`native-schema-operations.ts` owns the explicit operation-ID/kind catalog. Schema declarations attach
named registrations to the exact Zod refinement, overwrite, or transform, preserving the original
instance and inferred TypeScript shape. Built-in JSON literal defaults use `value.default`, with
values recorded per node. Non-JSON or observably dynamic defaults fail generation.

Trimming and UTF-16 string length are explicit operations. JSON Schema measures Unicode code points,
whereas Zod/JavaScript length measures UTF-16 units: generated structural schemas therefore carry
`x-native-utf16-length` metadata instead of misleading `minLength`/`maxLength` keywords. The ordered
native check stages enforce the original trim-versus-length order. Arbitrary transforms,
super-refinements, overwrites, unsupported nodes/checks, and unknown operation IDs fail generation
rather than silently weakening the contract.

Registration is **not** an assertion that a native implementation exists. Native validation first
walks every reachable branch and rejects a contract requiring an unimplemented operation, even if the
provided value does not exercise that branch. This prevents a partially ported Project family from
appearing admitted. The implemented representative operations are literal defaulting, ECMAScript
Unicode whitespace trimming, UTF-16 length, empty Lua dependencies, and duplicate Lua dependency
rejection. Other catalog operations belong to the follow-on family migration tickets.

## Native structural validation and diagnostics

Pinned jsoncons 1.10.0, commit `d273865feb0d7e35a757c805dc4d1d9320eb6b72`, validates the
Zod-exported local structural stages. The adapter navigates generated recursive/discriminated-union
branches before invoking those validators, so a bad nested Condition reports its JSON Pointer rather
than a generic root `oneOf` error. Missing values remain distinct from explicit JSON null. Union
candidates and normalized output are isolated; opening/validation never rewrites source input.
Record parsing reproduces JavaScript's array-index-first key enumeration and rebuilds output using
normalized keys, including Zod's last-write-wins behavior when input keys normalize to one name.

The public certification boundary in `contracts.hpp` exchanges serialized records/results and typed
diagnostics, without leaking jsoncons types. It reports unsupported operations, malformed input,
structural errors, and traversal limits as failed results. Diagnostic prose need not match Zod; the
parity matrix compares admission, effective values, and useful nested ownership paths. Unknown-key
errors name the offending key (Zod itself reports the containing object).

The host-only library is not linked, installed, copied, or packaged into any engine/player/export
template. It deliberately uses the normal host C++ exception model and catches failures at its public
boundary. Its dependency and exemption are recorded in `CXX_RUNTIME_DEPENDENCY_POLICY.md`.

## Verification

A standalone host build avoids the renderer and all runtime dependencies:

```sh
cmake -S tools/project_authoring -B build/native-authoring -DCMAKE_BUILD_TYPE=Debug
cmake --build build/native-authoring
ctest --test-dir build/native-authoring --output-on-failure
NOVELTEA_SCHEMA_CERTIFY="$PWD/build/native-authoring/noveltea-schema-certify" \
  pnpm -C editor exec vp test run \
  src/renderer/test/native-schema-generation.test.ts \
  src/renderer/test/native-schema-parity.test.ts
```

The normal host-tools graph also builds the library and certification executable. Web, Android, and
other cross-compiles cannot build this directory. `types_compile.cpp` compiles the committed complete
C++ type artifact. The real Map fixture exercises recursive Conditions, default arrays, a nullable
trimmed style, and Lua dependency overwrites/refinement. Negative variants cover nested scalar and
discriminator errors, explicit-null rejection, strict keys, and duplicate semantic targets.
The certification-only record fixture verifies normalized keys and collision order; generator
tests also verify literal projections and plural/select operation-ID registration.

The native differential tests skip explicitly when `NOVELTEA_SCHEMA_CERTIFY` is not supplied; Build
CI always supplies it after building the executable. Generator/staleness tests run without a C++
build. Feature Lab is not applicable: this foundation has no runtime-observable or editor UI behavior.
