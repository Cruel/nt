# Agent Kit

NovelTea embeds a versioned agent kit in the standalone `noveltea` CLI. It provides generated project-format schemas plus public guidance for coding agents without making generated documentation part of tracked project source.

## Versions and manifest

The initial release uses `agentKitVersion = 1` and `projectWorkspaceVersion = 1`. These are independent of both the CLI semantic version and the manifest schema identity. `.noveltea/agent/manifest.json` uses `noveltea.agent-kit.manifest` version `1`, records the actual packaged CLI version and workspace version, and contains a deterministic SHA-256 for every generated kit file except the manifest itself.

Changing kit wording, examples, workflow guidance, or generated schema payload may increment the agent-kit content version without changing the tracked workspace format. `noveltea agent sync` never performs project-schema migration. If the installed CLI cannot understand the project's workspace version, sync fails with a diagnostic directing the user to update/open the project through the editor.

## Source and generated content

Checked-in kit source lives under `editor/agent-kit/`. Stable guidance and `skill/SKILL.md` are hand-authored public resources. Machine-readable schemas are derived from the exact workspace-v1 Zod/contextual codecs rather than maintained as a second handwritten format definition. Constraints JSON Schema cannot represent, such as project-wide path/ownership rules, are documented in generated `PROJECT_FORMAT.md` and enforced by the executable workspace loader.

Release builds embed the checked-in hand-authored kit source as a private scriptc island package. `noveltea agent sync` combines those exact source texts with JSON Schemas generated from the shared Zod schemas, then writes and validates the deterministic manifest/hashes. This work is command-local: ordinary CLI operations do not generate the agent-kit schemas. See `SCRIPTC_COMPATIBILITY.md`.

## Project bootstrap and sync

New projects contain a root `AGENTS.md` with a clearly marked NovelTea-managed bootstrap block that tells agents to run `noveltea agent sync` before relying on generated guidance. Users own all content outside that block. Project creation also creates a root `.gitignore` containing `/.noveltea/` when the file is absent; it never rewrites an existing `.gitignore`.

`noveltea agent sync` atomically and idempotently refreshes `.noveltea/agent/`. It also inspects the managed root bootstrap and reports missing, outdated, or malformed blocks without failing ordinary sync. `noveltea agent sync --fix` explicitly creates a missing `AGENTS.md`, inserts a missing block after an initial H1 (or at the start otherwise), or replaces only a valid outdated block. Malformed or duplicate markers require manual repair and make `--fix` fail without guessing. Content outside a valid block is preserved byte-for-byte.

Sync creates the canonical root `.gitignore` when it is absent. When an existing regular file contains `.noveltea` anywhere, NovelTea assumes the user has handled the rule; when it does not, sync succeeds with `AGENT_LOCAL_STATE_NOT_IGNORED` and leaves the file untouched. `--fix` does not modify an existing `.gitignore`. A non-file `AGENTS.md` or `.gitignore` is an error.

The generated kit tells agents to edit ordinary JSON/Lua/RML/RCSS source directly, run `noveltea validate`, and reserve semantic CLI commands for operations requiring whole-project knowledge or transactions. `.noveltea/` is never a compilation input or authoring source.

## Editor coexistence

The project watcher ignores `.noveltea/`, so running `noveltea agent sync` while the editor is open must not publish an AuthoringProject mutation. Tracked external edits continue through the normal three-way reconciliation path described in `project/PROJECT_EXTERNAL_CHANGES_AND_CONFLICTS.md`.

## Certification

CLI differential certification covers sync generation, bootstrap inspection/repair, version/hash verification, repeated idempotent sync, rollback on injected swap failure, project creation, and Node/scriptc byte equivalence. Distribution verification additionally certifies standalone relocation and that production packages contain no prohibited first-party source maps or external runtime dependencies.
