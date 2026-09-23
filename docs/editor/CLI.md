# NovelTea CLI

NovelTea ships one public headless executable: `noveltea`. It is a scriptc-built standalone binary containing the shared TypeScript authoring/workspace implementation in an embedded QuickJS-ng island plus a narrow statically linked host/native tooling boundary. The editor invokes this same installed binary for native/headless operations; `noveltea-editor-tool` and a separately distributed bgfx `shaderc` executable are retired.

## Project discovery and direct editing

A project is identified by its root directory and `<project-root>/project.json`. Use `--project <project-directory>` to select a project explicitly. Without it, the CLI walks upward from the current directory and stops at the first `project.json`. A malformed NovelTea manifest, wrong workspace identity, or unsupported workspace version is a terminal discovery error at that directory; discovery does not fall through to a parent project or accept a retired monolithic project file.

Ordinary authoring is file-first: edit tracked JSON, Lua, RML, and RCSS directly. After direct edits to managed localizable Lua/RML source, run `noveltea localization sync` to materialize only deterministic Message-tracking changes, then run `noveltea validate`. Passive validation, source analysis, preview, and editor watching never write localization tracking. Do not route ordinary field changes through invented setter commands. The CLI owns operations that need project-wide semantics, transactions, native tooling, or reproducible automation.

## Public command surface

Core authoring commands are:

```text
noveltea project create <directory> --name <project-name>
noveltea project export --output <bundle.ntproject>
noveltea project import <bundle.ntproject> <destination-directory>
noveltea validate
noveltea localization sync [--dry-run]
noveltea localization reconcile [--apply]
noveltea localization view <locale> [--status <missing|current|outdated|needs-review|reviewed|human|ai|imported|unknown|attention>]
noveltea localization accept <locale> <message-id>... [--dry-run]
noveltea localization review <locale> <message-id>... [--dry-run]
noveltea usages <collection> <id>
noveltea asset audit
noveltea asset import <path>... [--dry-run]
noveltea entity create <collection> <id> [--dry-run]
noveltea entity rename <collection> <old-id> <new-id> [--dry-run] [--allow-possible-source-references]
noveltea entity delete <collection> <id> [--dry-run] [--force] [--allow-possible-source-references]
noveltea agent sync [--fix]
```

`project create` accepts a new destination path that does not exist, including paths containing spaces, and rejects every existing file, directory, or symlink. It assembles and validates the complete initial workspace in a sibling staging directory before atomic activation. The editor uses the same creation service and project defaults. Creation does not generate `.noveltea/agent/`; run `agent sync` afterward.

`project export` writes the current portable editable-Project artifact, `.ntproject`. The bundle is a deterministic ZIP with the current `noveltea.project.bundle` version-1 manifest, the canonical Project Workspace files, referenced Asset source bytes, and Project-owned `workflows/` files. It deliberately excludes `.noveltea/`, `dist/`, VCS metadata, `.gitignore`, agent bootstrap files, local/session state, transaction state, caches, and other files outside the current Project authoring contract. Export refuses an existing destination and fails if captured canonical source changes while the bundle is being prepared.

`project import` accepts only the current `.ntproject` contract and requires a destination that does not exist. The importer verifies the ZIP structure, safe normalized UTF-8 paths, regular-file entries, CRCs, manifest identity/version, exact sorted inventory, byte sizes, SHA-256 hashes, and the contained current Project Workspace before atomically activating the destination. Files outside the reconstructed Project-owned authoring inventory are rejected even when declared by the bundle manifest. The imported directory then opens and validates as an ordinary Project Workspace. `.ntproject` is editable-source transport only; Runtime Package `.ntpkg` behavior and contents are unchanged and remain runtime-only.

`localization sync` is the explicit mutation boundary for durable local Message identity discovered in free-form Lua and RML. Structured schema-owned Messages use their semantic owner/field identity directly and need no free-form occurrence sidecar. Sync preserves an existing ID only for deterministic one-to-one matches, assigns IDs to definitely new managed occurrences, updates compact source/structural/anchor fingerprints plus the managed occurrence source/guidance snapshot, and leaves ambiguous duplicate/many-to-many cases unresolved for reconciliation instead of guessing. `--dry-run` reports the same deterministic plan without writing tracked files.

`localization reconcile` is read-only by default and emits a deterministic reconciliation plan. The plan includes the expected Project workspace revision, a source/tracking fingerprint, ambiguity groups, current occurrences, recoverable prior/orphaned Messages, and whether valuable work requires an explicit choice. `localization reconcile --apply` reads one JSON object from stdin containing `expectedWorkspaceRevision`, `expectedFingerprint`, and a `resolutions` object mapping current occurrence IDs to either a prior Message ID or `"new"`. A prior Message ID can be used at most once, so direct-file duplication can never silently share a local Message identity. Valueless weak matches and many-to-many ambiguity default to independent new identities; valuable abandoned work moves to `orphanedMessages` and leaves live target locale chunks, while valueless stale bookkeeping is removed. Relinking an Orphaned Message restores its target translation/review/provenance work. Apply refuses stale plans and commits through the normal Project Workspace transaction writer.

