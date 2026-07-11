import type { PlatformStageResult } from '../shared/project-schema/platform-export-contracts';
import { exportProjectToPlatform } from '../main/services/platform-export-orchestration-service';
import { readFile } from 'node:fs/promises';

export interface ExportCommandArguments {
  projectPath: string;
  profileId: string;
  outputDirectory: string;
  json: boolean;
  configPath?: string;
}

function valueAfter(argv: string[], option: string) {
  const index = argv.indexOf(option);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function parseExportCommandArguments(argv: string[]): ExportCommandArguments {
  const projectPath = valueAfter(argv, '--project');
  const profileId = valueAfter(argv, '--profile');
  const outputDirectory = valueAfter(argv, '--output');
  if (!projectPath || !profileId || !outputDirectory) {
    throw new Error('Usage: NovelTea Editor --export-project --project <project> --profile <profile-id> --output <directory> [--config <local-settings.json>] [--json]');
  }
  return { projectPath, profileId, outputDirectory, configPath: valueAfter(argv, '--config'), json: argv.includes('--json') };
}

export function exitCodeForExportResult(result: PlatformStageResult) {
  if (result.success) return 0;
  const codes = new Set(result.diagnostics.map((item) => item.code));
  if (codes.has('profile-missing') || codes.has('invalid-project') || codes.has('project-validation-failed') || codes.has('runtime-conversion-failed')) return 2;
  if ([...codes].some((code) => code.startsWith('template-'))) return 3;
  if ([...codes].some((code) => code.includes('toolchain') || code.includes('host'))) return 4;
  if (result.cancelled) return 6;
  return 5;
}

export async function runExportCommand(args: ExportCommandArguments): Promise<{ result: PlatformStageResult; output: string; exitCode: number }> {
  let localState: Parameters<typeof exportProjectToPlatform>[0]['localState'];
  if (args.configPath) localState = JSON.parse(await readFile(args.configPath, 'utf8')) as typeof localState;
  const result = await exportProjectToPlatform({ projectPath: args.projectPath, profileId: args.profileId, outputDirectory: args.outputDirectory, localState });
  const output = args.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `${result.success ? 'Export succeeded' : 'Export failed'}: ${args.profileId} -> ${args.outputDirectory}\n${result.diagnostics.map((item) => `[${item.severity}] ${item.code}: ${item.message}`).join('\n')}${result.diagnostics.length ? '\n' : ''}`;
  return { result, output, exitCode: exitCodeForExportResult(result) };
}
