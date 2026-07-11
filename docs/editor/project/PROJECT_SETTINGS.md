# Project Settings

Project Settings is the editor surface for authoring-project settings that belong to the game/project itself. It is distinct from the existing Settings page, which is for editor preferences such as theme, density, window chrome, and restore behavior.

## Access

V1 exposes Project Settings in two places:

- `Project > Project Settings…`
- Package Export diagnostics, when export is blocked by project-level settings such as a missing entrypoint.

The command palette/quick-open surface is not implemented yet, so Project Settings is not currently exposed there.

## Stored Data

Project Settings edits the authoring project document through undoable command-bus operations. It does not write editor preferences.
ComfyUI connection settings and workflow-library management are editor-wide surfaces. Project Settings only shows a compact workflow summary and a Manage button; it must not write server URLs, enablement, default workflow preferences, or workflow-library state into the authoring project document.

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
settings.startup.initScript
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

Display settings default to a normalized 16:9 landscape viewport with black presentation bars.
The Display card provides common presets, custom positive integer ratio components, landscape or
portrait orientation, and bar color. These settings constrain aspect ratio; they are not a fixed
rendering resolution. Changes use the command bus and therefore participate in undo/redo and dirty
state.

## Built-In Fallbacks

System layout roles and default font support built-in fallback behavior. In V1, `null` or an
absent system layout role means the built-in engine layout for that role is used. This keeps
built-in title/menu/HUD documents compatible with project-authored replacements.

```ts
settings.ui.systemLayouts.title = null       // built-in title layout
settings.ui.systemLayouts.game-hud = null    // built-in gameplay HUD layout
settings.ui.systemLayouts.pause-menu = null  // built-in pause menu layout
settings.text.defaultFont = null             // built-in default font
```

Project layout/font records can override those fallbacks. The editor writes only `settings.ui.systemLayouts` for engine UI role overrides.

## Entrypoint Limitation

The authoring schema can structurally reference any known collection as `entrypoint`, but runtime package export currently accepts room entrypoints only. Project Settings therefore exposes a room-only entrypoint selector in V1.

Package Export remains strict: a missing entrypoint or non-room entrypoint blocks export until broader runtime conversion exists.

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

New projects persist a stable default identity derived from the project ID. Existing projects with
only `settings.app.icon` retain that icon and receive normalized defaults from project metadata when
read. Identity edits replace the normalized app object through the command bus, which persists those
defaults instead of regenerating them later.

`settings.app.lastExportedIdentity` is exporter-owned history. When present, changing the canonical
application ID or save namespace produces a migration warning: installed application identity or
save locations may change, and existing save data is never moved silently.

Missing default layout/font is not a validation error because built-in fallbacks exist. Missing entrypoint remains a general authoring warning but a package-export error.

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