`localization view` joins canonical source and one target locale into a work queue suitable for humans or agents. Each row reports source/guidance/usages, target content, Current/Outdated/Missing freshness, Human/AI/Imported/Unknown origin, Needs review/Reviewed state, optional provider/model provenance, and derived presentation/guidance attention. `--status` filters the joined view without changing canonical storage. `localization accept` advances the stored semantic source fingerprint for selected existing targets without changing their text, origin, or review state. `localization review` marks selected Current, structurally valid targets human-reviewed; Missing, Outdated, and invalid targets are rejected, and a failed bulk review writes nothing. Both mutations support `--dry-run` and use the normal Project Workspace transaction boundary.

`asset import` accepts one or more files. Files already under the Project `assets/` directory are registered in place; other files are copied into the normal kind-specific Asset directory. Re-importing an already registered Project Asset path returns the existing Asset instead of creating a duplicate. `--json` returns the Asset ID and source path plus image metadata when applicable. `asset audit` lists files under `assets/` that do not have Asset records. It uses the CLI's scoped read-only Project-preparation contract: only the current Project identity, Asset records and declared source routing, and the `assets/` filesystem inventory are loaded and validated. Malformed unrelated authoring domains therefore do not block an Asset audit, while current workspace identity, pending-transaction safety, Asset schema/path validity, and filesystem containment remain enforced. The inventory root must resolve inside the Project, directory cycles are rejected, and declared Asset source paths are checked for Project containment even outside the conventional `assets/` tree.

ComfyUI workflow discovery is available headlessly:

```text
noveltea comfyui status [--server <url>]
noveltea comfyui workflows [--all]
noveltea comfyui workflows <id>
noveltea comfyui verify [<id>] [--server <url>]
noveltea comfyui run [<workflow-id> | --type <classification>] [--input <name=value>]... [--output <routing>]... [--server <url>] [--force]
```

These commands use the same catalog, machine configuration, and verification cache as the editor workflow manager.
Built-in and shared-user workflows are available without a Project; when `--project` selects a Project or upward
discovery finds one, project-local workflows are added. Source precedence is `project > user > built-in` by logical
workflow ID. Bare listing returns only the effective workflow set. `--all` is diagnostic and also exposes overridden or
invalid package copies without changing precedence. Inspection reports the selected workflow's source, classification,
description, public inputs/outputs and authoring metadata, offline validation/runnability, package hash, and cached
verification state relevant to the configured server.

`comfyui status` is deliberately Project-independent and rejects global `--project`. It resolves one server for the
invocation as `--server`, then the shared user configuration, then `http://127.0.0.1:8000`, and reports connection,
ComfyUI version, and queue information without exposing arbitrary response bodies. `comfyui verify <id>` verifies one
effective workflow; omitting the ID verifies the active workflow set in the optional-Project context. Verification checks
the manifest-required node classes and every mapped node input against `/object_info`. CLI verification is diagnostic
only except for updating the disposable shared verification cache; it never repairs or rewrites packages.

`comfyui run` accepts either an explicit workflow ID or `--type <classification>`. `--type` resolves the logical
workflow ID from the shared user configuration and then applies normal `project > user > built-in` source precedence.
The two selection forms are mutually exclusive, and omitting both is invalid; NovelTea never guesses a classification or
silently falls back to the first workflow. A configured default that is unavailable remains configured and fails with a
targeted diagnostic. Classifications use the same extensible dotted namespace as workflow manifests, so future values do
not require a runner enum change. Repeated `--input name=value` arguments bind through the manifest's public contract;
values split on the first `=`, duplicate/unknown names are rejected, required/default/type semantics are checked before
network work, and one public input may drive every graph binding declared for it. Scalar inputs support string, integer,
number, and boolean values.
An `image` input accepts an explicitly named local file; relative paths resolve from the invocation working directory.
The image media handler enforces the 32 MiB source ceiling and decodes the file through NovelTea's shared/native image
inspection capability before upload.

Local image bytes are disclosed only to credential-free plain-HTTP servers addressed by a literal loopback IP (including
IPv4, IPv6 loopback, and admitted IPv4-mapped IPv6 forms). `localhost`, HTTPS, credentials, arbitrary hostnames, and
non-loopback addresses are rejected before any upload. Text-only status/verification/execution remains usable with
ordinary configured HTTP/HTTPS servers. Upload names are generated uniquely, preserve the validated media extension,
and do not expose the local basename. Online verification completes before upload; an upload failure aborts before
`/prompt` and NovelTea does not claim to roll back already accepted remote uploads.

Execution submits one uniquely identified prompt, polls HTTP history without a fixed whole-job timeout, waits for terminal
completion, and validates every declared named output before local publication. Output cardinality is exact: required
`one` produces exactly one image, required `many` one or more, optional `one` zero or one, and optional `many` zero or
more. Every downloaded image is bounded and media-validated before any local result becomes visible.

Each output has exactly one publication target. With a Project available, an output without an explicit route becomes a
normal NovelTea Asset in `assets/generated/`; every image from a `many` output becomes a separate Asset. Use repeated
`--output name=<path>` options to route selected outputs to the filesystem while leaving the others as Assets. Bare
`--output <path>` is shorthand only when the workflow declares exactly one named output. Without a Project, every
declared output must have an explicit named filesystem route before upload or prompt submission.

