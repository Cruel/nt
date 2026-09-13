# Development example qualification

NovelTea development examples are authored in the public `Cruel/noveltea-examples` repository, but `nt` owns the exact revision that is allowed to become a development-site input. The pin is the single 40-character commit in `examples/noveltea-examples.revision`; CI never floats to examples `main` while building the site/toolchain contract.

## Qualification contract

The shared public examples repository owns `scripts/build-examples.mjs`. `nt` invokes that entrypoint only with explicit inputs:

- the exact pinned examples checkout;
- the Linux standalone CLI produced by the current `nt` Build run;
- the canonical threaded Web player template produced by that same Build run;
- the matching player descriptor; and
- an explicit output directory.

`scripts/qualify-examples.mjs` first requires the examples checkout to be clean and exactly at the pinned revision. The public build then validates both Projects, exports and round-trips each `.ntproject`, emits `.ntpkg` files, and stages the Web exports with the supplied player. Afterward, `nt` verifies that `catalog.json` names the pinned source revision and exact CLI/player digests and that all cataloged generated files still match their recorded sizes and SHA-256 values.

The Build workflow uploads the successful output once as `noveltea-development-examples`. Downstream site work should consume that artifact/catalog shape rather than rebuilding examples independently. A failed qualification job is the compatibility signal that a proposed pin must not merge.

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

`scripts/run-site.sh` calls this wrapper before starting Astro and exports `NOVELTEA_EXAMPLES_CATALOG_PATH` for the site. The current examples page does not consume the catalog until the showcase ticket lands, but local preparation already uses the production qualification contract and requires no Pages/R2 credentials.

The local threaded Web configure explicitly disables the optional local `rmlui-bgfx` override so an existing developer cache cannot silently change the qualified toolchain away from the canonical `nt` dependency graph.

## Verification

The contract-level tests are part of the CI test inventory:

```sh
node --test tests/ci/examples_qualification_tests.mjs
```

For the full integration seam, run the local qualification command above against a clean examples checkout at the pinned revision. A successful run proves the real CLI/project/package/player path rather than only validating manifest structure.
