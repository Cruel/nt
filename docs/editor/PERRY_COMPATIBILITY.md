# Perry Compatibility Workarounds

## Purpose

NovelTea uses Perry to produce the standalone `noveltea` CLI from the shared TypeScript authoring
and command layer. Perry is pre-1.0, so this file records every known Perry-specific accommodation
that changes otherwise-normal TypeScript, Node, Zod, or build code.

These are compatibility workarounds, not NovelTea product contracts. Revisit them whenever Perry is
upgraded, and remove or simplify them when the complete Node-reference/Perry differential proves the
upstream behavior is fixed. Do not remove a workaround merely because a newer Perry version exists.

Current release-toolchain baseline:

- Perry: exact `@perryts/perry@0.5.1220`
- Perry native-library ABI: `0.5`
- Node reference/build host: `24.18.0`
- production Perry runtime: native AOT, with no V8/JavaScript fallback
- native archive supply-chain lock: repository-root `perry.lock`. Perry 0.5.1220 initially starts
  from the editor entrypoint but then recomputes its compile project root to the common ancestor of
  all resolved modules. Under this pnpm workspace that common root is the repository, so the actual
  compile-time native-archive gate reads this root lock. Normal `noveltea:build` sets
  `PERRY_LOCK_FROZEN=1`; deliberate native-archive changes refresh it only through
  `pnpm -C editor run noveltea:lock`, which runs the compiler with
  `PERRY_LOCK_UPDATE=@noveltea/tooling-native`.
- admitted standalone CLI/editor-package host: Linux x64. Windows and macOS are not release-admitted
  Perry CLI hosts yet; their editor artifact jobs remain disabled until the complete native,
  differential, relocation, and package-smoke gate is run there.

### Upstream compatibility-lab status

Phase 7 also tested newer Perry upstream builds without changing the release pin. Version `0.5.1429`
(commit `3fde6a442a16`) fixed several individual miscompiles listed below, but repeated full-program
stress was not deterministic. Follow-up `0.5.1430` (commit
`e1d27b6aff890d356196db95c508cc4b0b62696b`) completed once and then hung until the certification
timeout (`rc=124`). Version `0.5.1431` (commit
`ed58ec633ff0c0bf4cf029dd9a5f53636026d879`) exited `139` on its first stress run and `0` on its
second. The stable release therefore remains `0.5.1220`. These results are upgrade guidance only; all
`0.5.1220` accommodations remain required until an actual upgrade slice reruns the complete gate and
the candidate is stable across repeated runs.

Fixed in that newer compatibility lab:

- ordinary `async ProjectWorkspaceService.open()` settles correctly; the explicit-Promise workaround
  used for `0.5.1220` should be removed when upgrading because it can itself crash in the newer full
  program shape;
- direct nested `JSON.stringify` preserves the previously lost first-Room fields, so the recursive
  native-request serializer can be removed after an upgrade differential;
- native `path.join(...parts)`, `process.exitCode`, stdin fd `0`, promise `stat`/`Stats` predicates,
  and the original recursive canonical-JSON traversal all passed their focused newer-main probes;
- the iterative real-Zod-schema traversal GC regression present in upstream `0.5.1420` through
  `0.5.1423` is fixed in `0.5.1429`.

Still broken in the `0.5.1429` real NovelTea graph:

- ordinary async transaction `commit()`, stale-lock `acquireLock()`, and non-empty
  `recoverJournals()` crash; their explicit-Promise boundaries remain required;
- the previous typed-array/BigInt portable SHA-256 implementation still crashes in the real
  workspace-open graph; the ordinary-array implementation remains required.

Last tested broken on upstream `0.5.1423` and therefore still requiring a fresh retest before any
cleanup: custom `ReadonlyMap.values()`, `globalThis.crypto.randomUUID()`, Zod fluent/JIT behavior,
and passing declared native-library functions as first-class values.

The permanent `pnpm -C editor run noveltea:certify` gate is the release oracle for future upgrades.
It compares 23 Node/Perry command and filesystem outcomes, writer liveness/recovery, typed and raw
shader goldens, headless/UI playback, package export, relocation, and the final runtime dependency
closure.

The active implementation plan contains the historical discovery evidence and Phase-specific
validation results. This document is the durable compatibility ledger so those constraints do not
disappear when that plan is archived.

## Upgrade Procedure

For a Perry upgrade:

