import type { AuthoringProject } from '../project-schema/authoring-project';
import { parseAssetData } from '../project-schema/authoring-assets';
import { compareProjectWorkspaceUnicodeCodePoints } from './workspace-codepoint-order';

/** Downstream physical file inventory, not a Project semantic validator. */
export function assetSourcePaths(project: AuthoringProject): string[] {
  const paths = new Set<string>();
  for (const record of Object.values(project.assets)) {
    const asset = parseAssetData(record.data);
    const value = asset?.source.path;
    if (
      !value ||
      value.includes('\\') ||
      value.startsWith('/') ||
      /^[A-Za-z]:/.test(value) ||
      value.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('Asset source path is not a safe project-relative path.');
    paths.add(value);
  }
  return [...paths].sort(compareProjectWorkspaceUnicodeCodePoints);
}
