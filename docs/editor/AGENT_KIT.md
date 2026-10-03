# Agent Kit

NovelTea embeds a versioned agent kit in the standalone `noveltea` CLI. It provides generated compact project-format references, raw schemas, and public guidance for coding agents without making generated documentation part of tracked project source.

## Versions and manifest

The initial release uses `agentKitVersion = 1` and `projectWorkspaceVersion = 1`. These are independent of both the CLI semantic version and the manifest schema identity. `.noveltea/agent/manifest.json` uses `noveltea.agent-kit.manifest` version `2`, records the actual packaged CLI version and workspace version, contains a deterministic SHA-256 for every generated kit file except the manifest itself, and carries the deterministic curator-provenance snapshot described below.

Changing kit wording, examples, workflow guidance, or generated schema payload may increment the agent-kit content version without changing the tracked workspace format. `noveltea agent sync` never performs project-schema migration. If the installed CLI cannot understand the project's workspace version, sync fails with a diagnostic directing the user to update/open the project through the editor.

## Source and generated content

Checked-in kit source lives under `editor/agent-kit/`. Stable guidance is hand-authored public documentation routed from the generated project `AGENTS.md` block through `.noveltea/agent/GUIDE.md`; the kit does not install or depend on an agent-framework skill. Machine-readable schemas are derived from the exact workspace-v1 Zod/contextual codecs rather than maintained as a second handwritten format definition. `schemaSources` in `editor/src/shared/project-schema/schema-reference.ts` owns the shared source list for raw schemas, compact Markdown under `.noveltea/agent/reference/`, and the website reference. `schema-reference-model.ts` normalizes input JSON Schema once into field requirements, defaults, constraints, explicit variants, and named/shared/recursive definitions; both presentation paths consume this model. Astro never interprets JSON Schema independently. The workspace manifest codec is shared directly with the executable workspace loader, including Inventories and Interactable Instances. The exact engine-owned `engine/assets/system/ui/` tree is also emitted under `.noveltea/agent/system-layouts/ui/` with a generated manifest covering both system-role fallbacks and the universal RCSS baseline cascade, so agents can inspect the built-in UI and the defaults applied to every Layout. Constraints JSON Schema cannot represent, such as project-wide path/ownership rules, are documented in generated `PROJECT_FORMAT.md` and enforced by the executable workspace loader.

Curator-only provenance is tracked in `editor/agent-kit-provenance.json`, deliberately outside `editor/agent-kit/` so recursive source collection cannot turn maintenance metadata into agent-facing content. The file defines normalized source identities once, including exact repository revisions when available or versioned web references when needed. Each hand-authored kit document must have exactly one provenance entry with a review date, short curation strategy, and one or more source references with relevant source areas. Payload generation rejects missing document provenance or references to unknown source identities. This exact normalized snapshot is copied into `manifest.json`; it is not emitted as another generated file and ordinary agent routing does not require reading it.

### Schema semantics and checked examples

Use `withSchemaDocumentation` from `schema-documentation.ts` beside canonical Zod definitions for
non-obvious public semantics: descriptions, semantic/cross-field constraints, lifecycle, status,
related concepts, and examples. Obvious fields need no annotation. Metadata uses Zod's supported
registry/metadata conversion boundary, not a second schema system. Generated Markdown is never
checked in as a source corpus.

An example contains exact JSON input and a title; larger examples may import a checked JSON fixture
and carry its source path. Generation rejects non-JSON values and examples that fail the annotated
canonical schema. Source attribution is not an unchecked example link: the imported value is still
embedded and validated. These are structural fragments, not proof of project-wide reference or
runtime validity; `noveltea validate` remains the contextual authority. The Interactable metadata
covers quantity versus aggregate creation, stackability restrictions, Location semantics, and a
complete Instance example.

`schema-reference-json.ts` isolates conversion and example checking for all outputs. It uses
`z.toJSONSchema` with input semantics. One narrow Zod tuple-definition lookup repairs the converter's
omitted tuple cardinality; it is not a general Zod-internals walker. JSON Schema still cannot express
all refinements or contextual checks, so generated guidance explicitly retains executable validation.
Named types are local to each generated domain document; raw schemas remain available as fallback.

Release builds embed the checked-in hand-authored kit source, curator provenance, and exact built-in system UI source as a private scriptc island package. `noveltea agent sync` combines those exact source texts with compact references and JSON Schemas generated from the shared Zod schemas and the generated system-Layout/baseline manifest, then writes and validates the deterministic manifest/hashes/provenance. Hand-authored Markdown and built-in RML/RCSS—including the engine-owned baseline files—are copied byte-for-byte; sync does not add or strip headers or maintain alternate agent-facing copies. This work is command-local: ordinary CLI operations do not generate the agent-kit schemas or system-Layout reference tree. See `SCRIPTC_COMPATIBILITY.md`.

## Project bootstrap and sync

New projects contain a root `AGENTS.md` with a clearly marked NovelTea-managed bootstrap block that tells agents to run `noveltea agent sync` before relying on generated guidance. Users own all content outside that block. Project creation also creates a root `.gitignore` containing `/.noveltea/` and `/dist/` when the file is absent; it never rewrites an existing `.gitignore`.

`noveltea agent sync` atomically and idempotently refreshes `.noveltea/agent/`. It also inspects the managed root bootstrap and reports missing, outdated, or malformed blocks without failing ordinary sync. `noveltea agent sync --fix` explicitly creates a missing `AGENTS.md`, inserts a missing block after an initial H1 (or at the start otherwise), or replaces only a valid outdated block. Malformed or duplicate markers require manual repair and make `--fix` fail without guessing. Content outside a valid block is preserved byte-for-byte.

Sync creates the canonical root `.gitignore` when it is absent. When an existing regular file contains both `.noveltea` and `dist` anywhere, NovelTea assumes the required rules are handled; when either is missing, sync succeeds with `AGENT_LOCAL_STATE_NOT_IGNORED` and leaves the file untouched. `--fix` does not modify an existing `.gitignore`. A non-file `AGENTS.md` or `.gitignore` is an error.

The generated kit tells agents to edit ordinary JSON/Lua/RML/RCSS source directly, complete coherent multi-record authoring edits before treating validation as final, run `noveltea validate`, and reserve semantic CLI commands for operations requiring whole-project knowledge or transactions. `GUIDE.md` routes structural questions to the generated `reference/index.md` domain index alongside focused conceptual and recipe docs; raw schemas remain the exhaustive structural fallback. `.noveltea/` is never a compilation input or authoring source.

## Editor coexistence

The project watcher ignores `.noveltea/`, so running `noveltea agent sync` while the editor is open must not publish an AuthoringProject mutation. Tracked external edits continue through the normal three-way reconciliation path described in `project/PROJECT_EXTERNAL_CHANGES_AND_CONFLICTS.md`.

## Certification

CLI differential certification covers sync generation, provenance inclusion, byte-exact hand-authored Markdown, byte-exact built-in system Layout and baseline references, system-role mapping, baseline cascade metadata, bootstrap inspection/repair, version/hash verification, repeated idempotent sync, rollback on injected swap failure, project creation, and Node/scriptc byte equivalence. Distribution verification additionally certifies standalone relocation and that production packages contain no prohibited first-party source maps or external runtime dependencies.
