# Development example qualification

NovelTea publishes the pinned public `Cruel/noveltea-examples` Projects and the certified in-tree Feature Lab through one qualified catalog. `nt` owns the exact external revision that is allowed to become a development-site input. The pin is the single 40-character commit in `examples/noveltea-examples.revision`; CI never floats to examples `main` while building the site/toolchain contract.

## Qualification contract

The shared public examples repository owns `scripts/build-examples.mjs`. `nt` invokes that entrypoint only with explicit inputs:

- the exact pinned examples checkout;
- the Linux standalone CLI produced by the current `nt` Build run;
- the canonical threaded Web player template produced by that same Build run;
- the matching player descriptor; and
- an explicit output directory.

`scripts/qualify-examples.mjs` requires the external checkout to be clean and exactly at the pin, and the `nt` checkout HEAD to match `--nt-revision`. It invokes the same pinned public builder twice: once for the external producer, once with a temporary source root containing only the ordinary Feature Lab Project and a one-example manifest. No external repository changes or Feature-Lab-specific channel mode are required. The Lab's normal `web-threaded` export profile retains its authored locales and development-quality localization; its existing reference button doubles as the application icon.

Each producer validates its Projects, exports and imports each `.ntproject` and validates the imported Project, emits runtime packages, and exports through the supplied Web template. Qualification verifies each producer's current `noveltea.example-catalog`, exact CLI/player identity and all file sizes/digests **before** aggregation. Both producers must have identical toolchain metadata, including shared player filenames and bytes. Export success is not a browser-execution claim; the site browser checks cover player startup and switching.

The resulting disposable `noveltea.publication-catalog` is the sole site input; old producer catalogs are not accepted at that boundary. It keeps the public external pin in `source`, records the global `publication.ntRevision`, and gives every example independent repository/revision/path provenance. Feature Lab's provenance points to `tests/projects/feature-lab` at the selected `nt` revision, not the external pin. The catalog contains exactly one Lab example, not an entry per scenario/check. Aggregation copies one shared `player/` and each example's separate launcher/config/content-hashed Web runtime payload and Project bundle, rechecking the assembled output. Producer temporaries are removed on success or failure.

Site preparation projects this internal catalog into the existing public showcase model. Only external examples receive public `sourceUrl` navigation; the Lab's private repository/path provenance is omitted from public JSON and HTML. Play and Project download/editor handoff remain available for every example. Runtime `.ntpkg` files are playback resources, never a download action; the separate runtime export is not staged as a public artifact.

The Build workflow uploads the successful output once as `noveltea-development-examples`. Downstream site work should consume that artifact/catalog shape rather than rebuilding examples independently. The site stages that one shared player once and recreates an iframe around the selected example's `.ntpkg`; switching examples does not duplicate the Wasm runtime. A failed qualification job is the compatibility signal that a proposed pin must not merge.

The qualification job checks out both repositories with persisted checkout credentials disabled before running public examples code. The public examples repository therefore does not need a token, deploy key, GitHub App, or other credential that can read or write `Cruel/nt`.

## Pin advancement

`.github/workflows/examples-pin.yml` runs on a schedule and through manual dispatch. It reads public `noveltea-examples` `main` with `git ls-remote`; it does not execute code from that revision. When `main` differs from the pin, the workflow resets the dedicated `automation/noveltea-examples-pin` branch from current `nt` master, changes only the revision file, and opens or updates one PR.

GitHub suppresses ordinary workflow recursion for pull requests created with `GITHUB_TOKEN`, so the updater explicitly dispatches the normal Build workflow on the automation branch whenever either the proposed examples revision or its `nt` base changes. Its `Development examples qualification` job therefore uses that exact commit's current `nt` CLI/player outputs before the pin can be accepted. Repository branch protection should require the normal Build checks and require the branch to be up to date before merge; the updater itself does not bypass qualification.

## Local qualification

The local wrapper uses the same exact-pinned build/verification seam:

```sh
bash scripts/qualify-examples-local.sh
```

By default it expects the public examples checkout at `~/dev/noveltea-examples`, builds the current checkout's Linux CLI and canonical threaded release Web player, and writes the qualified catalog/artifacts to `build/site-examples`. Override the locations with `NOVELTEA_EXAMPLES_ROOT` and `NOVELTEA_EXAMPLES_OUTPUT_ROOT` when needed.

`scripts/run-site.sh` calls this wrapper before starting Astro and exports `NOVELTEA_EXAMPLES_CATALOG_PATH` for the site. `/examples/dev` consumes that prepared catalog and matching local threaded player directly, so normal showcase development requires no Pages/R2 credentials.

