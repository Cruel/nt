# scriptc CLI Compatibility

NovelTea's standalone `noveltea` CLI is built with pinned `scriptc` 0.1.1. The release architecture intentionally uses scriptc's dynamic tier for the shared TypeScript authoring implementation and a very small statically compiled host for capabilities that require exact host/native behavior.

## Release architecture

The shared authoring CLI is bundled as one private code-split ESM package and executed inside scriptc's embedded QuickJS-ng island. The package keeps a tiny routing entry while command families, Project Workspace assembly, platform/export services, ComfyUI, agent-kit generation, and other heavy authoring subsystems remain separate lazy modules. ScriptC embeds the complete private package and compiles an embedded module only when its dynamic import is reached. This keeps the Node reference implementation and standalone CLI on the same TypeScript authoring/workspace semantics without requiring the shared codebase to conform to scriptc's current static TypeScript subset.

The static host owns only narrow capabilities. `--version` and `--help` are resolved entirely in this static tier from shared canonical CLI constants, raw `noveltea shaderc ...` dispatches from the static host directly into the embedded native shader compiler, the `test` command family may execute directly when the Project-local canonical runtime cache is independently proven fresh, and unchanged `validate` may return structured diagnostics from a proven Project-local authoring cache. The QuickJS island is imported lazily whenever authoring/workspace semantics are required or cache admission cannot be established; once inside the island, canonical bootstrap completes help/version/usage failures before any Workspace or platform capability is initialized, then uses the parsed command family to load only the remaining required services. Project-independent platform template/config commands therefore do not initialize the Project Workspace, while operations such as platform export, portable Project export, and template installation configure the ScriptC platform host only when their process/archive capabilities are required. The Node reference launcher mirrors this bootstrap-first, demand-driven capability setup and is code-split as well, so help/version/usage paths do not import Sharp, native tooling, platform tooling, or Project Workspace code. This keeps trivial CLI startup, raw shaderc forwarding, lightweight commands, and repeated cached test execution inexpensive without making either launcher a second Project parser.

The static host owns:

- process argv/stdout/stderr/exit behavior;
- stdin ingestion;
- process-liveness checks used by stale writer-lock reclamation;
- the C ABI bridge to `noveltea_tooling_native`;
- raw bgfx-compatible `shaderc` argument/exit-code forwarding without QuickJS initialization;
- direct child-process execution for the shared TypeScript platform exporter;
- native file-mode, exact path metadata, available-disk-space inspection, and conservative runtime/authoring-cache admission used by workspace/cache and staging safety checks;
- cached `validate` diagnostics when the same-build disk generation is proven unchanged (see `CLI.md#persistent-validation-cache`);
- cached `test run <id>` and bare `test run` dispatch when both the current runtime artifact and lowered Test catalog are proven reusable, plus `test run-spec` and `test run-ui-spec` dispatch when only the runtime artifact is proven reusable;
- `bimg`-backed raster inspection, contain-resizing, and PNG encoding for standalone icon output.

The native tooling archive continues to own shader compilation, raw bgfx shaderc forwarding, runtime/UI playback, canonical cache probing, and package writing. `noveltea_tooling_scriptc_invoke_to_file` is an adapter for scriptc format-1 FFI: request JSON crosses as borrowed strings, the existing `noveltea_tooling_*_json` API produces the response, and the adapter materializes that response into a private temporary file for the static host to read. Native business logic is not duplicated in the adapter. Cache probing validates the current generation/compiler identity, exact tracked-source byte-size and nanosecond-mtime metadata, conservative discovery contract, Test-source set, and artifact/catalog digests without decoding authored Project/Test schema or rereading authored source bytes for hashing. Runtime-artifact and Test-catalog admission are reported independently so stdin playback can keep using a fresh runtime artifact when only authored Tests changed.

## Build-time source embedding

The hand-authored agent-kit source remains canonical under `editor/agent-kit/`, while curator-only source/ref metadata lives beside it in `editor/agent-kit-provenance.json`. Release builds generate a private staged package containing the exact source texts plus that provenance object. The QuickJS island embeds the package, combines the texts with JSON Schemas generated from the shared Zod schemas when `agent sync` is invoked, and places provenance only in the generated manifest. No generated agent-kit source copy is checked in, and curator metadata is never emitted as an agent-facing file.

Built-in ComfyUI packages are handled the same way. The checked-in manifests and API workflows under `editor/assets/comfyui/workflows/` remain canonical; the release build collects their exact UTF-8 texts into a private staged `noveltea-scriptc-comfyui-workflows` package. The island supplies that immutable map through the workflow-library dependency-injection seam, so built-in discovery, inspection, verification, execution, and copy-to-user/project do not depend on Electron resources or sibling workflow files. Relocation certification runs `comfyui workflows` after moving the executable away from the editor tree and requires both bundled image workflows to remain available.

## Build pin and admitted host

