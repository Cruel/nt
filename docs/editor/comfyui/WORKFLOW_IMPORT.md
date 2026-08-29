# ComfyUI Workflow Library and Import

NovelTea imports ComfyUI API workflow exports and writes generic workflow manifests whose public input and output IDs
form the automation contract. Workflow packages are managed from the editor-owned `ComfyUI Workflows` workbench tab,
not from Project Settings.

## Workflow Sources

The workflow catalog discovers packages from three sources:

- built-in workflows shipped with NovelTea;
- shared user workflows under `<NovelTea user config>/comfyui/workflows/`;
- project-local workflows under the saved project's `workflows/` directory.

The editor/Node reference reads the checked-in built-in package assets. Release builds embed those exact manifest and API-workflow texts into the self-contained ScriptC executable, so a relocated CLI retains built-in discovery, inspection, verification, execution, and copy-out behavior without Electron resources or sibling workflow files.

The NovelTea user configuration root is `~/.noveltea` by default and honors `NOVELTEA_USER_CONFIG_ROOT`, including in
headless CLI and CI usage. The editor and CLI therefore consume the same shared user workflow directory rather than an
Electron application-data workflow directory. `<NovelTea user config>/config.json` is the versioned
`noveltea.comfyui-user-config` version 1 machine configuration. It owns the ComfyUI server URL, per-request timeout, and
logical default-workflow mappings keyed by extensible dotted classifications. The current V1 shape has no singular
default-workflow alias. Editor enablement and periodic connection-check cadence remain editor-local preferences and are
deliberately absent from the shared document. Global Settings derives the classification list from the active catalog,
shows friendly labels for `image.generate` and `image.edit`, and shows the dotted ID for other classifications. A configured
workflow ID that is currently unavailable stays selected and is visibly marked unavailable rather than being rewritten.

Project workflows are contextual. The editor includes them when an active saved Project session exists. The CLI includes
them when `--project` selects a valid Project or upward `project.json` discovery succeeds; absence of a Project does not
prevent built-in or shared-user listing and inspection. Renderer code may retain the Project file path as UI context, but
it does not send that path across the privileged IPC boundary: main derives the canonical Project root and `project.json`
from the current `projectSessionId`. The editor's Generate Image and Edit Image conveniences require an active saved
Project session because they publish revision files beneath that Project, but their verification, public-input binding,
HTTP/history execution, cancellation, media validation, and publication are the same shared headless runner used by the
CLI.

Workflow identity uses the logical manifest `id`, while execution and manager actions use a source-specific
`workflowKey` such as `built-in:flux2-klein-text-to-image.manifest.json`, `user:custom.manifest.json`, or
`project:custom.manifest.json`.

When multiple sources contain the same logical workflow `id`, the active workflow is selected by precedence:

```text
project > user > built-in
```

The manager can show overridden rows for inspection. Overridden rows are muted and are not used by default selectors or
image generation.

## Headless Catalog Commands

`noveltea comfyui workflows` lists the effective catalog in deterministic logical-ID order. It works outside a Project
and adds project-local workflows when a Project is explicitly selected or discovered from the current directory.
`noveltea comfyui workflows <id>` inspects the effective workflow selected by normal source precedence and reports its
source, classification, description, public input/output contract, authoring metadata, offline validation state,
runnability, package hash, and available cached verification state. Human output is concise; `--json` preserves the
normal NovelTea machine contract of one compact JSON object on stdout and empty stderr.

`noveltea comfyui workflows --all` is diagnostic: it includes overridden and invalid package copies with source,
manifest identity, validation status, override state, and diagnostics. It does not change which package is effective.
Invalid packages are surfaced as data rather than normalized, upgraded, or interpreted as an older shape.

`noveltea comfyui status [--server <url>]` is Project-independent and rejects global `--project`. It resolves the server
from the invocation override, then shared user configuration, then `http://127.0.0.1:8000`. `noveltea comfyui verify
[<id>] [--server <url>]` uses optional Project discovery: a named ID verifies that one effective workflow, while omission
verifies the active workflow set. Verification is diagnostic-only apart from the disposable cache and never repairs or
rewrites a package.

