export const NOVELTEA_CLI_VERSION = '1.0.0' as const;

export const NOVELTEA_CLI_HELP = `NovelTea headless CLI

Usage:
  noveltea [--project <project-directory>] [--json] <command> ...

Commands:
  project create <directory> --name <project-name>
  agent sync [--fix]
  validate
  entity create <collection> <id> [--dry-run]
  entity rename <collection> <old-id> <new-id> [--dry-run] [--allow-possible-source-references]
  entity delete <collection> <id> [--dry-run] [--force] [--allow-possible-source-references]
  usages <collection> <id>
  shaders compile [--variant <id>]... [--force-rebuild]
  shaderc <bgfx-shaderc-args...>
  test run <test-id>
  test run-spec
  test run-ui-spec
  package export --output <path> [--profile <profile-id>]

Global options:
  --project <project-directory>  Use this project root instead of upward project.json discovery.
  --json                         Emit one compact JSON object on stdout; stderr remains empty.
  --help                         Show this help.
  --version                      Show the CLI version.

Normal project editing policy:
  Run 'noveltea agent sync' before an agent session, then read '.noveltea/agent/GUIDE.md'.
  Edit record JSON, Lua, RML, and RCSS source files directly, then run 'noveltea validate'.
  Use semantic CLI commands only for operations that require project-wide dependency or transaction
  semantics, such as create, rename, delete, and usages.
`;