1. Change the Perry version only in a dedicated compatibility upgrade slice.
2. Run the smallest reproduction for every item below against the candidate Perry version.
3. Remove only accommodations whose original failing form now passes under both Node and Perry.
4. Run the complete Node-reference/Perry CLI differential, including writer lock/liveness/recovery,
   real compiler fixtures, native operations, raw shaderc forwarding, tests/UI tests, and package
   export.
5. Run standalone/relocation and production-package smoke before accepting the upgraded compiler.
6. Update or remove the corresponding item in this file.

## Compiler and Language-Lowering Workarounds

### Zod transform followed by fluent validation

**Perry behavior:** Perry 0.5.1220 miscompiles Zod v4 fluent chains that continue after a transform,
for example:

```ts
z.string().trim().min(1)
```

**NovelTea accommodation:** use Zod's semantically equivalent first-class checks instead:

```ts
z.string().check(z.trim(), z.minLength(1))
```

This form is used throughout the shared authoring/compiler schema closure, including files under
`editor/src/shared/project-schema/` such as `authoring-localization.ts`,
`authoring-project-settings.ts`, `platform-export-contracts.ts`, and `compiled-project.ts`.

This is not a NovelTea schema-version or validation-semantics change. The workaround preserves trim
and subsequent validation behavior while avoiding the Perry lowering failure.

**Revisit/remove when:** a representative `z.string().trim().min(1)` schema produces identical valid
and invalid results under Node and the candidate Perry version, followed by the complete compiler and
CLI differential.

### Zod JSON-Schema export

**Perry behavior:** Perry 0.5.1220 compiles the Zod v4 `z.toJSONSchema(...)` dependency closure, but
executing the exporter in the full NovelTea CLI fails while reading Zod's internal `_zod` definition
state (`Cannot read properties of undefined (reading '_zod')`). Ordinary workspace parsing and the
already-supported Zod validation paths continue to pass the Node/Perry differential; this is a
separate incompatibility exposed when Phase 8 added machine-readable agent-kit schema export.

**NovelTea accommodation:** JSON Schemas are generated by the Node 24.18.0 reference CLI during the
release build from the exact current workspace Zod codecs. The build verifies the generated
agent-kit manifest and every SHA-256 entry, then embeds those exact public agent-kit bytes into the
Perry executable. The released Perry CLI reads the frozen embedded payload and does not execute
`z.toJSONSchema(...)` at runtime. This is also the correct ownership model for the hand-authored
agent instructions, focused docs, and portable skill that are part of the same versioned kit.

`editor/scripts/build-noveltea-cli.mjs` stages the temporary payload beneath
`editor/scripts/dist/agent-kit` because Perry 0.5.1220 resolves `--embed` relative to the compile
entry's parent directory rather than the package root. The original `scripts/noveltea.ts` remains the
actual compile entry; changing it to an importing wrapper changes Perry's top-level-await behavior.
The temporary staging tree is ignored and removed after compilation.

**Revisit/remove when:** the real `z.toJSONSchema(...)` agent-kit schema set produces byte-identical
canonical schemas under Node and the candidate Perry version, followed by the complete
`noveltea:certify` differential. Even after Perry fixes the exporter, retaining build-time schema
materialization is acceptable if it remains the simpler way to guarantee that the release binary
contains the exact versioned public kit payload.

### Recursive Zod-definition traversal

**Perry behavior:** Perry 0.5.1220 miscompiles the recursive Zod-definition walk used to derive graph
field metadata.

**NovelTea accommodation:** `editor/src/shared/project-schema/authoring-graph-field-metadata.ts` uses
an iterative traversal. The Phase-0 differential established the same 1,234 schema leaves under Node
and Perry with that implementation.

**Revisit/remove when:** the equivalent recursive traversal produces the same complete leaf set and
ordering under Node and Perry and the authoring graph/compiler differential remains exact.

### Nested tracked-editor record parsing

**Perry behavior:** the permanent Phase-7 filesystem differential found that Perry 0.5.1220 can
silently collapse the nested `z.record(z.string(), z.record(...))` shape used by
`editor.json.recordMetadata` to an empty outer object in the full workspace-open graph. A real
`entity create` therefore preserved all Asset metadata under Node but rewrote `editor.json` with
`"recordMetadata": {}` under Perry, changing the persisted workspace revision as well.