## Public examples pull-request previews

`noveltea-examples` PR previews are intentionally independent from the pinned production-development input above. An unprivileged PR workflow resolves `development/toolchains/current.json` exactly once, verifies the immutable snapshot manifest plus CLI/player/descriptor size and SHA-256, and builds the proposed examples revision with that one snapshot. The resulting GitHub artifact records both exact revisions.

A separate trusted `workflow_run` publisher in the public examples repository receives the examples-specific R2-only Cloudflare credential only after the untrusted build finishes. It checks out trusted `main` publication code, never executes PR-controlled scripts, independently re-fetches the immutable `nt` snapshot manifest, validates the PR/source identity, exact toolchain hashes/player identity, and every catalogued output before upload. Preview objects live under `development/example-previews/pr-<number>/<examples-revision>/`, including the exported matching player and a trusted `preview.json` catalog.

The production site is not rebuilt for these previews. `/examples/dev?preview=pr-<number>/<examples-revision>` explicitly fetches only that immutable catalog through the stable `noveltea.pages.dev` preview proxy, rejects catalogs or project/player URLs outside the requested namespace, then uses the normal teardown/recreate showcase behavior. The Pages `_worker.js` maps only `/examples/dev/preview-assets/pr-<number>/<revision>/...` on the alternate Pages origin to the corresponding public R2 namespace and adds the COOP/COEP/CORP headers required by the threaded player. Preview content therefore stays off the primary `noveltea.dev` origin and does not depend on arbitrary R2 object-response headers. Closing or merging the public examples PR deletes its whole PR namespace immediately; scheduled stale cleanup is only a failsafe for previews older than 14 days whose PR is no longer open.

The local threaded Web configure explicitly disables the optional local `rmlui-bgfx` override so an existing developer cache cannot silently change the qualified toolchain away from the canonical `nt` dependency graph.

## Release example channel

A NovelTea release captures the examples pin from that exact tagged `nt` checkout. The Release workflow checks out that public examples commit, downloads the same release run's Linux host CLI and canonical threaded Web template, then invokes `scripts/qualify-examples.mjs` with the release tag/build ID as the required player identity. The resulting `noveltea-examples-<tag>.zip` therefore contains one shared player and example payloads that were qualified against the exact public release rather than current `master`.

The public `noveltea-release-manifest.json` records the release examples archive, examples source revision, and matching player build ID. `/examples` consumes that latest public-release generation while `/examples/dev` remains independently tied to the current development pin. Before the first public release, `/examples` redirects to `/examples/dev`. Pages-eligible release example files are staged under `/examples/assets`; any oversized files use the immutable `releases/examples/<tag>/<examples-revision>/` R2 namespace without changing showcase URLs or switching behavior.

## Verification

The contract-level tests are part of the CI test inventory:

```sh
node --test tests/ci/examples_qualification_tests.mjs
```

For the full integration seam, run the local qualification command above against a clean examples checkout at the pinned revision. A successful run proves the real CLI/project/package/player path rather than only validating manifest structure. Local uncommitted Lab edits are usable for iteration; only clean CI/tag checkouts establish exact-revision publication provenance.

### #260 verification limit

At implementation baseline `89ef0f7a0588836a6626ac6b98fcff051847083b`, full local qualification is blocked by pinned external commit `a9fa80fedf6278150ebc87f78cce1386c44b1aea`: Materials fails `WORKSPACE_SOURCE_READ` with an unsupported workspace-v1 shape using the current rebuilt CLI. The pin remains unchanged and qualification still fails closed. Update the public Projects to the current canonical workspace contract, then advance the pin through normal qualification; do not add a compatibility reader or silently patch their source during publication.

The independent Feature Lab producer passed real validation, package export, Project export/import/validate and threaded Web export with the current CLI/player. Site build and browser interaction were checked using that real Lab output plus **Lab-backed external selector fixtures**, not qualified Materials/Verbs payloads. Those checks prove the three-entry UI, shared-player staging, optional Source hiding/restoration and Lab startup; they do not resolve the external qualification blocker. Final checks passed: all 56 CI contract tests, 30 site tests, two browser tests, Astro typechecking, Lab manifest validation and all 43 authored Lab Tests. Linux host CLI and canonical threaded release Web player were rebuilt. Full native/editor suites, Android and an actual tagged release publication were not rerun: no runtime/editor implementation or platform build wiring changed. Review used local Standards and #260 Spec axes because this harness has no subagent tool; the external real-qualification gap remains explicit.
