# Migration Documentation Overview

## Purpose

Use this entrypoint before planning migration work, checking old NovelTea parity, updating current migration status, or deciding whether old behavior is still relevant.

## Current Documents

- `docs/migration/STATUS.md` records final typed-runtime closure, verification, and remaining
  independently owned work.
- `docs/architecture/RUNTIME_CAPABILITY_DISPOSITION.md` is the durable final capability map for the
  typed-runtime migration.
- `docs/migration/audits/CORE_ENGINE_UNMIGRATED_AUDIT.md` maps useful legacy capabilities to their
  typed target subsystem and explicitly rejects obsolete APIs and storage shapes. It is a capability
  decision table, not a class-parity backlog.
- `docs/archive/OVERVIEW.md` explains how to treat historical reports.

## Reference Sources

- `refs/NovelTea/` is old-engine reference code only. Do not edit it or treat it as a compatibility contract.
- Other `refs/` entries are upstream snapshots for reference only.

## Agent Rules

Update `docs/migration/STATUS.md` after non-trivial migration work so future sessions can resume without chat history.

If an archive or legacy-reference finding becomes an active requirement, copy it into a current plan/status/component doc instead of relying on the archive file.

Do not implement old project format compatibility unless explicitly requested or intentionally scoped as a narrow migration tool.
