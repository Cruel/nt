# Project Settings

Project Settings is the editor surface for authoring-project settings that belong to the game/project itself. It is distinct from the existing Settings page, which is for editor preferences such as theme, density, window chrome, and restore behavior.

## Access

The editor exposes Project Settings in two places:

- `Project > Project Settings…`
- the command palette/quick-open surface;
- Package Export diagnostics, when export is blocked by project-level settings such as a missing entrypoint.

## Stored Data

Project Settings edits the authoring project document through undoable command-bus operations. It
does not write editor preferences, runtime user settings, or game progress. Editor preferences remain
in the Electron `noveltea-preferences` store; runtime user settings and typed saves use their separate
C++ versioned contracts.
ComfyUI connection settings and workflow-library management are editor-wide surfaces. Project Settings only shows a compact workflow summary and a Manage button; it must not write server URLs, enablement, default workflow preferences, or workflow-library state into the authoring project document.

## Editing and Save Behavior

Project Settings has no whole-form draft and no Apply action. Every structurally representable
control edit is dispatched immediately through an undoable command and becomes part of the
authoritative working document. This includes semantically invalid but representable values such as
empty required strings, malformed colors, zero or negative numeric values, and unresolved record
references. Validation reports those values without reverting, normalizing, or unloading the
project.

Numeric text that is not yet representable by the project type, such as an empty required number,
`-`, or `1.`, is stored as one field-level pending input keyed by the `project:settings` save unit and
the field's JSON pointer. Pending input preserves the exact text through tab switches, project or
window close, and reopen. It marks every duplicate Project Settings view dirty, appears as an error
in Problems, and blocks only the Project Settings save unit. It clears only after the field commits a
representable number or Project Settings is explicitly discarded.

`Ctrl+S` saves only `project:settings` when a Project Settings tab is active. Save All can still save
unrelated valid units while leaving blocked Project Settings values dirty. Duplicate tabs share one
logical dirty/save state; closing a non-final duplicate does not prompt, while closing the final dirty
view uses the standard Save / Don't Save / Cancel flow. Undo and Redo operate on the same focused
commands used by the controls.

Project and window close persist the exact dirty settings state through editor recovery metadata but
do not commit it into project content. Save As copies the saved baseline and that recovery state
without applying or validating the dirty values. See
`PROJECT_SAVE_UNITS_AND_RECOVERY.md` for the complete save and recovery contract.

Metadata uses existing project root fields:

```ts
project.name
project.version
project.author
project.description
```

Startup uses:

```ts
entrypoint
startupHook.source
```

Runtime defaults use:

```ts
settings.ui.systemLayouts.title
settings.ui.systemLayouts.game-hud
settings.ui.systemLayouts.pause-menu
settings.ui.systemLayouts.load-menu
settings.ui.systemLayouts.settings-menu
settings.ui.systemLayouts.modal
settings.ui.systemLayouts.debug-overlay
settings.text.defaultFont
```

Title-screen and app/package identity use:

```ts
settings.titleScreen.titleImage
settings.titleScreen.showProjectTitle
settings.titleScreen.showAuthor
settings.titleScreen.subtitle
settings.titleScreen.startLabel
settings.app.icon
settings.app.displayName
settings.app.shortName
settings.app.publisher
settings.app.description
settings.app.defaultLocale
settings.app.localized
settings.app.applicationId
settings.app.saveNamespace
settings.app.versionName
settings.app.buildNumber
settings.app.launchImage
settings.app.themeColor
settings.app.accentColor
settings.app.launchBackgroundColor
settings.app.desktop
settings.app.web
settings.app.android
settings.display.aspectRatio
settings.display.orientation
settings.display.barColor
```

Display settings default to a normalized 16:9 landscape viewport with black presentation bars. The
Display card provides common presets, custom integer ratio components, landscape or portrait
orientation, and editable bar-color text. Positive ratios and six-digit colors are semantic
requirements enforced through diagnostics and Save blocking, not through lossy input coercion. These
settings constrain aspect ratio; they are not a fixed rendering resolution. Changes use the command
bus and therefore participate in undo/redo and dirty state.