`noveltea comfyui run [<workflow-id> | --type <classification>]` accepts repeated `--input name=value` arguments,
splitting only on the first `=`. An explicit workflow ID is definitive.
`--type` instead reads the configured logical default for that dotted classification and resolves it through normal
`project > user > built-in` precedence. The two selection modes are mutually exclusive, omission of both is invalid, and
missing or temporarily unavailable configured defaults fail explicitly rather than selecting another workflow. Duplicate
or unknown inputs, missing required inputs, invalid scalar values, incompatible output contracts, unusable parent paths,
and existing destinations without `--force` fail locally. Manifest defaults fill omitted optional inputs, and one public
value is written to every graph binding declared for that input. Scalar inputs support string, integer, number, and
boolean values.

A public `image` input accepts an explicitly named local file, with relative paths resolved from the invocation working
directory. The reusable image media handler enforces the 32 MiB source ceiling and decodes the file through NovelTea's
shared/native image-inspection capability before any network request. PNG, JPEG, WebP, and GIF inputs are admitted.
Local bytes may then be uploaded only to credential-free plain HTTP using a literal loopback IP address: `127.0.0.0/8`,
`::1`, and admitted IPv4-mapped IPv6 loopback forms. `localhost`, HTTPS, credentials, arbitrary hostnames, and non-loopback
addresses are rejected before upload. This restriction applies only when local bytes would be disclosed; text-only
ComfyUI commands retain ordinary HTTP/HTTPS server support. Remote upload names are random NovelTea identities that keep
the validated media extension and never reuse the local basename. Online workflow verification completes before upload,
and a failed upload aborts before `/prompt` without claiming remote rollback.

The generic runner enforces every declared named output after terminal history completion. Required cardinality `one`
means exactly one valid image, required `many` means one or more, optional `one` means zero or one, and optional `many`
means zero or more. Every result is downloaded under the bounded image limit and media-validated before any local
publication begins; a missing, malformed, over-cardinality, or format-incompatible result therefore cannot intentionally
leave earlier outputs published.

Each logical output receives exactly one destination. With a Project available, an output without an explicit route is
published as normal Asset data in `assets/generated/`; every image from a `many` output becomes its own Asset. Repeated
`--output name=<path>` options route only those named outputs to the filesystem. Bare `--output <path>` remains shorthand
only for workflows declaring exactly one output. Without a Project, every declared output must be explicitly routed before
upload or prompt submission, including optional outputs whose eventual cardinality may be zero.

For a cardinality-`one` output, the filesystem path names the final file. For `many`, the path names a directory and
NovelTea generates validated workflow-output-oriented filenames beneath it. Missing parent directories are created at
publication time. Existing explicit filesystem files require `--force`; Project Asset publication always remains
collision-safe instead of overwrite-oriented. Returned media must match each explicit file extension because NovelTea does
not transcode.

NovelTea does not hold the workspace writer lock during verification, upload, queueing, polling, or download. After all
remote results validate, it reopens the latest Project, stages all filesystem outputs with atomic rename/backup primitives,
and writes all generated Asset records and bytes in one short normal workspace transaction. Mixed publication failures
roll back staged filesystem results as far as those primitives allow and do not intentionally commit a partial Asset set.
Generated Assets retain normal hashing and image metadata; lightweight `originalPath` provenance identifies ComfyUI, the
logical workflow, and prompt without storing prompt text or local source filenames.

Ctrl-C attempts prompt-specific cancellation by deleting only this invocation's prompt from the ComfyUI queue; it never
uses the global `/interrupt` endpoint. Interrupted runs use exit status 130. Independent CLI runs are not serialized and
use distinct client and prompt identities. `--json` still emits exactly one compact final envelope and keeps stderr empty.

## Author Workflow

1. Build and test the workflow in ComfyUI.
2. Optionally rename important nodes with NovelTea title markers:
   `noveltea.prompt`, `noveltea.sourceImage`, `noveltea.width`, `noveltea.height`, `noveltea.seed`,
   `noveltea.steps`, `noveltea.cfg`, `noveltea.filenamePrefix`, and `noveltea.output`.
3. Export with `File -> Export Workflow (API)`.
4. In NovelTea, open the `ComfyUI Workflows` tab from the command palette, global Settings, or Project Settings summary.
5. For the current image classifications, review inferred bindings, select image output nodes, set defaults, and save.
   For arbitrary generic contracts, switch the Review step to `Edit generic manifest JSON` and author the strict Workflow Manifest V1
   public input/output IDs, classification, types, cardinalities, and binding arrays directly.

The importer does not convert ordinary ComfyUI save-format files. If a file is rejected as a save-format workflow,
export it again through ComfyUI's API workflow export command.

