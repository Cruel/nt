# Native CLI / Node Tools Cutover Handoff (#541 → #521)

This is a pre-switch inventory. **Ordinary production still uses the old
ScriptC/Node Project owners.** Only #521 may switch the installed CLI and
editor together, remove the obsolete Workspace modules, and require the
whole-product closure gate. A passing candidate does not certify a release.

## Classified build producers

| Root or entrypoint | Current classification | #521 disposition |
| --- | --- | --- |
| `scripts/noveltea-scriptc-island.ts` → `dist-scriptc-island` | Shipped, legacy Project fallback in `application.ts`, `fmt-command.ts`, `project-bundle-cli.ts`, `semantic-project.ts` and resident TS Workspace | Replace with the proven native-only `native-application.ts` / native resident owner in the ordinary island, delete legacy fallback and selection flags |
| `scripts/noveltea.ts` → `dist-electron/tools` | Shipped Node CLI reference/oracle, deliberately unchanged for pre-switch certification | Delete this reference CLI rather than retain a second Project authority; remove old comparison-only certification |
| `scripts/noveltea-native-candidate.ts` → `dist-electron/tools` when `NOVELTEA_CLI_BUILD_NATIVE_CANDIDATE=1` | **Unshipped candidate witness**: forwards every operation to an installed SHA-bound native CLI; cannot open or validate Project files | Delete once no Node CLI wrapper is distributed, or retain only as a separately justified forwarding utility without Project interpretation |
| `scripts/compile-project.ts`, `scripts/generate-compiled-project-goldens.ts`, `scripts/materialize-platform-export-fixture.ts` → `dist-build-tools` | **Unshipped build/test-only**; old Project readers permitted only within their isolated compiler/fixture graph until replaced | Retain independent compiler/generator workflows if still needed, switch their Project admission to native; never copy the build-only output into the Electron distribution |
| `src/main.ts` → `dist-electron/main`; `src/preload.ts` → `dist-electron/preload` | Electron host and IPC surface | Native editor Project authority throughout, preserve Electron-only imports and existing IPC guard |
| `src/main/services/native-authoring-worker.ts` → `dist-electron/authoring-worker` | Native authoring addon bridge and worker, not a second Project engine | Retain, require independent addon/CLI disk and recovery witnesses |
| `dist-electron/renderer` | Renderer UI and transient forms | Retain UI-local parsing; remove retired Project validation/Workspace owner imports. Exact compiled package remains native |
| `noveltea-scriptc-host.ts`, `noveltea-scriptc-process.ts` and `noveltea_tooling_native` | Native process transport/broker, daemon lifecycle, shader/texture/media and host-independent capabilities | Retain native broker and independent tools; never move Project admission into a generic file-source codec |
| Agent Kit payload/schema generation; template/platform signing; runtime/Tests compiler | Generated reference/tooling and platform/player adapters, **not** alternate Project validators | Retain in appropriate native/host-only graph; keep exact version/schema inventory and player host-link isolation |

The canonical public command inventory is
`editor/scripts/certify-native-cli-inventory.mjs`: **39 public command
paths, 28 native Project bridge actions**, plus native editor IPC cases.
Do not replace this exhaustive check with a smaller hand-authored list.
Candidate-only commands and unavailable actions must fail closed (internal 70)
instead of importing `application.ts` or materializing a TS Workspace.
Native command ownership is implemented by `native-project-command-dispatch.ts`
and the scoped `native-project-*-cli.ts` handlers. Independent
`shaderc`, `texturec`, `media-tool`, platform template/config,
ComfyUI and Agent Kit remain explicitly classified, not dropped.

Types shared with native commands now live in
`src/cli/command-result-contract.ts` and
`src/shared/project-workspace/native-project-preparation-contracts.ts`.
The old semantic/resident services re-export compatible declarations only
while those services remain for the unswitched production path. No new
runtime codec may import a retired Workspace Project reader.

## Pre-switch executable evidence

```sh
# Native candidate, including separate emitted Node tools (not production):
NOVELTEA_CLI_BUILD_NATIVE_CANDIDATE=1 pnpm -C editor exec vp pack
pnpm -C editor run check:native-node-candidate
# After building the actual native-only installed candidate:
NOVELTEA_CLI_BUILD_NATIVE_CANDIDATE=1 pnpm -C editor run noveltea:build
pnpm -C editor run noveltea:certify:native-candidate -- "$PWD/build/cli/linux/noveltea" --cli-only

# Restore the unchanged ordinary build until the atomic switch:
pnpm -C editor exec vp pack
pnpm -C editor run bundle:policy
```

