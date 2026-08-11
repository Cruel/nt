# Agent Kit

NovelTea embeds a versioned agent kit in the standalone `noveltea` CLI. It provides generated project-format schemas plus public guidance for coding agents without making generated documentation part of tracked project source.

## Versions and manifest

The initial release uses `agentKitVersion = 1` and `projectWorkspaceVersion = 1`. These are independent of both the CLI semantic version and the manifest schema identity. `.noveltea/agent/manifest.json` uses `noveltea.agent-kit.manifest` version `1`, records the actual packaged CLI version and workspace version, and contains a deterministic SHA-256 for every generated kit file except the manifest itself.

Changing kit wording, examples, workflow guidance, or generated schema payload may increment the agent-kit content version without changing the tracked workspace format. `noveltea agent sync` never performs project-schema migration. If the installed CLI cannot understand the project's workspace version, sync fails with a diagnostic directing the user to update/open the project through the editor.

## Source and generated content

Checked-in kit source lives under `editor/agent-kit/`. Stable guidance and `skill/SKILL.md` are hand-authored public resources. Machine-readable schemas are derived from the exact workspace-v1 Zod/contextual codecs rather than maintained as a second handwritten format definition. Constraints JSON Schema cannot represent, such as project-wide path/ownership rules, are documented in generated `PROJECT_FORMAT.md` and enforced by the executable workspace loader.

Release builds materialize a complete candidate kit with the Node reference implementation, verify its deterministic manifest/hashes, and embed those exact bytes into Perry. Perry 0.5.1220 currently cannot execute Zod's `toJSONSchema` closure correctly in the full release graph, so schema generation is intentionally a verified build-time step rather than runtime regeneration. The compatibility record and removal gate are in `PERRY_COMPATIBILITY.md`.

## Project bootstrap and sync

New projects contain a thin, user-owned root `AGENTS.md` that tells agents to run `noveltea agent sync` before relying on generated guidance. Project creation also adds a root-scoped `/.noveltea/` ignore rule while preserving unrelated `.gitignore` content.

`noveltea agent sync` refreshes only `.noveltea/agent/`. It is atomic and idempotent: an unchanged current kit causes no second content-tree replacement, and a failed swap leaves the previous complete kit intact. Sync does not rewrite tracked project content, root `AGENTS.md`, or editor-local state outside the agent namespace.

The generated kit tells agents to edit ordinary JSON/Lua/RML/RCSS source directly, run `noveltea validate`, and reserve semantic CLI commands for operations requiring whole-project knowledge or transactions. `.noveltea/` is never a compilation input or authoring source.

## Editor coexistence

The project watcher ignores `.noveltea/`, so running `noveltea agent sync` while the editor is open must not publish an AuthoringProject mutation. Tracked external edits continue through the normal three-way reconciliation path described in `project/PROJECT_EXTERNAL_CHANGES_AND_CONFLICTS.md`.

## Certification

CLI differential certification covers sync generation, version/hash verification, repeated idempotent sync, rollback on injected swap failure, and Node/Perry byte equivalence. Distribution verification additionally certifies that the embedded kit matches its manifest and that production packages contain no prohibited TypeScript/source-map leakage.