## Public Contract and Bindings

A manifest's `contract.inputs` keys are stable public IDs used by automation and future CLI execution. They are not
limited to NovelTea's image-oriented semantic names. IDs must be CLI-safe identifiers beginning with a letter and may
then contain letters, digits, `_`, or `-`.

Each public input declares a type (`string`, `integer`, `number`, `boolean`, or `image`), whether it is required, an
optional typed `defaultValue`, and optional `authoring` metadata such as a label, description, or preferred editor field.
`bindings.<inputId>` is a non-empty array, so one public input may write the same value to multiple ComfyUI graph inputs.
The binding locator may use node id, title, class type, and selector metadata; selector metadata is what allows stale node
ids to be rebased after ComfyUI rewrites graph ids.

The current import wizard uses the known image classifications to infer familiar fields such as prompt, source image,
seed, steps, width, and height. Exact `noveltea.*` titles are the strongest inference signal. Those semantic names are
editor authoring hints only: the manifest parser, library, verification path, and binding executor operate on whatever
public IDs the manifest declares. The Review step also exposes a strict generic-manifest JSON editor; this is the manual
authoring path for arbitrary current or future classifications and named contracts when image inference is not relevant.

## Outputs

`contract.outputs` also uses arbitrary stable public IDs. Every output declares a `mediaType`, whether it is required,
and explicit `one` or `many` cardinality. `outputBindings.<outputId>` selects one or more graph output nodes for that
public output. The current NovelTea runtime supports `image` output media; packages declaring future media types remain
discoverable and inspectable, but are marked non-runnable until support for that media type exists.

Selecting explicit output nodes prevents complex workflows from importing preview images or intermediate results from
unrelated nodes. The bundled image workflows currently expose the public output ID `images`, but that name is not a
schema-level requirement.

Workflow manifests require exact `schemaVersion: 1` and one canonical strict development shape. Issue #104 deliberately rewrote the
same selected development contract atomically rather than bumping the version. Therefore a missing or different version, retired
`role` or top-level `defaults`, single-object input bindings, binding/output `valueType`, `image-list`/`primary` output
metadata, retired `outputNodeIds`, or any other noncanonical field makes the workflow invalid. The library does not infer,
upgrade, or dual-read the replaced development shape.

## Repair

Use `Repair` in the `ComfyUI Workflows` manager when a mutable workflow manifest reports stale or unresolved bindings.
Known image classifications can reuse the image-classification inference UI. Generic packages with unknown or omitted
classifications open directly in strict current-manifest JSON mode so arbitrary named inputs, outputs, and binding arrays can
be repaired manually without pretending to use an image semantic role. Repair preserves the installed workflow JSON and
writes the canonical generic manifest shape. Built-in workflows cannot be repaired in place; copy them to the user or
project source first if a local replacement is needed.

If the ComfyUI workflow graph itself changed substantially, export the new API workflow JSON and import it as a new
workflow until replacement-workflow repair is added.

## Manager Actions

The `ComfyUI Workflows` tab is intentionally compact: each row shows only source, name, classification, and status. An
unclassified package displays no classification and is still a valid library entry. Status uses
two hoverable lights for offline validation and ComfyUI verification; failures expose their diagnostics in the tooltip.
Overridden packages can be shown from the header without replacing the current rows with a loading state. Row actions
are grouped under the trailing `...` menu.

Supported source-aware actions include:

- copy a built-in or project workflow to the shared user source;
- copy a built-in or user workflow to the current project source when a project is open;
- delete user or project workflows;
- reveal a workflow package in the file manager;
- repair mutable workflow manifests;
- refresh the library and verify workflows that are failing or do not have a cached success against the configured
  ComfyUI server.

Copying an identical package is a no-op. Copying a same-ID package with different package contents requires replacing
the target package.

## Verification

Offline validation checks package shape, bindings, output nodes, and required metadata. Online verification runs against
the selected ComfyUI `/object_info` endpoint and requires every manifest `requiredNodeClasses` entry plus every mapped
node input to exist before verification succeeds.

Editor refresh verifies active workflows that are failing or do not have a cached success. Cached successes are skipped,
while changed package hashes naturally become unverified and are checked again. Explicit CLI `verify` performs the
requested check even when a prior success exists. A label-only rename updates the package hash but rekeys its cached
verification because the name does not affect ComfyUI compatibility. The cache is itself the strict
`noveltea.comfyui-workflow-verification-cache` version 1 document stored under the shared `<NovelTea user
config>/comfyui/` area. Records are scoped by normalized server identity, workflow package hash, and observed ComfyUI
version. Issue #106 deliberately preserved cache version 1 while requiring that server identity in the canonical record;
older same-version records without it are discarded rather than migrated. If offline checks pass but no server is
available, the verification light is yellow and its tooltip says `Need ComfyUI server to verify`.