A cardinality-`one` filesystem route names a file. A cardinality-`many` route names a directory, and NovelTea creates
validated generated filenames beneath it. Missing parent directories are created during publication. Existing files fail
unless `--force` is supplied; `--force` applies only to explicit filesystem files and never changes collision-safe Asset
naming. File extensions must match returned image formats because NovelTea does not transcode.

Local publication is prepared as one result set only after all remote outputs are present and valid. Filesystem results
are staged with atomic rename/backup primitives, while all generated Asset records and bytes are committed in one normal
Project transaction based on a freshly reopened Project. If mixed publication fails, staged filesystem outputs are rolled
back as far as those primitives allow and no partial Asset transaction is intentionally committed. Publication failures
are reported explicitly as occurring after successful remote generation. Structured results remain keyed by logical
output ID: cardinality-`one` outputs return one metadata object or `null`, while cardinality-`many` outputs return arrays.

Ctrl-C installs an invocation-scoped cancellation handler. Once a prompt exists, NovelTea attempts to delete only that
prompt from the ComfyUI queue and returns conventional exit status 130; it does not call the global `/interrupt` endpoint
or clear unrelated jobs. Independent `comfyui run` invocations remain concurrent and use distinct client/prompt IDs.
With `--json`, execution still produces exactly one final compact envelope on stdout and no stderr output.

Built-in ComfyUI packages are embedded directly into the self-contained standalone executable. A relocated `noveltea`
therefore retains the built-in workflow catalog and execution contracts without Electron resources, sibling workflow
files, project-local JavaScript, Node, or Sharp. User and Project packages remain external mutable sources layered over
those embedded built-ins by normal `project > user > built-in` precedence.

Shared user packages live under `<NovelTea user config>/comfyui/workflows/`. The versioned
`noveltea.user-config` document at `<NovelTea user config>/config.json` owns durable user preferences,
shared ComfyUI settings, and shared export configuration. Its ComfyUI section contains the server URL,
per-request timeout, and logical default-workflow mappings keyed by arbitrary valid dotted classifications;
editor enablement and periodic connection-check cadence live in the preferences section rather than the
ComfyUI machine-settings section. `NOVELTEA_USER_CONFIG_ROOT` therefore provides hermetic user configuration,
workflow, and cache storage for CI. An invocation `--server` override is ephemeral and does not rewrite the
shared configuration.

The editor's Generate Image and Edit Image surfaces are thin Project-session adapters over this same execution core.
They use the same catalog/default resolution, verification, public bindings, HTTP history polling, prompt-specific
cancellation, image validation, and publication preparation. Edit Image first reads the selected source Asset through
editor-owned Project authority, then hands a private temporary local image to the shared secure media handler. Therefore
`localhost` is not an editor exception: use a literal loopback server such as `http://127.0.0.1:<port>` when local image
bytes must be uploaded. The workflow manager retains image-specific automatic inference, while its strict current manual
manifest editor can author or repair arbitrary named generic contracts and future classifications.

## Resident daemon lifecycle

The standalone executable contains a native per-user daemon broker. The broker is keyed by the exact NovelTea build identity plus the independently versioned Daemon Protocol compatibility boundary. While NovelTea is unreleased that boundary remains development version `1`; incompatible development changes replace V1 atomically rather than incrementing it. Different build/protocol identities use different endpoints and may coexist. Linux uses a user-private Unix-domain socket under the platform runtime directory when suitable, with a private NovelTea fallback directory; the runtime directory is restricted to the current user and the socket is mode `0600`. Windows uses a named pipe whose ACL grants access only to the current user. The same `noveltea` executable launches the private daemon mode; NovelTea does not install an operating-system service.

The native broker begins listening before any QuickJS worker is started. The broker process itself does not host an authoring island: QuickJS exists only in dedicated Project-owner workers, one-job disposable workers, or the explicit local no-daemon fallback. Its externally visible lifecycle states are `starting`, `ready`, `draining`, and `stopped`; clients may connect and queue while it is `starting`. Startup is arbitrated per user/build/protocol so concurrent cold callers converge on one daemon. Stale Unix endpoints are removed only while holding startup ownership and after independently proving the daemon lifetime lock is unowned; a failed connection alone never authorizes endpoint deletion.

IPC uses bounded length-prefixed JSON frames shared by the Unix-socket and named-pipe transports. Requests carry request IDs, and the protocol admits stdout, stderr, progress, cancellation, and one final result event. Commands declared as streamed deliver their human stdout, stderr, and progress frames incrementally instead of replaying them only with the final result; JSON mode retains machine-readable output without injected human progress text. After the broker reaches `ready`, existing-Project reads and Project-affecting mutations are assigned to a dedicated long-lived ScriptC owner process for that canonical physical Project root, including opaque writes when a Project is explicitly named or discoverable. Project-independent QuickJS work is assigned to a one-job disposable worker and never executes inside the broker process. Each owner embeds its own QuickJS runtime, so unrelated active Projects do not serialize semantic work through one island. Caller cwd, environment, stdin when required, terminal metadata (TTY state plus terminal columns/rows when available), output mode, and replay-safety declaration travel with each request and are passed into the shared CLI command context. A single lightweight command-routing contract is evaluated before authoring initialization and declares static/native completion eligibility, one of the production daemon execution classes (`owner-short`, `owner-mutation`, or `disposable-heavy`) for a static miss, whether a static miss needs QuickJS, whether an existing Project is required, Project access/effect (`none`, read, transactional write, or opaque write), replay safety, stdin needs, and streamed-event/cancellation requirements. Bootstrap validation, standalone daemon dispatch, and resident Project handling all consume that contract rather than maintaining command-name routing tables. There is no `direct` resident execution class or shared broker QuickJS lane. The shared CLI receives cwd explicitly per request, and each ScriptC process applies caller environment only for the lifetime of that request, so caller context cannot leak across requests. The broker rejects new work during graceful drain, requests cancellation of queued or active work, retains daemon lifetime ownership until active requests settle, and does not complete shutdown while a registered Project transaction critical section is active. Project-owner idle eviction defaults to approximately five minutes and whole-daemon inactivity to approximately ten minutes; active or transaction-critical work is never treated as daemon inactivity. These are internal engineering defaults, not public user settings.

