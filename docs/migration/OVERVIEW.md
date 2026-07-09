# Migration Documentation Overview

## Purpose

Use this entrypoint before planning migration work, checking old NovelTea parity, updating current migration status, or deciding whether old behavior is still relevant.

## Current Documents

- `docs/migration/PLAN.md` is the current migration plan and phase index.
- `docs/migration/STATUS.md` records completed foundation, active gaps, verification, and next planning task.
- `docs/migration/COMPATIBILITY.md` records historical import/export notes only. It is not a requirement to preserve old project formats.
- `docs/migration/NEXT_STEPS_AFTER_RMLUI_BGFX.md` records a migration sequence after RmlUi/bgfx stabilization.
- `docs/archive/OVERVIEW.md` explains how to treat historical reports.

## Reference Sources

- `refs/NovelTea/` is old-engine reference code only. Do not edit it or treat it as a compatibility contract.
- Other `refs/` entries are upstream snapshots for reference only.

## Agent Rules

Update `docs/migration/STATUS.md` after non-trivial migration work so future sessions can resume without chat history.

If an archive or legacy-reference finding becomes an active requirement, copy it into a current plan/status/component doc instead of relying on the archive file.

Do not implement old project format compatibility unless explicitly requested or intentionally scoped as a narrow migration tool.
