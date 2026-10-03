# Public Authoring Documentation

`docs/public/` contains NovelTea documentation whose subject is the public authoring model rather
than editor workflow or engine implementation. Content here may be consumed by more than one public
documentation surface.

## Canonical shared concepts

`docs/public/concepts/` is the canonical source of the concise engine-concept layer shared by the
human documentation site and the generated Agent Kit. The documents explain what the major public
authoring concepts mean, who owns them, and how they compose. They intentionally leave exact field
shape and constraints to the generated schema/reference pipeline.

Do not maintain a distilled copy of these concept documents under `site/` or `editor/agent-kit/`.
Audience-specific tutorials, screenshots, CLI workflow, and exact RmlUi/Lua reference material belong
outside this directory.

Internal engine-development documentation remains under the existing `docs/architecture/`,
`docs/engine/`, `docs/editor/`, `docs/runtime/`, `docs/rendering/`, `docs/ui/`, and `docs/assets/`
hierarchies. This public layer does not replace or clean up those implementation-facing documents.