Heavy authored-Test preparation, Project-backed ComfyUI generation, portable Project export, shader compilation, and output-producing Runtime Package/platform publication use the `disposable-heavy` daemon execution class. Complete native runtime/Test-cache hits still finish in the calling process before daemon dispatch. On a heavy miss/request, the Project owner performs only the short authoritative reconciliation/preparation pass and publishes the exact resident generation as an opaque portable snapshot. Native scheduling pins that `(session epoch, generation)` while the owner remains free to reconcile newer edits and service short reads or mutations. A warm unassigned ScriptC disposable worker receives only the generic pinned snapshot plus the small original command descriptor; it hydrates its immutable Project view directly from those bytes and never consumes owner-only authority/reconciliation metadata or reopens authored Project source files. Portable Project export retains its stricter bundle rule: its final source/Asset revision checks can reject publication if physical inputs change after the captured generation. Owner replacement is a separate path that combines the portable snapshot with the retained native authority metadata and then re-proves disk before resuming ownership. Large external Asset payloads stay file-backed in that snapshot and carry their expected physical identity, byte size, and exact mtime (or fallback content hash). Output workers write to temporary/staging destinations and re-check those pinned Asset expectations immediately before publication. Runtime Package and multi-artifact platform activation then use broker-registered recovery records that describe staging, previous-output backups, final paths, and acceptance. If a disposable process is terminated between rename steps, broker cleanup deterministically restores the previous complete set unless acceptance was already recorded, in which case it keeps the verified new set and removes recovery debris. Project-backed ComfyUI likewise keeps remote generation in the disposable worker and returns immutable staged Asset results to the live Project owner; only that owner re-proves authority and commits the authored Project transaction. For mixed filesystem-plus-Asset results, the prepared filesystem transaction is transferred with that owner mutation. The broker activates the staged filesystem set while the journal is still rollback-capable, then lets the live owner perform the authoritative Project mutation; owner success records filesystem acceptance and removes recovery debris, while owner rejection or loss rolls the filesystem set back. Final mixed acceptance is therefore coordinated outside the disposable worker rather than left to a post-commit JavaScript `finally`. The disposable worker does not re-admit live Project state after that owner commit. Asset drift, cancellation, command failure, or worker failure therefore cannot make a partial/stale result appear as an accepted publication. Disposable workers execute exactly one heavy job and retire.

The portable resident snapshot and the separate owner-rehydration metadata are RAM-only documents
nested inside the exact daemon build/Daemon Protocol identity. They have no independent numeric
snapshot version or compatibility epoch. Producers and consumers move atomically with the daemon
build, validate the complete current document shape, and reject incompatible retained RAM state rather
than migrating, aliasing, or accepting a legacy shape. This is distinct from the public portable
`.ntproject` bundle compatibility boundary.

Project owners, disposable jobs, and warm standbys share one internal hard ScriptC-process admission budget. Starting and retiring workers continue to consume that budget until the child process has physically exited. Existing active owners and foreground Project admission/short owner work have priority over queued heavy work. A new Project uses free capacity when available; under pressure the scheduler may retire an inactive owner, but it never evicts an actively used owner merely to admit another Project. If no safe capacity exists, Project admission queues rather than spawning past the bound. The canonical Project-root reservation remains attached to a retiring owner until that process has exited, preventing replacement admission from creating two physically live owners for one Project. When capacity permits, the daemon keeps at least one warm unassigned disposable worker; consuming it triggers replenishment through the same global budget, and excess idle standbys expire back toward the baseline. Cooperative cancellation is attempted first, after which native scheduling may terminate only the disposable process; a disposable crash likewise fails only its request, releases the generation pin, and replenishes standby capacity without replacing the Project owner or daemon broker. `platform export --check` remains an owner-short, write-free preflight rather than disposable publication work. `daemon status` may expose additive engineering diagnostics for owners, disposable workers, queues, and current process occupancy in addition to its stable core fields. The admission bound and worker counts remain internal policy rather than user-configurable settings.

