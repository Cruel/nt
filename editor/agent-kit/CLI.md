# NovelTea CLI

Use `noveltea --help` for the installed command surface. The normal workflow is:

1. Read `.noveltea/agent/GUIDE.md` and the focused docs it routes to for the requested task.
2. Edit tracked project files directly, completing the coherent logical change before treating validation as final.
3. Run `noveltea validate`.
4. Use semantic commands for project-wide operations.

Core semantic commands:

- `noveltea entity create <collection> <id> [--dry-run]`
- `noveltea entity rename <collection> <old-id> <new-id> [--dry-run] [--allow-possible-source-references]`
- `noveltea entity delete <collection> <id> [--dry-run] [--force] [--allow-possible-source-references]`
- `noveltea usages <collection> <id>`
- `noveltea validate`
- `noveltea agent sync`

Native tooling is exposed through the same executable for shader compilation, tests, raw bgfx shaderc forwarding, and package export. Use `--json` for deterministic machine-readable NovelTea command output where supported. Do not invent field-level setter commands; ordinary fields are edited in source files. `entity create` initializes one record against the current project; for multi-record authoring relationships, finish the required supporting edits before interpreting validation diagnostics as the final state.