- scriptc: exact `0.1.1`
- pnpm's 24-hour minimum-release-age policy exempts only `scriptc@0.1.1`, `@scriptc/compiler@0.1.1`, and `@scriptc/runtime@0.1.1`; future scriptc versions must either age normally or receive a new explicit reviewed exemption
- Node used to drive release builds/reference certification: exact `24.18.0`
- Linux release builds require host `clang`; Windows release builds require MinGW `gcc`/`g++` plus Zig 0.16.0 and target ScriptC as `x86_64-windows-gnu`
- admitted standalone targets: Linux x64 and Windows x64

`editor/scripts/build-noveltea-cli.mjs` verifies the installed scriptc version, builds the native
tooling archive closure for the current admitted host, produces the minified/no-sourcemap code-split
QuickJS package. During packing, `editor/scripts/cli-startup-policy.ts` walks the bundler's transitive static chunk-import metadata for both the ScriptC island entry and Node CLI entry, including static re-exports but excluding dynamic imports. Packing rejects either startup closure when it exceeds the lightweight budget, contains known heavy authoring/Workspace/platform/native-image source modules, or imports any external dependency other than a Node built-in. The guard uses chunk sizes and original source-module identities rather than parsing emitted JavaScript or relying on chunk names, so minification and shared-chunk factoring do not hide eager dependencies. It then stages the complete private island module graph plus agent-kit-source and ComfyUI-workflow packages under `build/host-tools/scriptc/`, invokes scriptc with
`--dynamic` and the platform-specific FFI manifest, strips the resulting ELF or PE executable, and
removes the staging directory. Windows deliberately uses the dedicated `windows-cli-gnu` CMake
preset and `x64-mingw-static-noveltea` target triplet so every FFI archive shares ScriptC's supported
GNU ABI instead of mixing MSVC objects into the Zig/MinGW final link.

The final executable must not depend on Node, a separate shaderc executable, or any project-local JavaScript files at runtime.

## Compatibility boundaries

The QuickJS island provides enough Node-compatible filesystem/path/crypto behavior for the current public authoring CLI, but its Node compatibility is not assumed to be exact for operating-system primitives. Process liveness therefore remains in the static host. Similar OS-level capabilities should be added to the host deliberately when needed rather than relying on an unverified island shim.

The self-contained artifact supports the `noveltea platform` command family through shared
TypeScript orchestration. Electron uses Node process execution and Sharp. The standalone host runs
processes in scriptc's static tier and performs image processing through the native `bimg` bridge;
the QuickJS island neither starts subprocesses nor loads Node native addons. Template archive
commands therefore remain Node-free at runtime while using installed host archive utilities through
structured executable and argument requests.

ComfyUI transport stays in the shared TypeScript island and uses HTTP(S) `fetch` plus bounded response readers. Execution polls `/history/<prompt-id>`; there is no WebSocket dependency in the standalone path. Source-image inspection crosses the existing native `image-inspect` boundary before bytes can be uploaded, and no Sharp/native-addon dependency enters the island. Local-file disclosure follows the shared narrow rule: credential-free plain HTTP to a literal loopback IP only; DNS hostnames including `localhost`, HTTPS, and non-loopback addresses are rejected. URL objects in the island are treated as read-only values because ScriptC's current URL compatibility layer does not admit Node-style component mutation.

OS signal delivery is a known host boundary. The current ScriptC QuickJS island does not receive host SIGINT in a form that permits asynchronous prompt cleanup before process termination. Node-reference certification therefore exercises the public Ctrl-C path directly. Standalone certification exercises the same shared abort signal and prompt-specific `/queue` deletion through a certification-only island injection, proving cancellation semantics at the highest practical ScriptC seam without claiming that current ScriptC forwards Ctrl-C cleanup. The shared runner never uses ComfyUI's global `/interrupt` endpoint.

The admitted standalone release hosts are Linux x64 and Windows x64. macOS standalone artifacts
must not be advertised until scriptc/native-link certification is added there. A certified CLI may
assemble any compatible installed target template regardless of its host platform.

## Certification gate

`editor/scripts/certify-noveltea-cli.mjs` treats the Node bundle as the semantic reference and requires the standalone scriptc executable to match it on exit code, stdout, stderr, and project-tree state across discovery, validation, agent sync, usages, structural mutations, transaction/recovery cases, and failure paths. Test-command certification additionally compares Node and ScriptC public behavior for targeted `test run <id>`, bare `test run`, `test run-spec`, `test run-ui-spec`, and blocked-Test outcomes on both canonical TypeScript fallback and persistent-cache-hit paths. Trace assertions prove that a cold standalone invocation imports the dynamic island and publishes a canonical generation, while a subsequent proven hit stays entirely in the static/native tier.

Authoring-cache certification compares cold and warm JSON/human validation, including semantic errors and source-aware warnings. Traces require cold/stale/corrupt/incompatible validation to import the island and warm validation to stay static/native. It exercises candidate additions/deletions, tracked metadata and declared Asset changes, ignored README changes, and failed publication/recovery. Disposable generation UUIDs and metadata are excluded from differential Project-tree equality; dedicated admission checks verify their correctness.

