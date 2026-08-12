# scriptc CLI Compatibility

NovelTea's standalone `noveltea` CLI is built with pinned `scriptc` 0.0.26. The release architecture intentionally uses scriptc's dynamic tier for the shared TypeScript authoring implementation and a very small statically compiled host for capabilities that require exact host/native behavior.

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

## Agent-kit source embedding

The hand-authored agent-kit source remains canonical under `editor/agent-kit/`. Release builds generate a private staged package containing those exact source texts. The QuickJS island embeds that package and combines the texts with JSON Schemas generated from the shared Zod schemas when `agent sync` is invoked. No generated agent-kit source copy is checked in.

## Build pin and admitted host

- scriptc: exact `0.0.26`
- pnpm's 24-hour minimum-release-age policy exempts only `scriptc@0.0.26`, `@scriptc/compiler@0.0.26`, and `@scriptc/runtime@0.0.26`; future scriptc versions must either age normally or receive a new explicit reviewed exemption
- Node used to drive release builds/reference certification: exact `24.18.0`
- `clang` available on `PATH` for scriptc native compilation
- currently admitted standalone target: Linux x64

`editor/scripts/build-noveltea-cli.mjs` verifies the installed scriptc version, builds the existing native tooling archive closure, produces the minified/no-sourcemap QuickJS package, stages the two private packages under `build/host-tools/scriptc/`, invokes scriptc with `--dynamic` and the generated FFI manifest, strips the resulting ELF, and removes the staging directory.

The final executable must not depend on Node, a separate shaderc executable, or any project-local JavaScript files at runtime.

## Compatibility boundaries

The QuickJS island provides enough Node-compatible filesystem/path/crypto behavior for the current public authoring CLI, but its Node compatibility is not assumed to be exact for operating-system primitives. Process liveness therefore remains in the static host. Similar OS-level capabilities should be added to the host deliberately when needed rather than relying on an unverified island shim.

The self-contained artifact supports the `noveltea platform` command family through shared
TypeScript orchestration. Electron uses Node process execution and Sharp. The standalone host runs
processes in scriptc's static tier and performs image processing through the native `bimg` bridge;
the QuickJS island neither starts subprocesses nor loads Node native addons. Template archive
commands therefore remain Node-free at runtime while using installed host archive utilities through
structured executable and argument requests.

The currently admitted standalone release host remains Linux x64. macOS and Windows standalone
artifacts must not be advertised until scriptc/native-link certification is added on those hosts;
this does not restrict a certified Linux CLI from assembling compatible target templates.

## Certification gate

`editor/scripts/certify-noveltea-cli.mjs` treats the Node bundle as the semantic reference and requires the standalone scriptc executable to match it on exit code, stdout, stderr, and project-tree state across discovery, validation, agent sync, usages, structural mutations, transaction/recovery cases, and failure paths. It separately certifies typed shader output, raw shaderc goldens, runtime/UI playback, package export, template registry/configuration, a real Web platform export, and relocation.

A release is not admitted merely because scriptc can build it. The differential and native certification must pass.

## Performance policy

The current design deliberately favors compatibility over forcing shared TypeScript through scriptc's static compiler. If profiling later identifies sustained hot paths, they may be migrated selectively to scriptc-native code or C++ behind explicit data boundaries. Project/workspace caching may also be introduced later. Neither optimization should change the public CLI contract.