Read-only commands that need an existing authoring Project use a daemon-resident disk-authoritative Project session inside that Project's dedicated owner worker, keyed by the Project's canonical physical root. Logical aliases and symlinks therefore converge on one owner and one semantic authority while command-visible paths remain relative to the caller's logical Project root. A resident session retains the last coherent immutable Project generation together with the in-memory parsed source, validation, dependency/source-analysis state, and indexes needed for change-scoped work. Those semantic products are RAM-only owner state; they are not authoring-cache persistence artifacts. Resident generations have a process-local session epoch plus monotonic generation counter; the identity advances without deriving a new whole-Project token. Physical freshness comes from the broker's native Project-authority observation: native code owns conservative source discovery/watcher recovery and returns compact added/changed/removed paths, while the owning QuickJS runtime consumes only that delta for ordinary reconciliation instead of independently enumerating the Project. While an owner is otherwise idle, native watcher dirtiness causes the owner to reconcile its resident session; only a real semantic delta or invalid changed generation refreshes the owner activity clock, so watcher noise cannot keep an owner alive indefinitely. Existing-source edits build a separate candidate generation from the coherent base, reread and parse only changed sources, invalidate the affected semantic dependency closure, prove the physical generation again, and promote atomically. Unchanged record/source state is structurally shared rather than cloned or canonically reprojected; source-revision state advances from the changed source set instead of sorting/stringifying the complete source inventory. Stable existing-source mutations also retain canonical source membership, save-unit ownership, script routing, validation indexes, Lua/source descriptor indexes, and analyzed dependency state, replacing only the affected entries; source/routing membership changes conservatively widen to reconstruction. Localization/font-coverage preparation carries the revision identity of the latest coverage-relevant generation, so a later presentation-only edit cannot make a product from before an intervening Message/locale/font/semantic change eligible again. Structural source-set changes such as additions or deletions conservatively widen reconciliation. If disk changes race candidate construction, the final native proof discards the candidate and retries from the coherent base; if a post-command proof consumes a native delta, the resident owner retains that delta for the retry so the advanced native manifest cannot hide stale semantic state. External Asset payload deltas are retained independently from semantic-source deltas for the same reason: even when a final read proof is the first operation to consume one, the owner must advance to a distinct authority generation before publishing another portable snapshot, so refreshed file-backed Asset expectations can never be attached to an already-published generation identity. The owner retains external Asset source-path membership as an indexed set and checks compact native deltas against that set directly; ordinary proofs do not rebuild a QuickJS Set proportional to total Asset count. Transactional mutations use the same owner boundary: the owner first proves that no new semantic delta appeared after mutation admission, constructs and semantically admits the exact projected generation before publication, commits through the normal Project transaction writer, then requires native authority plus exact changed-file revisions to prove that committed generation before promotion. A transaction failure or failed post-write proof never promotes the candidate or evicts the coherent owner; any committed-but-unproven disk delta remains pending for ordinary reconciliation, while a source race before commit returns an explicit revision conflict. Owner processes are evicted only while inactive, using an internal idle cutoff plus a bounded resident-worker pressure policy; eviction stops watcher coverage and the worker cleanly. The broker may retain the owner's latest portable snapshot and exact validation result under independent byte-bounded RAM policies; eviction discards acceleration only, and native authority retained solely for an evicted exact result is released unless a portable snapshot still requires its checkpoint. An unexpected owner-process exit fails only that Project's in-flight request, leaves the broker and other Project owners alive, and lets the next request rehydrate or cold-admit that Project. Malformed current disk state is retained as an invalid overlay over the last coherent generation, allowing a later correction to resume from that coherent base rather than reopening cold. Read commands may declare the semantic Project paths they require; an invalid overlay outside that dependency domain can continue against the coherent generation, while an invalid required source still blocks with its normal diagnostic. Scoped Project-preparation commands keep their narrow direct loading boundary but now capture resident physical authority before preparation and perform the same bounded final authority proof/retry before exposing a result. Portable Project export consumes the resident Project snapshot, while its existing exact source-revision check remains the final publication authority for the archive.

`noveltea daemon status` and `noveltea daemon stop` are static/native diagnostics and do not require QuickJS. There is intentionally no public `daemon start`; the native broker exposes private startup arbitration to the standalone dispatch layer instead of requiring user-managed service startup. `noveltea --json daemon status` guarantees the stable core `running`, `state`, `build`, `protocol`, and `pid`; additional diagnostics may evolve. `daemon stop` is idempotent and performs graceful drain when a compatible daemon is running. For ordinary standalone invocations, complete static/native answers still win first; otherwise the client forwards to the compatible resident daemon by default. `--no-daemon` and `NOVELTEA_NO_DAEMON=1` keep the same static/native fast paths but force any remaining work through the canonical local QuickJS path. Failure to establish daemon acceleration within the bounded startup window falls back locally. Both resident and local QuickJS execution receive cooperative Ctrl+C/termination cancellation so a correctness-preserving fallback can perform command-specific cleanup before returning the interrupted result. A mid-request daemon failure is replayed locally only for requests declared read-only/idempotent; side-effecting requests fail rather than risk duplicate effects.

