# Project Settings

Project Settings is the editor surface for authoring-project settings that belong to the game/project itself. It is distinct from the existing Settings page, which is for editor preferences such as theme, density, window chrome, and restore behavior.

## Access

V1 exposes Project Settings in two places:

- `Project > Project Settings…`
- Package Export diagnostics, when export is blocked by project-level settings such as a missing entrypoint.

The command palette/quick-open surface is not implemented yet, so Project Settings is not currently exposed there.

## Stored Data

Project Settings edits the authoring project document through undoable command-bus operations. It does not write editor preferences.

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
settings.ui.defaultLayout
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

Default layout and default font support built-in fallback behavior. In V1, `null` or an absent setting means the built-in default resource is used.

```ts
settings.ui.defaultLayout = null      // built-in default layout
settings.text.defaultFont = null      // built-in default font
```

Project layout/font records can override those fallbacks.

## Entrypoint Limitation

The authoring schema can structurally reference any known collection as `entrypoint`, but runtime package export currently accepts room entrypoints only. Project Settings therefore exposes a room-only entrypoint selector in V1.

Package Export remains strict: a missing entrypoint or non-room entrypoint blocks export until broader runtime conversion exists.

## Validation

Project Settings adds typed validation for:

- project title;
- semver-like project version warnings;
- startup init script shape;
- default layout refs;
- default font refs, which must point to font assets;
- title image refs, which must point to image assets;
- project icon refs, which must point to image assets.

Missing default layout/font is not a validation error because built-in fallbacks exist. Missing entrypoint remains a general authoring warning but a package-export error.
