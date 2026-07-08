# Project Settings

Project Settings is the editor surface for authoring-project settings that belong to the game/project itself. It is distinct from the existing Settings page, which is for editor preferences such as theme, density, window chrome, and restore behavior.

## Access

V1 exposes Project Settings in two places:

- `Project > Project Settings…`
- Package Export diagnostics, when export is blocked by project-level settings such as a missing entrypoint.

The command palette/quick-open surface is not implemented yet, so Project Settings is not currently exposed there.

## Stored Data

Project Settings edits the authoring project document through undoable command-bus operations. It does not write editor preferences.
ComfyUI connection settings are editor-wide preferences in the Settings tab. Project Settings may expose project-local ComfyUI workflow installation/diagnostics, but it must not write server URLs, enablement, or default workflow preferences into the authoring project document.

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
```

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

Missing default layout/font is not a validation error because built-in fallbacks exist. Missing entrypoint remains a general authoring warning but a package-export error.
