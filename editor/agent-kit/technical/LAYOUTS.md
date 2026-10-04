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

Activation-triggered contextual Layouts may receive an immutable Trigger Context with pointer/source-bounds geometry. Trigger Context is acquired only by presentation paths that explicitly carry the activation snapshot. `Present Inventory` carries it when `useTriggerAnchor` is true; contextual Verb Menu/Command Builder presentation carries the activation that opened that interaction; `context:present_child(...)` and `context:present_child_inventory()` inherit the parent's captured Trigger Context. An ordinary Scene `SetLayout`/generic Layout mount does not implicitly acquire the pointer that happened to start the Scene. Author a pointer-less fallback for any Layout that can also be presented through a non-contextual path.

During a Layout event, use `Game.mount_context()` to transform that snapshot into the receiving Layout's logical coordinates and to access occurrence-safe contextual operations. `context:dismiss()` dismisses only the exact live occurrence; `context:present_child(...)` creates a child whose lifetime follows that exact parent occurrence; `context:present_child_inventory()` presents Player Inventory as a contextual child. Parent lifetime and captured activation geometry are intentionally separate, so source movement/disappearance does not invalidate the snapshot and parent dismissal still removes descendants.

Inventory UI rows represent exact Interactable Instance IDs with their quantity and presentation. Activating a row uses ordinary exact Interactable Primary Activate/Verb resolution. Do not create aggregate Item/Stack identities or infer gameplay identity from a row index.

When customizing a built-in, create or edit a tracked project Layout and assign that Layout to the role. Copy any RML/RCSS you want the project to own into tracked project source and update its URLs/dependencies accordingly. Keeping a documented `system|/...` reference means that resource remains engine-owned and can change when the installed NovelTea version changes.

## Built-in Interaction automation selectors

Authored `ui-click` Tests can rely on these semantic identities in the built-in Layouts:

| documentId                | Selector                                  | Meaning                                              |
| ------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| `runtime_verb_menu`       | `#nt-verb-menu-action-<verb-id>`          | Published action for that authored Verb ID           |
| `runtime_verb_menu`       | `#nt_verb_menu_close`                     | Close the menu                                       |
| `runtime_command_builder` | `#command_builder_submit`                 | Submit the complete draft (only shown when complete) |
| `runtime_command_builder` | `#command_builder_cancel`                 | Cancel the draft                                     |
| `runtime_command_builder` | `#command-builder-rebind-<slot-id>`       | Focus that bound slot for replacement                |
| `runtime_command_builder` | `#command-builder-focused-slot-<slot-id>` | Current slot marker (not a clickable control)        |

Substitute the exact authored ID, for example `#nt-verb-menu-action-show`. These are ordinary RML IDs,
not a separate test transport. They do not depend on label translation, Offer rank, or row position.
Escape selector-special characters in authored IDs using RmlUi selector syntax where necessary.
Replacement project Layouts own their selectors and must provide/document their own automation
contract; these identities promise only the built-in surfaces. See `workflows/AUTHORING.md` for
semantic versus UI testing guidance. A click can prove a published action works; direct command
execution cannot prove that action was offered.

The authored RuntimeUI test runner is gameplay-oriented. It realizes gameplay Layouts and dispatches gameplay inputs produced by their controls, but it does not execute `Game.shell` commands or certify the player shell stack (Pause, Settings, Text Log, title/modal flows). A shell control can therefore be present yet fail to progress under authored UI playback. Use the real player or a focused native RuntimeUI/shell test when shell-command behavior itself is the contract; do not reinterpret a headless shell failure as evidence that the authored RML selector is wrong.

For copied built-ins, read `.noveltea/agent/technical/RMLUI_DATA_BINDING.md`,
`.noveltea/agent/technical/RMLUI_CUSTOM_COMPONENTS.md`, and
`.noveltea/agent/technical/RMLUI_LUA.md` before changing their declarative or scripted behavior.
