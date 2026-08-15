# ComfyUI Workflow Library and Import

NovelTea imports ComfyUI API workflow exports and writes workflow manifests that describe which inputs and outputs the
editor may control. Workflow packages are managed from the editor-owned `ComfyUI Workflows` workbench tab, not from
Project Settings.

## Workflow Sources

The workflow library discovers packages from three sources:

- built-in workflows shipped with the editor;
- editor-wide workflows under the editor user-data `workflows/` directory;
- project-local workflows under the saved project's `workflows/` directory.

Project workflows are only discovered when an active saved Project session exists. Renderer code may retain the Project
file path as UI context, but it does not send that path across the privileged IPC boundary: main derives the canonical
Project root and `project.json` from the current `projectSessionId`. Built-in and editor-wide workflows remain available
without a project open, although image generation still requires an active saved Project session before it can write
generated output assets.

Workflow identity uses the logical manifest `id`, while execution and manager actions use a source-specific
`workflowKey` such as `built-in:flux2-klein-text-to-image.manifest.json`,
`editor:custom.manifest.json`, or `project:custom.manifest.json`.

When multiple sources contain the same logical workflow `id`, the active workflow is selected by precedence:

```text
project > editor > built-in
```

The manager can show overridden rows for inspection. Overridden rows are muted and are not used by default selectors or
image generation.

## Author Workflow

1. Build and test the workflow in ComfyUI.
2. Optionally rename important nodes with NovelTea title markers:
   `noveltea.prompt`, `noveltea.sourceImage`, `noveltea.width`, `noveltea.height`, `noveltea.seed`,
   `noveltea.steps`, `noveltea.cfg`, `noveltea.filenamePrefix`, and `noveltea.output`.
3. Export with `File -> Export Workflow (API)`.
4. In NovelTea, open the `ComfyUI Workflows` tab from the command palette, global Settings, or Project Settings summary.
5. Choose the role, review detected bindings, select the image output node or nodes, set defaults, and save.

The importer does not convert ordinary ComfyUI save-format files. If a file is rejected as a save-format workflow,
export it again through ComfyUI's API workflow export command.

## Bindings

Bindings connect NovelTea semantic fields such as prompt, source image, seed, steps, width, and height to specific
ComfyUI node inputs. The wizard ranks likely matches from node titles, class types, input names, and graph links.
Exact `noveltea.*` titles are the strongest signal and also help repair bindings after ComfyUI assigns new node ids.

Required role inputs must be mapped before saving. Optional inputs may be left unmapped; unmapped optional controls are
hidden in the Image Generation editor for that workflow.

## Outputs

Every imported workflow should select the output nodes whose images NovelTea should save as project assets. This
prevents complex workflows from importing preview images or intermediate results from unrelated nodes. Starter and
newly imported manifests write only the strict V2 `outputBindings.images` locator metadata.

Workflow manifests require exact `schemaVersion: 2` and one canonical strict shape. A missing version,
V1 manifest, retired `outputNodeIds`, or unknown field makes the workflow invalid; the library does
not infer or upgrade it.

## Repair

Use `Repair` in the `ComfyUI Workflows` manager when a mutable workflow manifest reports stale or unresolved bindings.
Repair reuses the import mapping UI, preserves the installed workflow JSON, and writes an updated manifest. Built-in
workflows cannot be repaired in place; copy them to the editor or project source first if a local replacement is needed.

If the ComfyUI workflow graph itself changed substantially, export the new API workflow JSON and import it as a new
workflow until replacement-workflow repair is added.

## Manager Actions

The `ComfyUI Workflows` tab is intentionally compact: each row shows only source, name, role, and status. Status uses
two hoverable lights for offline validation and ComfyUI verification; failures expose their diagnostics in the tooltip.
Overridden packages can be shown from the header without replacing the current rows with a loading state. Row actions
are grouped under the trailing `...` menu.

Supported source-aware actions include:

- copy a built-in or editor workflow to the editor source;
- copy a built-in or editor workflow to the current project source when a project is open;
- delete editor or project workflows;
- reveal a workflow package in the file manager;
- repair mutable workflow manifests;
- refresh the library and verify workflows that are failing or do not have a cached success against the configured
  ComfyUI server.

Copying an identical package is a no-op. Copying a same-ID package with different package contents requires replacing
the target package.

## Verification

Offline validation checks package shape, bindings, output nodes, and required metadata. Online verification runs against
the configured ComfyUI `/object_info` endpoint and records whether workflow node classes and mapped inputs are available.

Refresh verifies workflows that are failing or do not have a cached success. Cached successes are skipped, while changed
package hashes naturally become unverified and are checked again. A label-only rename updates the package hash but
rekeys its cached verification because the name does not affect ComfyUI compatibility. The cache is
itself the strict `noveltea.comfyui-workflow-verification-cache` version 1 document; incompatible or
malformed cache files are discarded and rebuilt. If offline checks pass but no server is
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
sizes. Progress events are emitted only while the initiating Project session remains current. If the Project closes or
switches while a job is running, stale work cannot publish completion/error progress or continue writing generated
assets into the newly active Project.

Image-edit requests identify their source only by current `projectSessionId` and admitted image Asset id. Main resolves
and revalidates the Asset through the active Project authority, including canonical containment, contained-only symlinks,
regular-file identity, admitted byte size, and SHA-256 revision. The source upload ceiling is 32 MiB and is enforced both
before opening the upload buffer and while streaming bytes into it.

Source-image upload is intentionally narrower than ordinary ComfyUI communication: it accepts loopback HTTP only.
Literal `127.0.0.0/8`, `::1`, IPv4-mapped loopback, and `localhost` are accepted; credentials, HTTPS, arbitrary hostnames,
and non-loopback addresses are rejected. `localhost` is resolved before upload and every returned address must be
loopback. The upload socket then connects directly to the verified address and rechecks its remote address, so DNS
rebinding cannot redirect source bytes off-machine. Redirect responses are rejected rather than followed. Renderer
contracts contain neither Project/source paths nor an upload destination override.

## Defaults and Generation

Global Settings stores default workflows by logical role ID:

```ts
defaultWorkflows['image.generate']
defaultWorkflows['image.edit']
```

The Settings selectors show active library workflows for each role. Image generation resolves those logical IDs to the
active source-specific `workflowKey`, so a project or editor override with the same logical ID automatically becomes the
effective workflow.