**NovelTea accommodation:** `ProjectWorkspaceService` validates the two dynamic record levels with
explicit key loops and the existing `editorRecordMetadataSchema`, then restores that separately
validated tracked organization after the complete `AuthoringProject` parse. This does not relax the
schema: chapters/tags still use their existing schemas and every record-metadata leaf still passes the
same strict metadata schema. The checked-in 23-case Node/Perry differential compares resulting source
trees and therefore permanently covers create/rename/delete preservation of this metadata.

**Revisit/remove when:** the original nested record schema preserves nonempty multi-collection
metadata through workspace open plus create/rename/delete under the candidate Perry version, followed
by the complete `noveltea:certify` gate.

### Recursive canonical-JSON traversal

**Perry behavior:** Perry 0.5.1220 miscompiles the recursive canonical JSON walk in
`editor/src/shared/project-schema/compiled-project.ts`, collapsing an otherwise complete compiled
object to `{}`.

**NovelTea accommodation:** the canonicalizer is iterative while preserving recursive Unicode-key
ordering, array order, and negative-zero normalization.

**Revisit/remove when:** the recursive implementation produces byte-identical canonical output under
Node and Perry for the real valid compiler fixture and adversarial nested-object/array fixtures.

## Runtime and Node-Compatibility Workarounds

### Zod JIT code generation

**Perry behavior:** Zod v4 normally generates optimized validator functions with dynamic
`Function(...)`. Perry's native AOT runtime refuses that dynamic-code path and emitted Perry stderr
when Zod initialized before jitless mode was enabled.

**NovelTea accommodation:** `editor/scripts/zod-jitless.ts` calls:

```ts
z.config({ jitless: true });
```

`editor/scripts/noveltea.ts` loads that bootstrap immediately before importing the CLI
application/schema module graph for commands that require authoring/workspace schemas. Lightweight
commands (`--version`, `--help`, usage/unknown-command handling, raw `shaderc`, and Perry `agent
sync`) never initialize Zod at all. Import order is intentional: every schema-backed branch still
loads `zod-jitless.ts` before the first module that constructs a Zod schema.

**Revisit/remove when:** either Perry supports the required dynamic-function behavior or Zod no
longer attempts it in the relevant AOT environment, and `noveltea --json --version` plus the full CLI
differential run with clean stderr without the bootstrap.

### `fs.promises` / `Stats` compatibility

**Perry behavior:** two related filesystem parity problems have been observed with 0.5.1220:

- `import { promises as fs } from 'node:fs'` exposed an unusable `stat` member during the original
  compiler compatibility spike, while direct `node:fs/promises` imports worked there;
- during the production CLI workspace differential, Perry's promise-based `stat` result did not
  preserve the Node `Stats` predicate methods used by the workspace adapter.

**NovelTea accommodation:** the shared `ProjectWorkspaceFileSystemAdapter` owns path behavior, error
normalization, and atomic-write sequencing once. Electron and ordinary Node hosts inject genuinely
asynchronous `fs.promises` operations through `node-project-workspace-file-system.ts`; only the
standalone Perry entry point injects the synchronous primitives from
`perry-project-workspace-file-system.ts`. Perry still uses the direct promise `realpath` API because
its `realpathSync` codegen path is not usable in this closure. A shared contract suite runs against
both operation sets. Blocking local filesystem operations are therefore confined to the short-lived
Perry CLI rather than affecting Electron's main process.

**Revisit/remove when:** the candidate Perry version passes a focused `fs.promises.stat`/`Stats`
predicate probe and the complete workspace differential, including writer-lock liveness and recovery.

### Large async class-method Promise settlement

**Perry behavior:** Perry 0.5.1220 executes `ProjectWorkspaceService.open()` through its complete
success path, including every awaited file read, workspace-revision calculation, canonical
fingerprint, validation, snapshot construction, and final result construction, but the async class
method's implicit Promise remains pending. A focused production-config probe proved ordinary
`Promise.resolve(...).then(...)` callbacks still run while neither the fulfillment nor rejection
handler attached to `workspace.open(...)` is invoked. In the real CLI this surfaces as Node's
`Warning: Detected unsettled top-level await` and exit status 13.

**NovelTea accommodation:** `ProjectWorkspaceService.open()` owns an explicit outer Promise. Its
existing async body runs inside that boundary and explicitly resolves every normal success/failure
result through a shared completion helper; unexpected exceptions explicitly reject the outer
Promise. The workspace-loading algorithm, validation, transaction behavior, and returned data remain
unchanged.

