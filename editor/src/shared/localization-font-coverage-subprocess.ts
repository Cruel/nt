import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type {
  LocalizationFontCoverageRequest,
  LocalizationFontCoverageResponse,
} from './localization-font-coverage';
import { invokeNovelTeaNativeOperation, resolveNovelTeaCliPath } from './noveltea-cli-subprocess';

function executableDirectories(): readonly string[] {
  const values = new Set<string>();
  for (const executable of [process.execPath, resolveNovelTeaCliPath()]) {
    values.add(path.dirname(executable));
    try {
      values.add(path.dirname(realpathSync(executable)));
    } catch {
      // The normal candidate probing below reports the eventual missing asset root.
    }
  }
  return [...values];
}

export function resolveLocalizationSystemAssetRoot(): string {
  const runtime = process as NodeJS.Process & { defaultApp?: boolean; resourcesPath?: string };
  if (
    typeof process.versions.electron === 'string' &&
    runtime.defaultApp !== true &&
    runtime.resourcesPath
  )
    return path.join(runtime.resourcesPath, 'editor-assets', 'system');

  const executableCandidates = executableDirectories().flatMap((directory) => [
    path.join(directory, 'assets', 'system'),
    path.join(directory, '..', 'editor-assets', 'system'),
  ]);
  for (const candidate of [
    ...executableCandidates,
    path.resolve(process.cwd(), '..', 'engine', 'assets', 'system'),
    path.resolve(process.cwd(), 'engine', 'assets', 'system'),
  ])
    if (existsSync(candidate)) return candidate;
  return path.resolve(process.cwd(), '..', 'engine', 'assets', 'system');
}

export async function runLocalizationFontCoverage(
  request: LocalizationFontCoverageRequest,
): Promise<LocalizationFontCoverageResponse> {
  return (await invokeNovelTeaNativeOperation(
    'font-coverage',
    request,
  )) as LocalizationFontCoverageResponse;
}
