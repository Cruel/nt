# NovelTea Editor

Desktop visual novel editor built with Electron, React, and TypeScript.

## Requirements

- Node.js 20+
- pnpm 9+

## Setup

```sh
pnpm install
```

## Development

```sh
pnpm start
```

Launches the Electron application with Vite Hot Module Replacement.

## Commands

| Command          | Description                           |
| ---------------- | ------------------------------------- |
| `pnpm start`     | Launch the editor in development mode |
| `pnpm package`   | Package the editor for the platform   |
| `pnpm make`      | Create platform installers            |
| `pnpm lint`      | Run ESLint                            |
| `pnpm typecheck` | Run TypeScript type checking          |
| `pnpm test`      | Run Vitest tests                      |
| `pnpm test:watch`| Run tests in watch mode               |

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

| Channel                          | Purpose                        |
| -------------------------------- | ------------------------------ |
| `noveltea:get-app-info`          | App version and platform info  |
| `noveltea:select-project-directory` | Native directory picker    |
| `noveltea:open-external`         | Validated HTTP/HTTPS links     |

The renderer accesses these through `window.noveltea.*` with full TypeScript
types.

## Workspace Preview

The workspace preview area currently shows a placeholder. The NovelTea
web/WASM engine will be embedded here in a future phase. See the
[engine documentation](../engine) for the runtime project.

## Adding shadcn Components

The project uses the `base-mira` style with `@base-ui/react` primitives.

```sh
npx shadcn@latest add <component-name> -y
```

Available components are listed in the shadcn documentation. Currently
installed components:

- Button, Card, Badge, Input, Label, Switch, Select
- Dialog, DropdownMenu, Tooltip
- Separator, Skeleton, Sidebar
