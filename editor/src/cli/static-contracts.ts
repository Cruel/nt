import { NOVELTEA_BUILD_IDENTITY, NOVELTEA_VERSION } from '../shared/product-version';

export const NOVELTEA_CLI_VERSION = NOVELTEA_VERSION;
export const NOVELTEA_CLI_BUILD_IDENTITY = NOVELTEA_BUILD_IDENTITY;
export const NOVELTEA_CLI_JSON_PROTOCOL_VERSION = 1 as const;

export const NOVELTEA_CLI_HELP = `NovelTea headless CLI

Usage:
  noveltea [--project <project-directory>] [--json] <command> ...

Commands:
  project create <directory> --name <project-name>
  project export --output <bundle.ntproject>
  project import <bundle.ntproject> <destination-directory>
  agent sync [--fix]
  comfyui status [--server <url>]
  comfyui workflows [--all]
  comfyui workflows <id>
  comfyui verify [<id>] [--server <url>]
  comfyui run [<workflow-id> | --type <classification>] [--input <name=value>]... [--output <routing>]... [--server <url>] [--force]
  validate
  localization sync [--dry-run]
  localization reconcile [--apply]
  localization view <locale> [--status <missing|current|outdated|needs-review|reviewed|human|ai|imported|unknown|attention>]
  localization accept <locale> <message-id>... [--dry-run]
  localization review <locale> <message-id>... [--dry-run]
  asset audit
  asset import <path>... [--dry-run]
  entity create <collection> <id> [--dry-run]
  entity rename <collection> <old-id> <new-id> [--dry-run] [--allow-possible-source-references]
  entity delete <collection> <id> [--dry-run] [--force] [--allow-possible-source-references]
  usages <collection> <id>
  shaders compile [--variant <id>]... [--force-rebuild]
  shaderc <bgfx-shaderc-args...>
  texturec <bimg-texturec-args...>
  test run [<test-id>]
  test run-spec
  test run-ui-spec
  package export --output <path> [--profile <profile-id>]
                 [--allow-localization-warnings]
                 [--include-unused-assets] [--include-shader-sources]
  platform profiles
  platform export --output <path> [--profile <id>] [--template <id>@<build>]
                  [--signing-profile <id>] [--config <file>] [--sign]
                  [--allow-localization-warnings]
                  [--include-unused-assets] [--include-shader-sources]
                  [--check] [--force]
                  [--allow-untrusted-template] [--allow-identity-change]
  platform template list
  platform template inspect <id>@<build>
  platform template install <archive> [--force]
  platform template remove <id>@<build> --force
  platform config init <path> [--force]

Global options:
  --project <project-directory>  Use this project root instead of upward project.json discovery.
  --json                         Emit one compact JSON object on stdout; stderr remains empty.
  --help                         Show this help.
  --version                      Show the CLI version.

Normal project editing policy:
  Run 'noveltea agent sync' before an agent session, then read '.noveltea/agent/GUIDE.md'.
  Edit record JSON, Lua, RML, and RCSS source files directly, run 'noveltea localization sync' after
  managed localizable source edits, then run 'noveltea validate'. Use semantic CLI commands only for
  operations that require project-wide dependency or transaction
  semantics, such as Asset import, create, rename, delete, and usages.
`;
