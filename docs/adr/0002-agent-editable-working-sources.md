# Agent-editable working sources are a projected proposal, not a new save authority

Status: accepted contract (#624); implementation tracked by #625–#629.

## Decision

Unsaved editor changes must be fixable by arbitrary local agents using only
files under the Project, even with the editor closed. Use a separate
`.noveltea/editor/working/` source-shaped projection of dirty YAML and text,
explicit deletion markers, pending textual drafts, and an exact-byte
publisher baseline/manifest. An agent may change those files as a **proposal**;
native checkpoint acknowledgment and the existing per-owner three-way
reconciliation are required before the change becomes editor working state.
No agent may directly edit `native-dirty-state.json` or `state.json` to repair
content. Tracked Project YAML is changed only by explicit native Save with
revision checks.

## Rationale and consequences

Agents can use ordinary editors, shell tools or Copy prompt without a socket,
MCP server, editor process, provider protocol or new headless mode. Splitting
per physical owner avoids a second monolithic dirty-state file and makes
localized edits reviewable while preserving exact raw text and comments.
Immutable publisher baselines distinguish agent edits from subsequently
acknowledged native edits, including crashes and offline edits; per-owner
native revision/CAS avoids whole-Project parsing. The manifest inherits the
same-build editor-local lifecycle rather than inventing a separately versioned
Project format. Working files are ignored state, not runtime/export inputs.

The trade-off is extra per-dirty-owner I/O and explicit conflict handling
when publication and external writes race. No shortcut may silently overwrite
agent bytes, invent a canonical Project from malformed sources, or treat an
agent edit as a Save. Ordinary unrelated Project symlinks do not block agent
launch; privileged editor publication remains target-confined.

See [the normative layout and lifecycle](../editor/project/PROJECT_WORKING_SOURCE_PROJECTION.md)
and [the accepted repair authority](0001-editor-admission-preserves-repairable-sources.md).