**Revisit/remove when:** the original direct `async open(...) { ...; return result; }` implementation
settles both success and failure probes under the candidate Perry version, followed by the full
workspace-open, writer-lock/liveness/recovery, and CLI differential suite.

The same Perry settlement defect also affected the transaction service on branches that reached the
end of `commit()`, stale-lock `acquireLock()`, or non-empty `recoverJournals()` processing. Those
boundaries now explicitly resolve/reject their owned Promises after the existing transaction work is
complete. Phase 8 also exposed the same class of defect in the free `discoverProjectRoot()` async
boundary when the enlarged CLI graph performed upward project discovery: the work completed but the
implicit Promise could remain unsettled and the executable exited with status 13. Discovery now owns
an explicit outer Promise and resolves/rejects it after the unchanged upward-search algorithm. The
CLI startup optimization later exposed the same defect in the changed=true `agent sync` mutation
path; `syncNovelTeaAgentKit()` now explicitly settles its outer Promise after activation/cleanup.
The complete Node/Perry differential covers root and upward discovery, agent-kit activation, successful
mutations, live/malformed/stale locks, interrupted-journal recovery, and the current guarded/atomic
stale-lock reclamation path.

### Transaction UUID call shape

**Perry behavior:** a transaction-service class helper returning `globalThis.crypto.randomUUID()`
produced `undefined` under Perry 0.5.1220 in the full CLI, causing `ownerToken` to disappear when the
lock owner was JSON-serialized.

**NovelTea accommodation:** the Node/Perry workspace host factory imports the supported named
`randomUUID` function from `node:crypto` and injects it into `ProjectWorkspaceTransactionService`.
The shared transaction module keeps a browser-safe `globalThis.crypto.randomUUID()` default for
non-Node hosts, so renderer-reachable code does not import `node:crypto`. Tests retain the injectable
ID override so deterministic transaction fixtures do not depend on random values. Phase 9 final
certification caught a regression where the host injection had been lost: Perry then serialized a
writer lock without `ownerToken`, could not verify ownership during release, and failed the first
executing mutation on its post-commit reopen. The permanent Node/Perry filesystem differential now
covers this exact lock lifecycle.

**Revisit/remove when:** the original `globalThis.crypto.randomUUID()` class-helper shape returns a
valid UUID repeatedly in the full Perry CLI and the writer-lock differential remains exact.

### Portable SHA-256 typed-array state corruption

**Perry behavior:** Perry 0.5.1220 produced nondeterministic SHA-256 results from NovelTea's portable
TypeScript implementation when it ran inside the full CLI program. Identical `project.json` bytes
could receive a different digest on consecutive workspace opens, which in turn made unchanged
workspace revisions drift and caused tracked mutations/recovery to report false external-change or
unknown-state conflicts. Small standalone hash probes could pass, so this must be verified in the
real compiled dependency graph rather than assumed from an isolated function test.

**NovelTea accommodation:** `editor/src/shared/sha256.ts` keeps its public `Uint8Array` input, processes
complete 64-byte blocks in place, and allocates only a 64- or 128-byte typed tail. The message
schedule and mutable digest state remain fresh ordinary number arrays because that is the form proven
stable in the full Perry graph. It does not depend on Node-only crypto, so the same implementation
remains usable by browser/in-memory consumers without allocating an input-sized ordinary array.
Standard SHA-256 vectors and block boundaries match Node/Perry exactly, repeated hashes are stable,
and repeated full workspace opens produce stable per-file and aggregate revisions.

**Revisit/remove when:** any optimized typed-array implementation is first proven with standard hash
vectors and repeated calls inside the candidate Perry build, then with repeated full workspace opens
and the complete writer/mutation/recovery differential. Correctness and determinism take precedence
over restoring the previous typed-array implementation.

### `ReadonlyMap.values()` on custom map wrappers

**Perry behavior:** Perry 0.5.1220 misdispatches `.values()` when a custom class implementing
`ReadonlyMap` is accessed through a `ReadonlyMap`-typed property. A minimal probe using the same shape
as NovelTea's graph `ImmutableMap` reports the correct `.size` and `.get(...)` values, but iterating
`property.values()` yields zero entries. Direct `for...of` iteration over the same property correctly
visits every `[key, value]` pair. This caused the dependency graph assembler to receive 19 valid
contributions but collect zero nodes/edges, and made `noveltea usages` silently return no usages.

