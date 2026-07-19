# NovelTea Editor

Desktop visual novel editor built with Electron, React, and TypeScript.

## Requirements

- Node.js 20+
- pnpm 9+
- Emscripten SDK activated in your shell for engine preview builds

## Setup

```sh
pnpm install
```

## Development

```sh
pnpm start
```

Launches the Electron application with Vite Hot Module Replacement. This does
not rebuild the C++ web target.

## Commands

| Command                     | Description                                                              |
| --------------------------- | ------------------------------------------------------------------------ |
| `pnpm start`                | Launch the editor in development mode                                    |
| `pnpm start:with-preview`   | Build the web engine preview, then launch the editor                     |
| `pnpm package`              | Package the editor for the platform                                      |
| `pnpm make`                 | Create platform installers                                               |
| `pnpm lint`                 | Run ESLint                                                               |
| `pnpm typecheck`            | Run TypeScript type checking                                             |
| `pnpm test`                 | Run Vitest tests                                                         |
| `pnpm test:watch`           | Run tests in watch mode                                                  |
| `pnpm engine:preview:build` | Configure and build `noveltea-sandbox` with the `web-debug` CMake preset |
| `pnpm engine:preview:clean` | Remove the development preview output directory                          |

## Architecture

The editor follows Electron's process model with three isolated layers:

- **`src/main.ts`** — Main process. Owns window creation, native dialogs, and
  IPC handlers. No UI code.
- **`src/preload.ts`** — Preload bridge. Exposes a typed `window.noveltea` API
  via `contextBridge`. No direct Node or renderer access.
- **`src/renderer/`** — Renderer process. A React single-page application
  rendered by Vite.

### Renderer structure

```
src/renderer/
  main.tsx              Entry point
  router.tsx            TanStack Router with hash history
  index.css             Tailwind CSS 4 + shadcn theme variables
  routeTree.gen.ts      Generated route tree
  routes/               File-based routes
  components/           React components
    ui/                 shadcn Base UI components
  stores/               Zustand state
  lib/                  Utilities
  test/                 Vitest tests
```

### IPC boundary

All native functionality crosses a typed IPC boundary:

| Channel                               | Purpose                                        |
| ------------------------------------- | ---------------------------------------------- |
| `noveltea:get-app-info`               | App version and platform info                  |
| `noveltea:select-project-directory`   | Native directory picker                        |
| `noveltea:open-external`              | Validated HTTP/HTTPS links                     |
| `noveltea:get-engine-preview-session` | Start/reuse the loopback engine preview server |
| `noveltea:reload-engine-preview`      | Restart the preview server/session             |

The renderer accesses these through `window.noveltea.*` with full TypeScript
types.

## Engine Preview

The workspace embeds the Emscripten build of `apps/sandbox` in an iframe served
from a main-process loopback HTTP server bound to `127.0.0.1` on an OS-assigned
port. The native SDL window is not embedded or reparented; the editor uses the
portable web target so the preview can live inside normal React layout.

Build the preview:

```sh
pnpm engine:preview:build
```

Run the editor:

```sh
pnpm start
```

Or build and run in one step:

```sh
pnpm start:with-preview
```

Development preview files are served from:

```text
../build/web-debug/apps/sandbox
```

The main process returns a typed `EnginePreviewSession` containing the iframe
URL, origin, and random session token. The preload exposes only
`getEnginePreviewSession()` and `reloadEnginePreview()` for this feature. After
the iframe sends a tokened hello, the renderer transfers a dedicated
`MessagePort`; commands and engine events then use the MessageChannel rather
than Electron IPC.

Current demonstration behavior:

- React controls send `set-demo-position`, `play`, `stop`, and `reset-demo`
  commands to C++ through Emscripten exports.
- The sandbox-only `SandboxDemoHarness` owns triangle position and hit testing;
  the engine retains only the general preview running state.
- Clicking the triangle emits `object-clicked`, selecting `demo-triangle` in
  the editor inspector and status bar.
- Zustand remains authoritative; current position/running state is replayed
  whenever the preview reloads.

Future preview commands/events should be added to
`src/shared/preview-protocol.ts`, validated at runtime, translated in
`web/shell.html`, and implemented as narrow C exports or engine events. Avoid
generic command interpreters and do not expose generic IPC.

Packaged builds resolve the preview from:

```text
process.resourcesPath/engine-preview
```

The Forge package hook copies only files from `../build/web-release/apps/sandbox`
when that release preview exists. If it does not exist, packaging still
completes and the app reports the missing preview build with the command to run.

## Adding shadcn Components

The project uses the `base-mira` style with `@base-ui/react` primitives.

```sh
pnpm dlx shadcn@latest add <component-name> -y
```

Available components are listed in the shadcn documentation. Currently
installed components:

- Button, Card, Badge, Input, Label, Switch, Select
- Dialog, DropdownMenu, Tooltip
- Separator, Skeleton, Sidebar