Native functionality is exposed through the same executable for shader compilation, raw bgfx-compatible `noveltea shaderc ...` forwarding, raw bimg-compatible `noveltea texturec ...` forwarding, headless test/UI-test playback, and package export. `test run <test-id>` executes one authored Test, while bare `test run` executes the whole lowered authored suite through the shared native suite operation. Both reuse the disposable Project-local canonical runtime cache when its relevant persisted inputs, declared Asset sources, compiler identity, and runtime schema identities still match. The same generation also carries a lowered authored-test catalog with independent Test-source freshness, so a Test-only change can republish the catalog without rerunning canonical runtime preparation. Runnable catalog entries contain the native runner kind and lowered playback spec; blocked entries contain readiness diagnostics. Explicit single-test execution of a blocked entry fails because the requested Test did not run; suite execution records it as `blocked` without executing it and does not fail solely for blocked entries. Blocked and infrastructure-error suite entries preserve and surface their actionable readiness/execution diagnostics rather than replacing them with generic status text. Any `failed` or `error` suite entry makes the command exit nonzero; an empty or blocked-only suite succeeds. Suite JSON output preserves deterministic counts and ordered per-test `passed`/`failed`/`blocked`/`error` results, including complete playback reports for executed tests. In `--json` mode the command also includes a `runtimeCache` observation with runtime `status` (`hit`, `miss`, `stale`, or `unusable`) and reason plus `testCatalogStatus`/`testCatalogReason` when runtime reuse reached the catalog boundary; normal human output stays concise and silent about routine cache behavior. Cache persistence is never a prerequisite for playback. The cache is machine-local disposable build state: it is excluded from portable Project export, is not a cross-machine/cross-build compatibility artifact, and requires no user-facing clean or recovery workflow because incompatible or corrupt state simply falls back to canonical preparation. On the standalone ScriptC executable, the static host can conservatively admit a fresh canonical cache generation and execute all four test forms (`test run <id>`, bare `test run`, `test run-spec`, and `test run-ui-spec`) directly through native tooling without importing the QuickJS island. Authored single/suite execution requires both a fresh runtime artifact and Test catalog; stdin `run-spec`/`run-ui-spec` require only the runtime artifact, so Test-only staleness does not force QuickJS startup. The native probe validates cache identity, exact tracked-source mtime/size freshness, conservative source discovery, and artifact/catalog digests but does not parse authored Project/Test schema or hash authored source bytes during ordinary admission. A runtime miss, stale/unusable state, or conservative discovery uncertainty enters the resident daemon's disposable-heavy path when daemon acceleration is enabled: the owner reconciles and snapshots, then a generation-pinned one-job worker performs canonical preparation/playback. In that worker, cache admission is evaluated against the physical metadata carried by the pinned Project generation rather than newer live-disk metadata; publication is declined without failing the command when live disk no longer matches the pinned inputs. `--no-daemon` retains the canonical local-island fallback. If native execution rejects an admitted cached payload, the host explicitly forces one canonical rebuild/retry through that fallback while leaving the published current generation intact until a replacement generation publishes successfully. Runtime Package export accepts `--allow-localization-warnings` as the explicit unattended acknowledgement for localization quality warnings, plus `--include-unused-assets` and `--include-shader-sources` as developer overrides of the normal pruning/source-stripping policy. The localization override is scoped: it does not bypass technical export errors. `noveltea --help` is authoritative for the installed version's exact syntax.

Platform publication is a separate command family from Runtime Package creation:

```text
noveltea platform profiles
noveltea platform export --output <path> [--profile <id>] [--template <id>@<build>]
                         [--signing-profile <id>] [--config <file>] [--sign]
                         [--allow-localization-warnings]
                         [--include-unused-assets] [--include-shader-sources]
                         [--check] [--force]
                         [--allow-untrusted-template] [--allow-identity-change]
noveltea platform template list
noveltea platform template inspect <id>@<build>
noveltea platform template install <archive> [--force]
noveltea platform template remove <id>@<build> --force
noveltea platform config init <path> [--force]
```

`platform profiles` prints the exact profile IDs accepted by `platform export`. The read-only query uses scoped Project preparation: it validates only Project identity plus export/profile settings, so malformed unrelated gameplay, localization, Project settings, or other authoring domains do not block profile inspection. Projects do not
store a selected platform profile. Omitting `--profile` is accepted only when exactly one platform
profile exists; when multiple profiles exist, pass `--profile <id>` explicitly. Template and config
commands are installation-scoped and reject global `--project`; profiles and export use normal
project discovery. Template identities use the exact copyable `<template-id>@<build-id>` form.
Automatic resolution succeeds only when exactly one compatible installed template exists.

`platform export --check` is write-free and evaluates the same profile, template, configuration,
identity acknowledgement, and output-collision policy as publication. Existing export-owned
artifacts require `--force`; symlink artifact paths are always refused. Locally sourced templates
require `--allow-untrusted-template`. Human mode reports progress on stderr and the final result on
stdout; `--json` preserves the single compact final-envelope contract without progress events.

Platform export produces the normal packaged artifact by default. The editor-created profile is the
portable target recipe; output path, installed-template choice, and signing identity are execution
choices. `--signing-profile <id>` selects a reusable signing configuration from the shared NovelTea
user export config and implies signing. Bare `--sign` is accepted when exactly one signing
configuration exists for the selected target; otherwise the CLI requires an explicit ID. Results
report whether signing was requested and applied. Publication/store upload is not supported.

Localization quality warnings block unattended Runtime Package and platform publication unless
`--allow-localization-warnings` is supplied. That flag acknowledges only localization quality
warnings for the current export; technical validation, package, template, signing, and staging errors
remain blocking. Unused assets are excluded by default using the same authoring dependency graph as
the editor. `--include-unused-assets` disables that pruning for diagnostic/developer exports, and
`--include-shader-sources` preserves authored shader sources that normal runtime packaging strips.
The latter two are the headless equivalents of the Export pane's Developer Mode options.