**NovelTea accommodation:** CLI-reachable dependency-graph code iterates these read-only map wrappers
directly (`for (const [, value] of map)`) instead of calling `.values()`. The immutable graph API and
Node behavior are unchanged.

**Revisit/remove when:** a custom `ReadonlyMap` property probe produces identical `.values()`
iteration under Node and the candidate Perry version, then the structural/source-aware graph,
`noveltea usages`, rename, and delete differential fixtures remain exact after restoring ordinary
`.values()` calls.

### Nested `JSON.stringify` object-shape loss

**Perry behavior:** Perry 0.5.1220 can lose properties from a nested optimized object when the same
object serializes correctly on its own. The Phase-7 compiled-project probe showed both Room objects
contained `cast`, `compose`, `hotspots`, `overlays`, `placements`, and `props`, and direct
`JSON.stringify(room)` preserved them. Serializing the native request wrapper
`{ project: compiledProject, spec: ... }` dropped those six properties from the first Room only,
which made the C++ compiled-project decoder report them as missing.

**NovelTea accommodation:** the Perry native binding reconstructs requests into a recursively copied,
key-sorted plain JSON value with explicit loops before calling `JSON.stringify`. This removes the
problematic optimized object graph from the serialization boundary and also makes native request
bytes deterministic. `undefined` object properties remain omitted and array behavior remains JSON
compatible.

**Revisit/remove when:** the original direct `JSON.stringify(request)` preserves all nested compiled
project fields under the candidate Perry version, including repeated multi-Room fixtures, and the
typed test/UI-test/package-export native gates remain green.

### Spread calls into native Node-module functions

**Perry behavior:** Perry 0.5.1220 accepts a direct native-module call such as:

```ts
path.join('/tmp/x', 'project.json')
```

but the equivalent valid spread call fails with `TypeError: The "path" argument must be of type
string.`:

```ts
const parts = ['/tmp/x', 'project.json'];
path.join(...parts);
```

The same failure occurs when a rest parameter is re-spread into `path.join`. Perry's public README
marks the spread operator in calls as supported, but current upstream `main` observed during the
Phase-7 investigation (commit `0328a63bbc1b582bfdbb0842a957aac861bd84d7`, version `0.5.1413`)
contains an internal comment describing the runtime native-module `ns.method(...arr)` path as a
separate gap.

**NovelTea accommodation:** do not rely on array/rest spread when invoking a variadic native Node
module function under Perry. The Perry-only workspace operations fold path segments through repeated
direct `path.join(a, b)` calls; the ordinary Node operations retain `path.join(...parts)`. Keep that
deliberately less-compact Perry implementation until upstream supports this path.

**Revisit/remove when:** the minimal valid-string-array `path.join(...parts)` reproduction succeeds
on the candidate Perry version and the full workspace/CLI differential passes.

### stdin file descriptor `0`

**Perry behavior:** `readFileSync(0, 'utf8')` returned `EBADF` under the Perry 0.5.1220 Linux CLI.

**NovelTea accommodation:** `editor/scripts/noveltea.ts` reads `/dev/stdin` on the currently admitted
Linux CLI host. The Windows branch retains fd `0`, but Windows is not admitted as a supported Perry
CLI host until its complete native/differential gate passes.

**Revisit/remove when:** fd `0` stdin reads match Node on each admitted host and the real `test
run-spec` / `test run-ui-spec` stdin fixtures pass through the released Perry binary.

### `process.exitCode`

**Perry behavior:** assigning `process.exitCode` did not propagate the final shell status under Perry
0.5.1220. This made command failures, including raw shaderc failure/unknown-option paths, appear to
exit successfully. Perry's stdout/stderr bridge writes output immediately but does not invoke the
callback passed to `stream.write(...)`; awaiting that callback leaves top-level await unsettled and
exits with status 13.

**NovelTea accommodation:** `editor/scripts/noveltea.ts` owns a `finalExitCode`. Node waits for the
JavaScript stdout/stderr write callbacks so an explicit exit cannot truncate piped output. The Perry
runtime is detected through `process.versions.perry`; only that runtime uses its immediate write path
without a callback before calling `process.exit(finalExitCode)`. The embedded raw shaderc bridge
separately flushes C `stdout`/`stderr` before returning, so neither JSON responses nor shaderc
diagnostics are lost before the explicit process exit.