## IPC Authority and Bounds

ComfyUI IPC is admitted through the editor's trusted top-level-frame boundary. Connection checks and queue reads are
non-Project network capabilities, but their server URL, timeout, workflow defaults, and collection sizes are parsed from
strict bounded contracts before any request is sent. Only HTTP(S) ComfyUI server URLs are accepted.

Project-local workflow discovery, copy, delete, rename, repair, reveal, verification, import analysis, image generation,
image editing, and cancellation use the current `projectSessionId` whenever Project state is involved. Main derives the
Project workspace from that session; renderer-supplied Project roots or manifest paths are not accepted by those IPC
contracts. A stale or wrong session fails before Project workflow filesystem or generation work begins.

Generation requests also bound workflow identity, prompts, dimensions, seed, steps, CFG, job identity, and workflow JSON
sizes. IPC limits are byte-oriented where identity/text disclosure matters: server URLs are limited to 2 KiB UTF-8,
workflow and job ids to 256 UTF-8 bytes, workflow labels to 1 KiB UTF-8, and prompts/negative prompts to 64 KiB UTF-8.
Imported/repaired workflow manifests are structurally parsed at the IPC boundary and capped at 1 MiB before workflow
services run. Catalog discovery independently bounds package reads: each source considers at most 256 manifest packages,
manifest JSON is capped at 1 MiB, and workflow JSON is capped at 32 MiB before parsing. Progress events are emitted only while the initiating Project session remains current. If the Project closes or
switches while a job is running, stale work cannot publish completion/error progress or continue writing generated
assets into the newly active Project.

Image-edit requests identify their source only by current `projectSessionId` and admitted image Asset id. Main resolves
and revalidates the Asset through the active Project authority, including canonical containment, contained-only symlinks,
regular-file identity, admitted byte size, and SHA-256 revision. The source ceiling is 32 MiB; main allocates at most the
admitted source size, reads exactly that many bytes with a one-byte growth probe, and rechecks the revision. The editor
adapter then materializes those authorized bytes to a private temporary file and passes that filename through the shared
headless image-input handler, so decode validation, generated remote naming, upload ordering, and cleanup do not fork.

Local source-image disclosure therefore follows exactly the headless rule: credential-free plain HTTP to a literal
loopback IP only (`127.0.0.0/8`, `::1`, or admitted IPv4-mapped loopback). `localhost`, HTTPS, credentials, arbitrary
hostnames, and non-loopback addresses are rejected before upload. If an editor configuration currently uses
`http://localhost:<port>`, change it to a literal address such as `http://127.0.0.1:<port>` (or `[::1]`). Renderer
contracts contain neither Project/source paths nor an upload destination override. Trust-boundary failures expose stable
machine categories such as `stale-project-session`, `unauthorized-asset`, `unsafe-path`, `symlink-escape`,
`not-regular-file`, `source-revision-mismatch`, and `source-too-large`; shared media/upload failures provide the same
bounded diagnostics as the CLI.

## Classification, Defaults, and Image Generation

`classification` is optional extensible dotted metadata, not a closed manifest discriminator. NovelTea currently knows
`image.generate` and `image.edit` for image-oriented editor UX and inference. Unknown dotted classifications and omitted
classification are accepted by the generic manifest/library contract; classification does not redefine public inputs,
outputs, or graph bindings.

Input defaults live on `contract.inputs.<inputId>.defaultValue`; there is no top-level manifest `defaults` object.
Global Settings stores preferred logical workflow IDs in the extensible `defaultWorkflows[classification]` map. The
current Generate Image and Edit Image conveniences consume the `image.generate` and `image.edit` entries respectively,
while Settings may expose additional discovered classifications. The adapter resolves those logical IDs through normal
`project > user > built-in` precedence and then invokes the captured workflow package through the shared runner.
Unsupported future media workflows remain visible and inspectable in the manager but are not offered as runnable image
operations. The image-specific UI is therefore an adapter over the generic manifest/execution contract, not a second
parser, verifier, transport, cancellation mechanism, or publication implementation.
