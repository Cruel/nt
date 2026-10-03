# Layout runtime authoring

Use `.noveltea/agent/concepts/presentation-and-localization.md` for the Layout concept and
`.noveltea/agent/reference/records/layouts.md` for exact Layout metadata/source modes. For authored
RML/RCSS read `.noveltea/agent/technical/RMLUI.md`; for RML event Lua or dedicated Layout Lua read
`.noveltea/agent/technical/RMLUI_LUA.md` together with `.noveltea/agent/technical/LUA.md`.

## Baseline RCSS applies to every Layout

All Layout RCSS is authored above NovelTea's universal RuntimeUI baseline. The engine applies the frozen RmlUi HTML4 baseline first, then the NovelTea-specific baseline, then template RCSS, then the Layout/document's own RCSS.

Do not add `<link>` entries or Layout stylesheet dependencies for the baseline files. They are implicit engine-owned layers and apply equally to built-in Layouts, project Layouts, hosted fragments, and focused previews. Project RCSS should contain only project-owned styling and intentional overrides of baseline defaults.

The installed CLI exports the exact baseline cascade and source paths in
`.noveltea/agent/system-layouts/manifest.json`, with the referenced files under
`.noveltea/agent/system-layouts/ui/`. Inspect those generated files when inherited/default style
matters, but never edit or copy them wholesale merely to reproduce runtime defaults.

## System Layout overrides

A system Layout override is a behavioral replacement, not just a visual skin. Preserve or deliberately replace the built-in data-model bindings, callbacks, custom elements, focus behavior, and RmlUi Lua needed by that role.

Before authoring an override, inspect the role in `.noveltea/agent/system-layouts/manifest.json` and then inspect the
exact built-in RML/RCSS it names. The manifest is authoritative for which roles have built-in
fallbacks and for their supporting files; do not maintain a separate remembered role/path table.

The Command Builder is gameplay-owned: runtime publishes its active occurrence, latest captured
subject, and exact watched-reference snapshots, while the Layout owns transient Draft
presentation/editing. Replacement Command Builder Layouts use the selected subject and Offer
`slot_id` from the `noveltea` model plus the documented `Game.ui` transport; see
`.noveltea/agent/technical/RMLUI_DATA_BINDING.md` and `.noveltea/agent/technical/LUA.md`.

The generated `ui/` tree is copied byte-for-byte from the engine's shipped system UI assets. It is reference material under generated `.noveltea/` state, not project source: never edit it in place.

## Contextual Verb Menu and Inventory presentation

Verb Menu and ordinary Inventory presentation are contextual gameplay Layouts, not additional System Layout Roles. Project settings may choose `settings.interaction.defaultVerbMenuLayout` and `settings.inventory.defaultLayout`; each falls back to the corresponding built-in Layout when unset. `Present Inventory` may also supply an explicit Layout, which takes precedence over the Project default. Player Inventory operands/actions resolve the Project's single canonical Inventory; authoring no longer selects among multiple Project Inventories.

The Verb Menu is not the Command Builder. It presents resolved Verb Offers for one exact subject. A one-slot offer can complete directly; an offer that still needs bindings starts the separate Command Builder role.

Activation-triggered contextual Layouts may receive an immutable Trigger Context with pointer/source-bounds geometry. During a Layout event, use `Game.mount_context()` to transform that snapshot into the receiving Layout's logical coordinates and to access occurrence-safe contextual operations. `context:dismiss()` dismisses only the exact live occurrence; `context:present_child(...)` creates a child whose lifetime follows that exact parent occurrence; `context:present_child_inventory()` presents Player Inventory as a contextual child. Parent lifetime and captured activation geometry are intentionally separate, so source movement/disappearance does not invalidate the snapshot and parent dismissal still removes descendants.

Inventory UI rows represent exact Interactable Instance IDs with their quantity and presentation. Activating a row uses ordinary exact Interactable Primary Activate/Verb resolution. Do not create aggregate Item/Stack identities or infer gameplay identity from a row index.

When customizing a built-in, create or edit a tracked project Layout and assign that Layout to the role. Copy any RML/RCSS you want the project to own into tracked project source and update its URLs/dependencies accordingly. Keeping a documented `system|/...` reference means that resource remains engine-owned and can change when the installed NovelTea version changes.

For copied built-ins, read `.noveltea/agent/technical/RMLUI_DATA_BINDING.md`,
`.noveltea/agent/technical/RMLUI_CUSTOM_COMPONENTS.md`, and
`.noveltea/agent/technical/RMLUI_LUA.md` before changing their declarative or scripted behavior.
