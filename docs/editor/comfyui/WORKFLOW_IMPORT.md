# ComfyUI Workflow Library and Import

NovelTea imports ComfyUI API workflow exports and writes workflow manifests that describe which inputs and outputs the
editor may control. Workflow packages are managed from the editor-owned `ComfyUI Workflows` workbench tab, not from
Project Settings.

## Workflow Sources

The workflow library discovers packages from three sources:

- built-in workflows shipped with the editor;
- editor-wide workflows under the editor user-data `workflows/` directory;
- project-local workflows under the saved project's `workflows/` directory.

Project workflows are only discovered when a project file path exists. Built-in and editor-wide workflows are available
without a project open, although image generation still needs a saved project before it can write generated output
assets.

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
newly imported manifests keep compatibility `outputNodeIds` while also storing richer output binding metadata.

## Repair

Use `Repair` in the `ComfyUI Workflows` manager when a mutable workflow manifest reports stale or unresolved bindings.
Repair reuses the import mapping UI, preserves the installed workflow JSON, and writes an updated manifest. Built-in
workflows cannot be repaired in place; copy them to the editor or project source first if a local replacement is needed.

If the ComfyUI workflow graph itself changed substantially, export the new API workflow JSON and import it as a new
workflow until replacement-workflow repair is added.

## Manager Actions

The `ComfyUI Workflows` tab lists active workflows by default and can optionally show overridden packages. It reports
source, role, logical ID, verification status, workflow and manifest files, diagnostics, and available actions.

Supported source-aware actions include:

- copy a built-in or editor workflow to the editor source;
- copy a built-in or editor workflow to the current project source when a project is open;
- delete editor or project workflows;
- reveal a workflow package in the file manager;
- repair mutable workflow manifests;
- verify valid workflows against the configured ComfyUI server.

Copying an identical package is a no-op. Copying a same-ID package with different package contents requires replacing
the target package.

## Verification

Offline validation checks package shape, bindings, output nodes, and required metadata. Online verification runs against
the configured ComfyUI `/object_info` endpoint and records whether workflow node classes and mapped inputs are available.

When ComfyUI becomes ready, the renderer triggers one verification pass for the current server/project/package-hash
session. Copying, deleting, importing, or repairing workflows invalidates that session key so changed packages can be
verified again. The verification cache is used for offline UX only; a ready ComfyUI server still gets a fresh
verification pass for the current session.

## Defaults and Generation

Global Settings stores default workflows by logical role ID:

```ts
defaultWorkflows['image.generate']
defaultWorkflows['image.edit']
```

The Settings selectors show active library workflows for each role. Image generation resolves those logical IDs to the
active source-specific `workflowKey`, so a project or editor override with the same logical ID automatically becomes the
effective workflow.
