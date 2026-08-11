# Built-in System Layout Audit

## Scope

This audit covers the engine-owned fallback Layouts under `engine/assets/system/ui`. They are product
UI, not compatibility fixtures. Their existing structure may be replaced whenever the role contract
is clearer and the resulting behavior is tested and documented.

The title Layout is intentionally excluded from the current redesign. It remains the acceptable
baseline while the gameplay and shell surfaces are rebuilt.

## Design Rules

Built-in Layouts must be functional defaults rather than demonstrations of every available slot.
They should occupy only the screen area needed for the current task, leave world presentation to the
world renderer, expose typed native actions, and hide controls that have no valid action.

System-role lifecycle and authored structure are separate. RuntimeUI publishes the same read-only
`noveltea` data model into every RmlUi context; built-in and project-authored Layouts opt into it
explicitly and author their own controls with RmlUi data binding. System role does not trigger
native population of element IDs.

## Inventory

### Title

Status: retained for now.

The title screen has a focused purpose, typed start/load/settings actions, and no dependency on world
presentation. It should be revisited only after the gameplay and nested shell patterns stabilize.

### Game HUD

Status: replaced in this audit.

The prior fallback was a placeholder workbench. It drew the current Room background a second time,
placed an opaque content box across most of the viewport, exposed map/log/debug-oriented surfaces at
all times, and rendered Room exits as an undifferentiated vertical button list.

The replacement is a transparent screen-space overlay with four bounded surfaces:

- a compact top-right notification/title area with a functional pause-menu button;
- a bottom-left interaction dock that appears only when nearby, inventory, or action controls exist;
- a bottom text panel that appears only while ActiveText or choices are present;
- a bottom-right 3×3 navigation dial.

The navigation dial uses the eight compass directions plus the center position for custom exits.
Only enabled exits render buttons. The temporary visual is a labeled box (`NW`, `N`, `NE`, and so
on). Authored direction classes allow the boxes to be replaced later with one arrow image and
direction-specific rotation without changing typed navigation behavior.

Room descriptions now behave as transient ActiveText messages. A new Room visit publishes its
description, ActiveText handles reveal and click-through, and completion removes the description from
subsequent UI publications for that visit. The dismissal is not save-state data; loading or resetting
starts a fresh presentation of the current visit.

### Pause Menu

Status: functional placeholder; redesign unit remains.

The menu has typed actions but hard-codes one vertical action stack and owns styling separate from the
other shell screens. Its redesign should establish the shared shell frame, command hierarchy, focus
order, controller navigation, and destructive-action treatment used by the remaining menus.

### Save and Load

Status: functional duplicated placeholders; redesign unit remains.

The documents duplicate the same shell structure and differ mainly in declarative slot behavior. Their
replacement should share one visual slot/card language, make autosave/manual-save distinctions clear,
surface checkpoint readiness without debug-oriented prose, and define empty, occupied, unavailable,
and thumbnail-loading states.

### Settings

Status: functional narrow placeholder; redesign unit remains.

The current screen exposes only minimum/default/maximum UI and text scale presets. It needs a general
settings composition that can grow by category without turning the system Layout into a fixed list of
engine settings. Exact input widgets and persistence should remain typed native behavior.

### Text Log

Status: functional wrapper; redesign unit remains.

The data-driven log list is valid, but the fallback is only a generic modal panel. Its redesign should
define scrolling, current-entry positioning, speaker/body hierarchy, keyboard/controller close
behavior, and long-session performance expectations.

### Modal

Status: functional fixed confirmation; redesign unit remains.

The fallback assumes every modal is an “Are you sure?” confirmation. The next contract should
separate modal shell structure from prompt/action data and define default focus, cancellation, and
destructive confirmation semantics.

### Debug Overlay

Status: no built-in fallback by design.

Debug UI remains project/tooling-specific until a concrete engine debug surface is specified. It
should not be inferred from the gameplay HUD.

## Asset Use in Layouts

Layout source URLs address mounted asset namespaces:

- `system|/path` resolves to an engine-bundled resource under the `system:/` mount.
- `project|/path` resolves to a compiled project resource under the `project:/` mount.
- relative URLs resolve from the document source and through the appropriate mount.

Built-in fallback art belongs under `engine/assets/system` and uses `system|/...`. Project art is
imported as an Asset, declared in the Layout's dependency list, and referenced by its packaged
`project|/...` path. Dependency declarations drive validation, focused preview, packaging, prefetch,
and residency; they do not currently provide Asset-ID interpolation inside RML or RCSS.

For the planned navigation arrow, an engine default could live beside the HUD assets and be referenced
as `system|/ui/runtime/navigation-arrow.png`. A project replacement would declare its image Asset and
use the corresponding `project|/...` URL. The generated `nav-north`, `nav-northeast`, and related
classes are authored styling hooks for rotation.

## Recommended Refactor Order

1. Establish one shared shell frame and focus/navigation policy through the pause menu.
2. Rebuild save and load on that frame with reusable slot/card styling.
3. Rebuild settings around extensible categories and typed controls.
4. Rebuild text log for reading and navigation rather than generic modal presentation.
5. Generalize modal content/action contracts after the shell patterns are stable.

Each unit should replace its fallback completely, update `RMLUI_DATA_MODEL_CONTRACT.md` when the
shared model contract changes, and add source-contract plus native behavior tests. No migration
layer for the placeholder markup is required.
