# Agent Kit

NovelTea embeds a versioned agent kit in the standalone `noveltea` CLI. It provides generated compact project-format references, raw schemas, and public guidance for coding agents without making generated documentation part of tracked project source.

## Versions and manifest

The initial release uses `agentKitVersion = 1` and `projectWorkspaceVersion = 1`. These are independent of both the CLI semantic version and the manifest schema identity. `.noveltea/agent/manifest.json` uses `noveltea.agent-kit.manifest` version `2`, records the actual packaged CLI version and workspace version, contains a deterministic SHA-256 for every generated kit file except the manifest itself, and carries the deterministic curator-provenance snapshot described below.

Changing kit wording, examples, workflow guidance, generated schema payload, or generated file layout may increment the Agent Kit content version without changing the tracked workspace format. The generated kit is current-only: `noveltea agent sync` atomically replaces an older generated layout instead of preserving compatibility files inside `.noveltea/agent/`. Sync never performs project-schema migration. If the installed CLI cannot understand the project's workspace version, sync fails with a diagnostic directing the user to update/open the project through the editor.

## Source and generated content

The Agent Kit has two checked-in hand-authored source roots with different responsibilities. `docs/public/concepts/` is the canonical audience-neutral engine-concept layer shared byte-for-byte with the Astro human documentation site; payload generation emits those exact files under `.noveltea/agent/concepts/`. `editor/agent-kit/` contains only the generated-kit entrypoint plus audience-specific material that cannot come from the public concept/schema layers: `workflows/` for concise coding-agent operating procedure and `technical/` for Lua/RmlUi/shader/Layout runtime authoring surfaces that are not expressible as Project schemas. There is no copied or manually distilled Rooms/Characters/Interactions/etc. manual under `editor/agent-kit/`, and the kit does not install or depend on an agent-framework skill.

Machine-readable schemas are derived from the exact workspace-v1 Zod/contextual codecs rather than maintained as a second handwritten format definition. `schemaSources` in `editor/src/shared/project-schema/schema-reference.ts` owns the shared source list for raw schemas, compact Markdown under `.noveltea/agent/reference/`, and the website reference. `schema-reference-model.ts` normalizes input JSON Schema once into field requirements, defaults, constraints, explicit variants, named/shared/recursive definitions, and NovelTea semantic metadata; both presentation paths consume this model. Astro never interprets JSON Schema independently. The workspace manifest codec is shared directly with the executable workspace loader, including Inventories and Interactable Instances. Project-wide workspace/path rules that are not properties of one schema live in the single agent workflow and executable workspace validation rather than in a second structural manual.

The exact engine-owned `engine/assets/system/ui/` tree is emitted under `.noveltea/agent/system-layouts/ui/`. A generated `.noveltea/agent/system-layouts/manifest.json` is the authoritative compact index for system-role fallbacks and the universal RCSS baseline cascade. Agent guidance points to that generated manifest/source instead of maintaining a second handwritten role/path table.

Curator-only provenance is tracked in `editor/agent-kit-provenance.json`, deliberately outside both author-facing source roots so recursive source collection cannot turn maintenance metadata into agent-facing content. The file defines normalized source identities once, including exact repository revisions when available or versioned web references when needed. Each hand-authored payload document—including canonical shared concept files—must have exactly one provenance entry with a review date, short curation strategy, and one or more source references with relevant source areas. Payload generation rejects missing document provenance or references to unknown source identities. This exact normalized snapshot is copied into `manifest.json`; it is not emitted as another generated file and ordinary agent routing does not require reading it.

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
Explicitly named structures reused by multiple schema documents are emitted once in
`reference/common.md`; domain documents reference those names instead of repeating their full shape.
Compact Markdown inlines anonymous converter reuse, so JSON-Schema implementation names never become
public authoring vocabulary. Raw fallback schemas retain standard local `$ref` reuse to avoid
duplicating large recursive/shared structures.

Release builds embed the checked-in agent-only source, canonical shared concepts, curator provenance, and exact built-in system UI source as a private ScriptC island package. `noveltea agent sync` composes those exact source texts with compact references and JSON Schemas generated from the shared Zod schemas plus the generated system-Layout/baseline manifest, then writes and validates deterministic hashes/provenance. Hand-authored Markdown and built-in RML/RCSS—including shared concept Markdown and the engine-owned baseline files—are copied byte-for-byte; generated reference Markdown is produced from the schema pipeline and is never checked in as an editable Agent Kit source. This work is command-local: ordinary CLI operations do not generate the Agent Kit schemas or system-Layout reference tree. See `SCRIPTC_COMPATIBILITY.md`.

## Project bootstrap and sync

New projects contain a root `AGENTS.md` with a clearly marked NovelTea-managed bootstrap block that tells agents to run `noveltea agent sync` before relying on generated guidance. Users own all content outside that block. Project creation also creates a root `.gitignore` containing `/.noveltea/` and `/dist/` when the file is absent; it never rewrites an existing `.gitignore`.

`noveltea agent sync` atomically and idempotently refreshes `.noveltea/agent/` as one complete generated directory. Candidate validation compares the complete file inventory as well as content, so obsolete files from a previous layout force regeneration and disappear when the candidate replaces the old kit. It also inspects the managed root bootstrap and reports missing, outdated, or malformed blocks without failing ordinary sync. `noveltea agent sync --fix` explicitly creates a missing `AGENTS.md`, inserts a missing block after an initial H1 (or at the start otherwise), or replaces only a valid outdated block. Malformed or duplicate markers require manual repair and make `--fix` fail without guessing. Content outside a valid block is preserved byte-for-byte.

Sync creates the canonical root `.gitignore` when it is absent. When an existing regular file contains both `.noveltea` and `dist` anywhere, NovelTea assumes the required rules are handled; when either is missing, sync succeeds with `AGENT_LOCAL_STATE_NOT_IGNORED` and leaves the file untouched. `--fix` does not modify an existing `.gitignore`. A non-file `AGENTS.md` or `.gitignore` is an error.

The generated kit tells agents to edit ordinary JSON/Lua/RML/RCSS source directly, complete coherent multi-record authoring edits before treating validation as final, run `noveltea validate`, and reserve semantic CLI commands for operations requiring canonical initialization, whole-project knowledge, transactions, external tooling, or execution. `GUIDE.md` explicitly routes the normal reasoning path through shared `concepts/` first, generated `reference/` second, initialized/existing records third, and raw `schemas/` only as an exhaustive fallback. `workflows/AUTHORING.md` contains the small agent-only operating procedure. `technical/` contains only authoring-language/runtime material the Project schema cannot express. `.noveltea/` is never a compilation input or authoring source.

## Editor coexistence

The project watcher ignores `.noveltea/`, so running `noveltea agent sync` while the editor is open must not publish an AuthoringProject mutation. Tracked external edits continue through the normal three-way reconciliation path described in `project/PROJECT_EXTERNAL_CHANGES_AND_CONFLICTS.md`.

## Certification

CLI differential certification covers composition of byte-exact shared concepts and agent-only sources, generated compact references/raw schemas, provenance inclusion, byte-exact built-in system Layout/baseline references, system-role mapping, baseline cascade metadata, bootstrap inspection/repair, Agent Kit version/hash verification, stale-layout replacement, repeated idempotent sync, rollback on injected swap failure, project creation, and Node/ScriptC byte equivalence. Distribution verification additionally certifies standalone relocation and that production packages contain no prohibited first-party source maps or external runtime dependencies.