## Built-In Fallbacks

System layout roles and default font support built-in fallback behavior. A `null` or an
absent system layout role means the built-in engine layout for that role is used. This keeps
built-in title/menu/HUD documents compatible with project-authored replacements.

```ts
settings.ui.systemLayouts.title = null       // built-in title layout
settings.ui.systemLayouts.game-hud = null    // built-in gameplay HUD layout
settings.ui.systemLayouts.pause-menu = null  // built-in pause menu layout
settings.text.defaultFont = null             // built-in default font
```

Project layout/font records can override those fallbacks. The editor writes only `settings.ui.systemLayouts` for engine UI role overrides.

## Entrypoint and startup

The V2 entrypoint is a strict Room, Scene, or Dialogue union. Project Settings exposes only those three collections; Script Modules cannot be selected. Startup Lua is edited separately and stored at `startupHook.source`.

Package Export remains strict: a missing or unresolved entrypoint blocks export.

## Validation

Project Settings adds typed validation for:

- project title;
- semver-like project version warnings;
- startup init script shape;
- system layout role refs;
- default font refs, which must point to font assets;
- title image refs, which must point to image assets;
- project icon refs, which must point to image assets.
- required display name, canonical reverse-DNS application ID, save namespace, and version name;
- positive shared and platform build numbers/version codes;
- normalized BCP 47 default and localized locale tags;
- launch image refs, which must point to image assets;
- six-digit identity and launch colors;
- platform-specific Android, Apple, Linux, and Windows identifier overrides.

Ordinary validation failures are shown in Problems and through `aria-invalid` field highlighting.
Selecting a Project Settings diagnostic opens the logical settings tab, scrolls the internal editor
container to the owning control, flashes it, and focuses it. Save does not open a separate validation
modal.

New projects persist a stable default identity derived from the project ID. Existing projects with
only `settings.app.icon` retain that icon and receive normalized defaults from project metadata when
read. Identity edits replace the normalized app object through the command bus, which persists those
defaults instead of regenerating them later.

`editor.lastSuccessfulPlatformExportIdentity` is exporter-owned editor metadata, not project
content. Legacy `settings.app.lastExportedIdentity` values are migrated into that metadata channel
when a project opens and are removed from future content writes. Platform readiness compares the
selected target's effective application ID and save namespace with the last successfully published
identity. A change requires explicit confirmation because installed application identity or save
locations may change; cancellation publishes nothing, and existing save data is never moved
silently. The metadata record is flushed only after final target publication succeeds and does not
dirty a content save unit.

Missing default layout/font is not a validation error because built-in fallbacks exist. Missing entrypoint remains a general authoring warning but a package-export error.

Stable diagnostic codes, ownership paths, runtime/package classification, platform target scope,
and permitted fallbacks are listed in `PROJECT_VALIDATION_DIAGNOSTIC_MATRIX.md`.

## ComfyUI Workflows

Project Settings no longer manages workflow packages directly. It shows:

- total active workflows visible to the project;
- project-local workflow count;
- invalid project-local workflow count;
- a `Manage` button that opens the editor-owned `ComfyUI Workflows` tab.

The `ComfyUI Workflows` tab manages built-in, editor-wide, and project-local workflow sources. Project-local workflow files still live under the authoring project's `workflows/` directory, but importing, copying, deleting, repairing, revealing, and verifying workflow packages belongs in the manager instead of Project Settings.

Workflow import expects ComfyUI API workflow JSON exported with `File -> Export Workflow (API)`. Ordinary ComfyUI save files include visual editing data and are not the import format for this editor path.

Renaming important ComfyUI nodes before export is optional but improves automatic binding and later repair. Recommended title markers are:

```text
noveltea.prompt
noveltea.negativePrompt
noveltea.sourceImage
noveltea.maskImage
noveltea.width
noveltea.height
noveltea.seed
noveltea.steps
noveltea.cfg
noveltea.filenamePrefix
noveltea.output
```