The editor and CLI share reusable machine-level state beneath the NovelTea user configuration root. Durable preferences,
export configuration, and shared ComfyUI configuration are sections of `~/.noveltea/config.json`; user ComfyUI workflows
and the disposable verification cache are under `~/.noveltea/comfyui/`.
Export configuration contains toolchain paths plus named Windows, macOS, and Android signing configurations. Signing
secrets remain explicit `env:NAME` references. `NOVELTEA_USER_CONFIG_ROOT` provides a hermetic override for the shared
NovelTea user-config directory, including both export and ComfyUI catalog state, in CI. The optional `--config` file continues to use the
`noveltea.editor-export-local-state` contract as an explicit per-command override; generate a safe,
secret-free skeleton with `platform config init`. `--config` does not combine with
`--signing-profile`.

The editor and CLI also share the per-user template registry at `~/.noveltea/templates`;
`NOVELTEA_TEMPLATE_REGISTRY_ROOT` provides a hermetic override for CI.

The Node reference/editor-hosted command and Linux x64 and Windows x64 standalone scriptc
commands are implemented. The public standalone CLI archive keeps the certified scriptc host together
with any native support executables and system assets required by its command surface. Every standalone
host binary remains subject to the cross-host certification gate in `SCRIPTC_COMPATIBILITY.md`.

The standalone release keeps operating-system/native capabilities in a small statically compiled scriptc host and executes the shared authoring application in the embedded QuickJS-ng island. Stdin and process-liveness checks cross the host boundary explicitly; shader/runtime/package operations and image inspection cross the existing NovelTea native boundary. `agent sync` embeds the checked-in agent-kit source texts as build-time package data, and built-in ComfyUI manifests/API workflows are likewise embedded as immutable build-time package data. The release certification runs Node-reference-versus-ScriptC ComfyUI operations against a deterministic local fake server and separately proves relocated built-in discovery. See `SCRIPTC_COMPATIBILITY.md` for admitted host assumptions, including current OS-signal limitations.

Rename/delete use the shared dependency graph and source recognizers. Proven rewriteable source ranges may be changed transactionally; exact manual references block unsafe rename; possible lexical references require explicit acknowledgement; delete's `--force` handling of exact blockers is independent from possible-source acknowledgement. `--dry-run` performs discovery, assembly, validation/preflight, graph/source analysis, and projected transaction planning without changing tracked or ignored project files.

## Persistent validation cache

`validate` can reuse an unchanged exact disk-authoritative validation result from
`.noveltea/cache/authoring/current.json`. This is deliberately a narrow restart accelerator, not a
persisted semantic Project generation. The strict current contract contains only the Project root,
the exact validation semantic key, the physical source/discovery manifest, and the structured
validation result. It persists no parsed source, validation-check contribution, dependency graph,
source-analysis product, portable Project snapshot, or resident generation identity. The cache has no
independent compatibility version or migration path; an incompatible current shape is simply ignored.

The semantic key explicitly binds every non-Project input that can affect validation: NovelTea/CLI
build identity, Workspace and authoring schema identities, compiler/runtime identity, and the current
validation profile/options/configuration contract. Project-controlled validation settings remain
covered by the physical Project authority itself. A result is reusable only when both that semantic
key and the exact physical authority match.

Freshness uses the shared Project source-inventory mechanism also used by the runtime/Test cache:
native physical file identity, exact byte size, and nanosecond mtime for canonical Workspace files
(including Tests and editor state), declared Asset sources, and conservative candidates under
`records/`, `scripts/`, and `i18n/`. Ordinary hits do not reread/hash authored source bytes. Unrelated
README files do not invalidate. Pending transaction state prevents admission/publication. A same-path
replacement with restored size/mtime is still rejected because its physical file identity changed.

Standalone root-level or explicit-Project hits run entirely in the static/native tier, before QuickJS.
The native probe shares metadata/discovery machinery with runtime-cache admission, verifies the
current contract and semantic key, and returns diagnostics rather than implementing validation.
Upward discovery, missing/stale/corrupt/incompatible state, unsafe paths, unavailable exact metadata,
and other uncertainty use normal TypeScript validation. Publication is best-effort; unwritable cache
state never changes freshly computed diagnostics. Native tooling failures are not memoized.

Cached semantic errors, warnings, informational findings, locations, ordering, exit status, and human
or JSON formatting retain ordinary validation semantics. There is no stale-generation partial semantic
reuse path: a persistent exact miss enters canonical cold admission, while a live Project owner uses
its RAM-resident incremental state. The daemon separately retains the latest exact validation result in
native memory together with the exact native authority checkpoint that produced it. A retained result
contains caller-independent structured validation data rather than already formatted output; the
short-lived caller formats it with that invocation's logical Project root, so aliases may share one
physical cache identity without leaking another caller's path. Every retained exact-result candidate,
including one associated with a live owner, performs a fresh native batched physical observation and
must exactly match its checkpoint before reuse. Watcher delivery can revoke or accelerate a proof but
is never sufficient authority for a hit. Ownerless hits suspend watcher coverage again after the proof;
an active owner may use the native hit only while it has no queued/active/reconciling or
transaction-critical work, so the fast path never overtakes owner serialization. Retained exact results
and their otherwise-unneeded dormant native authority are independently byte-bounded and LRU-evictable;
eviction affects performance only.

