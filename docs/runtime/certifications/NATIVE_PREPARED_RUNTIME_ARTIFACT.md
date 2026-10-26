# Native Prepared Runtime Artifact certification (#558)

## Ownership and scope

`tools/project_authoring/native_runtime_artifact.cpp::prepare_native_runtime_artifact`
assembles the **current Prepared Runtime Artifact** from one already-admitted,
normalized Project, a freshly native-compiled Project, its referenced Asset
closure, an explicit export profile, and native owner-resolved Material inputs.
It performs no disk reads, shader compilation, package publication, or cache
lookup. Errors produce actionable diagnostics and **no partial artifact**.

The native Project owner supplies a revisioned source snapshot and Material
effective inputs through `runtime-package-preparation`. The cold certification
entrypoint `--emit-native-prepared` rechecks source generation, revisions, and
Project equality after compilation/assembly. The assembler separately supports
a physical Project root to resolve package input sources, and rejects external
or traversing relative source paths.

The artifact contains selected profile, canonical source fingerprint, locale
selection and fallback counts, localization quality diagnostics, source and
variant Asset closure, partitioned locale catalog entries, script/layout/shader
source references, seekable audio paths, runtime display/accessibility and
orientation policy, full compiled gameplay JSON, material metadata, package
options, and manifest preview. It retains the current single schemas. Native
Material metadata uses the embedded Material registry and native effective
inputs; no TypeScript runtime preparation is linked into this entrypoint.

**Boundary:** Physical shader outputs, prepared media, distribution notices,
and the final physical source proofs are integrated by #559; cold cache
publication/invalidation is #560, end-to-end package/Test acceptance is #561,
and platform export orchestration is #545. This ticket does not switch the
production ScriptC CLI; that is owned by #551.

## Independent tests

From the repository root:

```sh
cmake --build --preset linux-debug --target noveltea-runtime-cache-publish-certify
ctest --test-dir build/linux-debug --output-on-failure \
  -R '^native_runtime_artifact_parity$'
```

`tests/native_runtime_artifact_parity.py` cold-admits Feature Lab via C++,
passes the *same admitted Project* to the independent TypeScript reference
`editor/scripts/native-runtime-artifact-parity-reference.mjs`, and recursively
compares every meaningful artifact field, including ordered diagnostics.
Both artifacts must validate against the current canonical Zod schema.
The test also verifies that prepared gameplay JSON decodes and executes in
the native runtime, and checks the physical source projection against the
Project root.

Additional cases vary asset pruning, shader source inclusion, target/default
locale, and reviewed-release quality; mutate authored freshness fingerprints
to exercise outdated Message and localized Asset warnings; and require errors
without partial artifacts for unsupported locales, missing entrypoints,
malformed compiled wire, and external/traversing package input paths.

Feature Lab is **already covered** by cold differential fixture evidence.
There is no new user-visible authored playback behavior in this ticket;
physical package load/playback is explicitly the subsequent acceptance gate.
