# scriptc CLI Compatibility

NovelTea's standalone `noveltea` CLI is built with pinned `scriptc` 0.0.34. The release architecture intentionally uses scriptc's dynamic tier for the shared TypeScript authoring implementation and a very small statically compiled host for capabilities that require exact host/native behavior.

## Release architecture

The shared authoring CLI is bundled as one private CommonJS package and executed inside scriptc's embedded QuickJS-ng island. This keeps the Node reference implementation and standalone CLI on the same TypeScript authoring/workspace semantics without requiring the shared codebase to conform to scriptc's current static TypeScript subset.

The static host owns only narrow capabilities. `--version` and `--help` are resolved entirely in this static tier from shared canonical CLI constants, and raw `noveltea shaderc ...` dispatches from the static host directly into the embedded native shader compiler. The QuickJS island is imported lazily only for commands that need the authoring application. This keeps trivial CLI startup and raw shaderc forwarding near native process-launch cost.

The static host owns:

- process argv/stdout/stderr/exit behavior;
- stdin ingestion;
- process-liveness checks used by stale writer-lock reclamation;
- the C ABI bridge to `noveltea_tooling_native`;
- raw bgfx-compatible `shaderc` argument/exit-code forwarding without QuickJS initialization;
- direct child-process execution for the shared TypeScript platform exporter;
- native file-mode and available-disk-space inspection used by staging safety checks;
- `bimg`-backed raster inspection, contain-resizing, and PNG encoding for standalone icon output.

The native tooling archive continues to own shader compilation, raw bgfx shaderc forwarding, runtime/UI playback, and package writing. `noveltea_tooling_scriptc_invoke_to_file` is an adapter for scriptc format-1 FFI: request JSON crosses as borrowed strings, the existing `noveltea_tooling_*_json` API produces the response, and the adapter materializes that response into a private temporary file for the static host to read. Native business logic is not duplicated in the adapter.

## Build-time source embedding

The hand-authored agent-kit source remains canonical under `editor/agent-kit/`, while curator-only source/ref metadata lives beside it in `editor/agent-kit-provenance.json`. Release builds generate a private staged package containing the exact source texts plus that provenance object. The QuickJS island embeds the package, combines the texts with JSON Schemas generated from the shared Zod schemas when `agent sync` is invoked, and places provenance only in the generated manifest. No generated agent-kit source copy is checked in, and curator metadata is never emitted as an agent-facing file.

Built-in ComfyUI packages are handled the same way. The checked-in manifests and API workflows under `editor/assets/comfyui/workflows/` remain canonical; the release build collects their exact UTF-8 texts into a private staged `noveltea-scriptc-comfyui-workflows` package. The island supplies that immutable map through the workflow-library dependency-injection seam, so built-in discovery, inspection, verification, execution, and copy-to-user/project do not depend on Electron resources or sibling workflow files. Relocation certification runs `comfyui workflows` after moving the executable away from the editor tree and requires both bundled image workflows to remain available.

## Build pin and admitted host

- scriptc: exact `0.0.34`
- pnpm's 24-hour minimum-release-age policy exempts only `scriptc@0.0.34`, `@scriptc/compiler@0.0.34`, and `@scriptc/runtime@0.0.34`; future scriptc versions must either age normally or receive a new explicit reviewed exemption
- Node used to drive release builds/reference certification: exact `24.18.0`
- Linux release builds require host `clang`; Windows release builds require MinGW `gcc`/`g++` plus Zig 0.16.0 and target ScriptC as `x86_64-windows-gnu`
- admitted standalone targets: Linux x64 and Windows x64

`editor/scripts/build-noveltea-cli.mjs` verifies the installed scriptc version, builds the native
tooling archive closure for the current admitted host, produces the minified/no-sourcemap QuickJS
package, stages the private island, agent-kit-source, and ComfyUI-workflow packages under `build/host-tools/scriptc/`, invokes scriptc with
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

`editor/scripts/certify-noveltea-cli.mjs` treats the Node bundle as the semantic reference and requires the standalone scriptc executable to match it on exit code, stdout, stderr, and project-tree state across discovery, validation, agent sync, usages, structural mutations, transaction/recovery cases, and failure paths. It separately certifies typed shader output, raw shaderc goldens, runtime/UI playback, package export, template registry/configuration, a real Web platform export, and relocation.

ComfyUI certification uses `editor/scripts/comfyui-certification-server.mjs`, a deterministic local HTTP server requiring neither a GPU nor a ComfyUI installation. Node and ScriptC are compared for status, built-in listing/inspection, verification, scalar filesystem generation, secure local-image editing, classification-default selection, Project Asset publication, named mixed publication, upload/execution/output failures, and request timeout behavior. Certification compares normalized machine output, stderr/exit status, publication state, and externally observable request sequences; successful history deliberately completes on a later poll. The cancellation checks require prompt-specific queue deletion and reject `/interrupt`.

A release is not admitted merely because scriptc can build it. The differential and native certification must pass.

## Performance policy

The current design deliberately favors compatibility over forcing shared TypeScript through scriptc's static compiler. If profiling later identifies sustained hot paths, they may be migrated selectively to scriptc-native code or C++ behind explicit data boundaries. Project/workspace caching may also be introduced later. Neither optimization should change the public CLI contract.
