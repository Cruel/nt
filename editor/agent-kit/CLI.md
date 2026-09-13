# NovelTea CLI

Use `noveltea --help` for the installed command surface. The normal workflow is:

1. Read `.noveltea/agent/GUIDE.md` and the focused docs it routes to for the requested task.
2. Edit tracked project files directly, completing the coherent logical change before treating validation as final.
3. After direct edits to managed localizable Lua/RML, run `noveltea localization sync`.
4. Run `noveltea validate`.
5. Use semantic commands for project-wide operations.

Core semantic commands:

- `noveltea asset audit`
- `noveltea asset import <path>... [--dry-run]`
- `noveltea entity create <collection> <id> [--dry-run]`
- `noveltea entity rename <collection> <old-id> <new-id> [--dry-run] [--allow-possible-source-references]`
- `noveltea entity delete <collection> <id> [--dry-run] [--force] [--allow-possible-source-references]`
- `noveltea usages <collection> <id>`
- `noveltea localization sync [--dry-run]`
- `noveltea localization reconcile [--apply]`
- `noveltea localization view <locale> [--status <...>]`
- `noveltea localization accept <locale> <message-id>... [--dry-run]`
- `noveltea localization review <locale> <message-id>... [--dry-run]`
- `noveltea validate`
- `noveltea project export --output <bundle.ntproject>`
- `noveltea project import <bundle.ntproject> <destination-directory>`
- `noveltea agent sync`

Portable Project commands use `.ntproject` for editable Project transport: export captures the clean current Project authoring contract, while import validates the bundle and activates a fresh ordinary Project Workspace. `.ntproject` is distinct from runtime-only `.ntpkg` package export.

Native tooling is exposed through the same executable for shader compilation, tests, raw bgfx shaderc forwarding, and package export. Use `--json` for deterministic machine-readable NovelTea command output where supported. Do not invent field-level setter commands; ordinary fields are edited in source files. Passive validation/preview/source analysis never writes localization tracking; `localization sync` is the explicit transaction that records deterministic managed Lua/RML Message identity and leaves ambiguous occurrences for reconciliation. `localization reconcile` is read-only by default; use its JSON plan to decide ambiguous occurrences, then pass the plan revision/fingerprint plus occurrence resolutions on stdin to `localization reconcile --apply`. Stale plans are rejected, one prior Message may be relinked at most once, and valuable abandoned work is preserved as Orphaned instead of discarded. `localization view` is the joined source/target work queue; use status filters for agent batches. Target records keep text, source fingerprint, origin, review, and optional provider/model provenance. Use `localization accept` to acknowledge a new source fingerprint without claiming review, and `localization review` only for Current valid targets. `entity create` initializes one record against the current project; for multi-record authoring relationships, finish the required supporting edits before interpreting validation diagnostics as the final state.