The release gate also exercises runtime-cache freshness and recovery through the standalone executable: exact tracked-file mtime/size changes, tracked deletion, conservative source addition/removal, declared Asset source mutation, ignored README changes (including their directory-metadata side effects), compiler/cache-schema incompatibility, malformed payload recovery, native-admission rejection with one explicitly forced canonical rebuild/retry, authored-warning parity on cache hits, missing cached Test IDs, runtime reuse while the Test catalog is stale, and best-effort publication failure. Feature Lab is copied to an isolated temporary Project, executed once through bare `test run` from a cold cache, and then exercised through a targeted cached Test. It separately certifies typed shader output, raw shaderc goldens, runtime/UI playback, package export, template registry/configuration, a real Web platform export, and relocation.

ComfyUI certification uses `editor/scripts/comfyui-certification-server.mjs`, a deterministic local HTTP server requiring neither a GPU nor a ComfyUI installation. Node and ScriptC are compared for status, built-in listing/inspection, verification, scalar filesystem generation, secure local-image editing, classification-default selection, Project Asset publication, named mixed publication, upload/execution/output failures, and request timeout behavior. Certification compares normalized machine output, stderr/exit status, publication state, and externally observable request sequences; successful history deliberately completes on a later poll. The cancellation checks require prompt-specific queue deletion and reject `/interrupt`.

Certification also traces the island's lazy capability boundaries for representative platform commands: template installation must configure the platform host without initializing the Project Workspace, template listing and config initialization must stay Project-independent, and platform export must initialize both the platform host and Project Workspace. A release is not admitted merely because scriptc can build it. The differential and native certification must pass.

## Performance policy

The #285 Linux certification measured a newly created empty Project (semantic-error exit 4) at
1.62 s for cold standalone validation and 10.5–11.4 ms across three unchanged warm runs. Traces showed
QuickJS import only for the cold run. These are local engineering observations, not CI timing limits.

The #289 scoped-Project-preparation check on 2026-09-18 packed `asset audit` behind an 8.8 kB preparation chunk plus a 1.3 kB command chunk while the full Project Workspace remained a separate roughly 607 kB chunk. Seven Node-reference Feature Lab runs measured 0.33–0.37 s for `asset audit` versus 0.47–0.50 s for `platform profiles`, which still used full Workspace preparation at that point. The #290 follow-up moved `platform profiles` onto the same preparation seam with Project identity plus export/profile settings only. The resulting ScriptC build kept full Project Workspace assembly in a separate roughly 607 kB chunk; after preserving existing diagnostic-ordering semantics, the scoped preparation chunk was 10.8 kB and the platform command chunk 16.0 kB. Seven Node-reference Feature Lab profile-inspection runs measured 0.31–0.33 s, bringing the command into the lightweight Project-inspection target range and approximately matching scoped `asset audit` on the same checkout. The standalone executable remained dominated by its existing roughly 1.6–1.7 s ScriptC/QuickJS invocation floor for both scoped commands, so the Node measurements are the useful signal for the Project-preparation cost itself. These measurements are directional local evidence rather than CI wall-clock gates.

The current design deliberately favors compatibility over forcing shared TypeScript through scriptc's static compiler. The shared TypeScript CLI and Electron main process publish the same canonical runtime artifact and lowered Test catalog; editor preview-locale and pseudo-locale Play builds are separate persistent variants in the same disposable cache namespace and never replace the canonical `current` generation. At most four preview variants remain actively indexed by the editor. One static-host hot path is repeated test execution from a proven canonical cache generation: the host performs only conservative root nomination and native cache admission, then dispatches the cached Compiled Project directly for stdin playback or combines it with the independently admitted lowered Test catalog for authored single/suite execution. It never parses authored Project or Test schema, and its native probe accepts only the `canonical-runtime` variant, never editor preview variants. Ordinary native admission compares the exact tracked/candidate inventory plus exact byte size and nanosecond mtime metadata; it does not reread and hash authored source bytes. Missing, stale, malformed, incompatible, ambiguous, or otherwise unusable runtime state imports the existing QuickJS island and follows canonical preparation/publication; stale Test-catalog state alone does not disqualify stdin runtime/UI specs. If an admitted cached payload is rejected by native execution, the host explicitly marks the island invocation for one forced canonical rebuild/retry and leaves the published `current` generation intact until a replacement generation publishes successfully. The shared TypeScript cache consumers apply the same one-rebuild/one-retry policy for editor and fallback CLI execution. The other static/native reuse boundary is unchanged whole-validation admission described in `CLI.md#persistent-validation-cache`; both native probes share low-level metadata/discovery logic. Other authoring operations remain in the shared TypeScript island unless a similarly narrow measured boundary is justified later.