**Revisit/remove when:** a Perry probe using only `process.exitCode = N` returns the same shell status
as Node for multiple nonzero values, Perry invokes stdout/stderr write callbacks reliably, and
CLI/raw-shaderc differential output and exit codes remain exact without the runtime-specific
explicit-exit accommodation.

## Native-FFI Workarounds

### Declared native functions as first-class values

**Perry behavior:** passing a declared `perry.nativeLibrary` function as a normal first-class
JavaScript value into a generic helper produced `TypeError: value is not a function` under Perry
0.5.1220.

**NovelTea accommodation:** `editor/native/noveltea-tooling/index.ts` invokes each declared native
symbol directly. Shared helpers operate only on ordinary request/response bytes and sizes; they do not
accept native function values.

**Revisit/remove when:** a minimal declared-native-function-as-argument probe works under the
candidate Perry version and the full native operation differential remains exact after consolidating
the wrappers.

### Native scalar result transport

**Perry behavior:** direct scalar return transport for the raw shaderc exit status was not reliable in
the 0.5.1220 binding proof, while Perry's caller-owned `buffer + length` path was reliable.

**NovelTea accommodation:** raw shaderc returns a small JSON response containing `exitCode` through a
caller-owned response buffer, matching the same ownership model used by the structured native JSON
operations. This keeps the C ABI explicit and avoids depending on the problematic scalar result path.

**Revisit/remove when:** a focused native-library scalar-return probe is stable under the candidate
Perry version on every admitted CLI host. Changing this transport is optional unless it materially
simplifies the ABI; the current buffer contract remains valid even after Perry fixes the gap.

## Perry Build/Packaging Workaround

### Exact source workspace for stdlib generation

**Perry behavior:** with Perry 0.5.1220 on the current Linux build host, the published prebuilt full
stdlib fallback links with unresolved HTTP symbols when Perry cannot locate its matching source
workspace.

**NovelTea accommodation:** `editor/scripts/build-noveltea-cli.mjs` materializes the exact Perry
`v0.5.1220` source archive under the ignored build/tool cache and verifies both the archive SHA-256
(`e4bcd0f362e001101a0d1b3683d14bd8e42b882dd59a1395be670fb9af9593c3`) and the immutable extracted
source-tree SHA-256 (`1adef789a428d96cf69b27ed59cdc46e72dcebaa9d22218a2c4ea6b3046134b7`). The tree hash excludes
only Perry's generated `target/` output. A stale or modified source cache is discarded and restored
from the verified archive before `PERRY_WORKSPACE_ROOT` is set. The npm Perry compiler then builds the
matching stdlib from that exact source. This must remain a reproducible build input, not an implicit
developer checkout dependency.

**Revisit/remove when:** an upgraded Perry release can build NovelTea from its published package on a
clean supported host without `PERRY_WORKSPACE_ROOT`, while the full CLI differential, relocation
smoke, and production package verification remain green.

## Phase-7 Release Size and Link Closure

The final Linux x64 measurements use the exact selected Perry 0.5.1220 compiler and source workspace:

- shared CLI graph without `@noveltea/tooling-native`: **34,486,080 bytes**;
- release `noveltea` with native tooling and embedded shaderc: **52,739,504 bytes**;
- native-tooling increment over that Perry-only graph: **18,253,424 bytes**.

The final standalone binary's dynamic closure is limited to the Linux loader/vDSO plus `libc`,
`libm`, `libstdc++`, and `libgcc_s`. It has no dynamic Node, Perry, shaderc, editor, or source-checkout
dependency. `pnpm -C editor run noveltea:certify` rechecks the relocation and forbidden-runtime
closure on every admitted release host.

## Do Not Normalize These Away Accidentally

Some accommodations look like ordinary refactoring opportunities: replacing iterative code with
recursion, restoring fluent Zod chains, switching the Perry operations backend to `fs.promises`,
consolidating FFI wrappers with a function parameter, changing explicit exit back to
`process.exitCode`, restoring implicit async-method Promise settlement, changing direct read-only-map
iteration back to `.values()`, or simplifying the Perry backend's repeated `path.join` calls to a
spread. Do not make those cleanups without first running the corresponding Perry probe and the
required differential gate above.