Non-resident validation captures source/Asset authority before semantic validation, verifies that
source discovery contains no files outside the assembled snapshot and declared Assets, and preserves
that baseline (including physical file identity) through publication. Later discovery must not attach
new, unvalidated records to an old result. A changed baseline skips cache publication.

After foreground validation is correct, optional exact-result publication is generation-tagged and
best-effort. The TypeScript clean-editor/no-daemon producer starts publication without awaiting it; the
resident daemon coalesces pending native publications and dispatches them only from its idle
maintenance path after a short foreground quiet period. The filesystem write then runs as an
unjoined self-contained best-effort task, so
graceful drain and process termination never wait for optional persistence. Publication writes a
private temporary file and atomically replaces `current.json` only after the new document is complete;
process exit may therefore abandon an incomplete temporary file without damaging the previous valid
cache. Foreground owner work never serializes or writes a semantic cache generation. Corrupt, stale,
incompatible, missing, unsafe, or unwritable persistent state changes only performance and falls back
to canonical resident/cold semantics.
The daemon may create the missing `.noveltea/cache/authoring` directory hierarchy for this optional
publication, but it refuses symlink or non-directory path components rather than following them.
`NOVELTEA_CLI_TRACE=1` exposes standalone admission/fallback and island-import traces without adding
routine cache fields to validation output; `NOVELTEA_CLI_VALIDATION_PROFILE=1` is an
engineering/certification-only trace that emits phase timings and useful-work counts on stderr and does
not alter normal validation output. `NOVELTEA_CLI_SCHEDULER_PROFILE=1` is the corresponding opt-in
resident-scheduler diagnostic surface. It emits one machine-readable `[scheduler-profile]` record for
daemon-routed commands, including the routing class, owner/exact-result/snapshot reuse, changed-path
and native physical-observation counts, generation promotion, worker spawn/queue/retirement deltas,
native boundary calls, retained snapshot bytes, and engineering-only owner/disposable process IDs.
Disposable workers additionally emit `[worker-profile]` with pinned-snapshot read bytes and elapsed
time. These records are stderr diagnostics only when explicitly enabled; normal public human/JSON
output and `daemon status` remain unchanged.
Clean saved editor validation uses this same disk-authoritative `validate` path, so an eligible editor
validation may consume or publish the same exact result used by later CLI validation. The renderer marks
validation session-local whenever Project content, draft state, or pending field input is dirty. The
main process independently requires a coherent active Workspace whose persisted Project content matches
the submitted Project, then captures the exact physical source inventory represented by that Workspace.
The shared CLI/cache path may consume or publish only that captured authority; a physical source change
before admission falls back to session-local validation instead of displaying diagnostics for a newer
disk state. A mismatched or unreconciled save therefore validates in memory only; the previous clean
exact result continues to describe disk until the active Workspace has reconciled the saved physical
state. The cache retains the rich editor diagnostic form, including owner/navigation
metadata, while the public CLI JSON envelope continues to expose its stable CLI diagnostic projection.
Unsaved editor drafts never publish to the persistent authoring cache. The cache is disposable and
excluded from portable Project bundles.

## Machine-readable protocol

Use `--json` on NovelTea command surfaces that support the structured protocol. Expected success and failure produce exactly one compact JSON object followed by one LF on stdout and keep stderr empty. The envelope includes `success`, `exitCode`, and deterministic `diagnostics`; source-aware diagnostics carry stable paths/codes and source locations when available.

Exit categories are:

```text
0   success
2   CLI usage
3   workspace/discovery
4   semantic/preflight
5   mutation/concurrency
6   native shader/tool failure
70  unexpected internal failure
130 interrupted by SIGINT during an active CLI operation
```

Raw `noveltea shaderc ...` intentionally preserves bgfx shaderc's argument/output/return-code behavior rather than wrapping it in NovelTea's JSON taxonomy.

Raw `noveltea texturec ...` preserves bimg texturec's argument/output/return-code behavior and supports the upstream bimg texture formats and conversion options.

## Concurrency and transactions

Non-dry-run structural operations write through the same workspace transaction service as editor structural mutations. NovelTea writers use the project writer lock and exact target revisions; stale or concurrent changes fail closed rather than overwrite. A pending transaction needing recovery also causes a dry run to fail rather than mutate recovery state.

The CLI does not require Electron or an open editor. If an editor is open, its workspace watcher observes the committed source-tree result and reconciles it using the normal external-change rules documented in `project/PROJECT_EXTERNAL_CHANGES_AND_CONFLICTS.md`.

## Build and release

The exact scriptc version and native ABI are pinned and certified against the Node reference
implementation. Tagged releases publish `noveltea-<tag>-linux-x64.tar.gz` and
`noveltea-<tag>-windows-x64.zip`, include both in `SHA256SUMS`, and attest their build provenance.
Each archive contains the certified `noveltea` host plus the native UI-test runner and system assets
needed by `run-ui-test`; host editors embed the same certified native-tool closure. Release packages
contain no TypeScript source, first-party source maps, Node installation, sibling shaderc binary, or
retired editor helper. See `SCRIPTC_COMPATIBILITY.md` and `BUILD_AND_DISTRIBUTION.md`.
