# ComfyUI Workflow Import

NovelTea imports ComfyUI API workflow exports and writes project-local manifests that describe which inputs and
outputs the editor may control.

## Author Workflow

1. Build and test the workflow in ComfyUI.
2. Optionally rename important nodes with NovelTea title markers:
   `noveltea.prompt`, `noveltea.sourceImage`, `noveltea.width`, `noveltea.height`, `noveltea.seed`,
   `noveltea.steps`, `noveltea.cfg`, `noveltea.filenamePrefix`, and `noveltea.output`.
3. Export with `File -> Export Workflow (API)`.
4. In NovelTea, open Project Settings, then ComfyUI Workflows, then `Import Workflow`.
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

Use `Repair` in the Project Settings workflow table when a workflow manifest reports stale or unresolved bindings.
Repair reuses the import mapping UI, preserves the installed workflow JSON, and writes an updated manifest.

If the ComfyUI workflow graph itself changed substantially, export the new API workflow JSON and import it as a new
workflow until replacement-workflow repair is added.
