# Development toolchain snapshots

Successful **push** runs of the complete `Build` workflow on `Cruel/nt` `master` trigger
`development-snapshot.yml`. PRs, manual Build dispatches, failed runs, and other branches do not
publish. The publisher downloads the Linux x64 standalone CLI and canonical threaded release Web
player template from that exact Actions run, checks out its exact commit, and performs no compilation.
Normal Web CI builds `web-release` and packages it with the existing Web template packager. The editor
preview remains a separate artifact.

## Storage and consumer contract

Storage uses the existing `noveltea-artifacts` R2 bucket and `https://assets.noveltea.dev` origin.
The sole writer uses `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from Actions. It uses the
[R2 REST object API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/)
with the same raw upload and HTTP metadata headers as Wrangler; no S3 credentials or new dependency
are needed.

All keys are under `development/toolchains/`:

- `current.json`: the mutable `noveltea.development-toolchain-pointer`, with exact revision, Build
  run number, manifest key/size/SHA-256, and recently retired revision retention records.
- `<40-character-commit>/snapshot.json`: immutable `noveltea.development-toolchain` metadata,
  including source revision, original Build run number/creation time, product version, exact player
  build identity, compatibility values, and each artifact's key, size, and SHA-256.
- `<commit>/noveltea-linux-x64`: the certified standalone CLI; consumers must restore executable mode.
- `<commit>/player-web-wasm32-threads-release.zip`: the installable Web player template, including
  its notices and SBOM. Template engine/build identity uses `dev-<commit>`.
- `<commit>/template.json`: the matching player descriptor, checked against the descriptor in the ZIP.

Resolve keys relative to the public asset origin. Fetch current once, verify its manifest digest and
size, then pin that revision and verify artifact digests and sizes before executing/installing them.
Do not repeatedly resolve current during one example build. The CLI reports the ordinary product
version; the same-run artifact provenance plus SHA-256 provides its exact revision identity.
Compatibility metadata records CLI JSON Protocol, Player Template Format, Compiled Project Format,
and Player Runtime API from the actual CLI response and template descriptor. These remain the
inventoried current V1 development boundaries. Snapshot reports/pointers have strict discriminators
and exact revision identity, not an additional compatibility epoch.

The ZIP is a template for `noveltea platform template install` and subsequent export; it is not an
already exported game. Threaded exported games require COOP/COEP and compatible resource headers at
the serving site. Publication does not configure site headers or bucket-wide CORS.

## Atomic publication and retries

Publication and cleanup share the non-cancelling `development-toolchain-publication` concurrency
group with `queue: max`, so waiting successful runs are queued instead of replacing each other.
GitHub admits up to 100 waiting publishers; if that queue fills, rerun canceled publication runs after
it drains. See [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
All writers must use that workflow; no out-of-band writer may mutate this namespace.
Each missing immutable object is uploaded and read back for exact-byte verification; conflicting
existing bytes cause failure. `snapshot.json` is written last within the immutable directory, then
`current.json` is replaced in one R2 PUT only after the full snapshot verifies. Current uses
`Cache-Control: no-store`; immutable objects use a seven-day cache lifetime. The public domain must
honor origin cache headers rather than apply a cache-everything override to current.

An interrupted upload leaves the previous current untouched. Rerunning the publication workflow
resumes identical partial uploads. A new build of the same commit producing different bytes is
rejected rather than overwriting the snapshot. Older Build run numbers cannot move current backward,
including when Actions schedules completed runs out of order. Such older runs still publish their
immutable artifacts but do not promote current or run cleanup. Retry the failed **publication** run
for transient storage errors; this reuses its original successful Build artifacts.

## Retention

Cleanup runs after successful promotion, within the same serialized job. It only considers exact
40-character commit directories in this namespace. Current is always protected. A former current
gets seven days from retirement (even if it was current for months), recorded in the pointer before
cleanup. Any directory with an object uploaded in the last seven days is also protected. Older
complete snapshots and abandoned partial uploads are deleted. Invalid timestamps are retained;
malformed pointers or incomplete listings fail closed. Other bucket namespaces are untouched.

A cleanup failure does not invalidate an already promoted snapshot; rerunning publication retries
cleanup. With no successful new publications, storage remains retained. These are temporary
artifacts, not permanent releases; consumers needing longer retention must copy a verified snapshot.

## Verification

Run the publication contract and R2 HTTP transport tests without credentials:

```sh
node --test tests/ci/development_snapshot_tests.mjs tests/ci/development_snapshot_r2_tests.mjs
```

To validate real artifacts without storage writes, place the two same-run Actions artifacts in
`build/snapshot-input/cli/` and `build/snapshot-input/player/`, check out the matching commit, and run:

```sh
GITHUB_EVENT_PATH=/path/to/workflow-run-event.json node .github/publish-development-snapshot.mjs --dry-run
```

The event must describe a successful master push Build run. The command validates the CLI version,
embedded ZIP descriptor, exact revision and current compatibility, and writes the reviewable manifest
to `build/development-snapshot/snapshot.json`. CI runs this dry run before using storage credentials.