`check:native-node-candidate` requires an emitted provenance manifest in
each candidate root. The Node forwarding witness additionally refuses missing,
modified or unbound installed binaries/islands, and preserves native exit and
output without a Node Project fallback. The normal production manifest
verification inspects **every** emitted lazy chunk (including cache-miss and
disposable paths), not just initial entrypoints. Region/source-map disclosures
cannot conceal retired modules behind a forged module list. Strict executable
SHA256 plus island manifest SHA256 binding is independently enforced by
`native-production-qualification.mjs`; these checks do not claim a trusted
digital signature against an attacker who can replace *both* code and proof.

`dist-build-tools` is outside staged `dist-electron` and intentionally
excluded from distributable application manifests. Build-only compiler,
golden and platform-fixture launcher scripts use that new root. This isolation
is preparatory: those generators **still implement reference-dependent Project
logic** and therefore must not become shipped Node tools again.

## Atomic #521 build, release and retirement checklist

1. Replace the ordinary island's conditional `nativeOnlyBundle`/candidate
   selection with the always-native application and native resident owner;
   remove `NOVELTEA_CLI_BUILD_NATIVE_CANDIDATE`, poisoning/fallback selection,
   old resident and old `application.ts` dispatch. Update the normal ScriptC
   build/stage invocation, installed binary proof and package stage verification
   *in the same change*. Ensure `noveltea:certify` still exists as the
   production command but now runs native public/reference-independent tests.
2. Delete the shipped legacy `scripts/noveltea.ts`, old
   `src/cli/commands` Project-oracle handlers, `semantic-project.ts`,
   `fmt-command.ts`, `project-bundle-cli.ts`,
   `compile-project-command.ts` if native compiler publication replaces it,
   the `ResidentProjectWorkspaceService` / old Workspace transaction/cache,
   and the old authoring validation/graph implementations **only after**
   checking non-Project consumers and preserving required types in retained
   contracts. Delete any now-unused Node candidate forwarding shim.
3. Use `check-native-production-closure.mjs` as a **required failure gate**
   over `dist-electron/{main,preload,authoring-worker,tools,renderer}`
   and `dist-scriptc-island`. Keep all emitted chunks/provenance strict,
   including lazy imports, missing manifests, staleness and hashes.
   Installed CLI + island build proof must pass before Stage/installer signing.
4. Update Linux `.github/workflows/build.yml`'s direct Node Feature Lab
   CLI invocation and sectioned `linux-cli-certify`; update *both*
   `noveltea:certify` calls and host matrix in `release.yml`, plus
   `recertify-artifacts.yml` to the installed native contract. Preserve
   raw shaders, source cache, daemon restart, Feature Lab, authored Tests,
   runtime package, platform Web/Android, ComfyUI and Agent Kit smoke.
   Do not count native-vs-native wrappers as independent comparison.
5. Run `pnpm -C editor run check`, `test`, `build`,
   `check:native-production-closure`, native public inventory, standalone
   local/daemon and real installed artifact tests, stage/package smoke,
   host addon/CLI disk tests, and Linux/Windows/macOS release and
   recertification where available. Check host-only dependencies never link
   into player libraries. Verify exact readback with malformed YAML,
   unsupported schema, poisoned/stale source cache, malformed daemon response,
   stale manifest and mismatched binary negative cases.

The legacy `dist-scriptc-island`/ordinary Node-root gate is **expected to
fail** before #521. Do not suppress, omit or move that failure to allow
an early production switch. See
`docs/architecture/certifications/NATIVE_AUTHORING_CUTOVER_READINESS.md`
for #534's independent acceptance suite and remaining CI ownership.

## #541 Linux verification (pre-switch)

- The ordinary `pnpm -C editor run check`, `test` and `build` completed
  successfully. The renderer suite reported **3,104 passed, 166 skipped**.
  Build-only generators emitted into `dist-build-tools` and the ordinary
  bundle policy passed without staging them.
- A real installed native candidate was built with Node 24.18.0 and the
  pinned host dependencies. `check:native-node-candidate`, the negative
  emitted-closure/unit suite (15 tests), installed executable/island
  provenance and the 39-path/28-action public inventory all passed. The
  emitted Node candidate forwarded real version/usage calls without invoking
  the retired Node CLI.
- `noveltea:certify:native-candidate -- <installed-cli> --cli-only`
  passed all eight independent stages: public contracts, Feature Lab/
  authored Tests, disk cache/source integrity, daemon restart/cancellation,
  package exact bytes, Web platform publication, ComfyUI and publication
  rollback. The real Electron addon/installed CLI cross-system witness
  also passed exact cache admission, unsaved-state isolation, watcher,
  concurrent edits and editor Save.
- Actual signing credentials were not provided, so live certificate
  signing was not qualified. Windows/macOS and mandatory full-production
  closure are #521 release-matrix work, **not** evidence established by
  this Linux pre-switch verification.
