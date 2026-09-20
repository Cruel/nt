import { resolveProjectDiagnosticTarget } from '@/diagnostics/diagnostic-navigation';
import type { WorkbenchNavigationRequest } from '@/workbench/workbench-navigation';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import type { AssetProfilerAssetType } from '../../shared/asset-profiler-protocol';

function pointerSegment(value: string) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function projectPath(value: string) {
  return value.startsWith('project:/') ? value.slice('project:/'.length) : value;
}

function unique<T>(values: T[]): T | null {
  const candidates = [...new Set(values)];
  return candidates.length === 1 ? candidates[0]! : null;
}

function assetRecordId(
  project: AuthoringProject,
  displayIdentity: string,
  kind: 'image' | 'audio',
) {
  const expectedPath = projectPath(displayIdentity);
  return unique(
    Object.entries(project.assets)
      .filter(([, record]) => {
        const data = parseAssetData(record.data);
        return data?.kind === kind && projectPath(data.source.path) === expectedPath;
      })
      .map(([id]) => id),
  );
}

function fontRecordId(project: AuthoringProject, displayIdentity: string) {
  const separator = displayIdentity.lastIndexOf('|');
  const alias = separator < 0 ? displayIdentity : displayIdentity.slice(0, separator);
  const record = project.assets[alias];
  return record && parseAssetData(record.data)?.kind === 'font' ? alias : null;
}

export function resolveAssetProfilerIdentityTarget(
  project: AuthoringProject,
  assetType: AssetProfilerAssetType | null,
  displayIdentity: string | null,
): WorkbenchNavigationRequest | null {
  if (!assetType || !displayIdentity) return null;

  let collection: 'assets' | 'materials';
  let id: string | null;
  switch (assetType) {
    case 'image':
    case 'audio':
      collection = 'assets';
      id = assetRecordId(project, displayIdentity, assetType);
      break;
    case 'font':
      collection = 'assets';
      id = fontRecordId(project, displayIdentity);
      break;
    case 'material':
      collection = 'materials';
      id = project.materials[displayIdentity] ? displayIdentity : null;
      break;
    case 'shader':
      return null;
  }
  return id
    ? resolveProjectDiagnosticTarget(project, `/${collection}/${pointerSegment(id)}`)
    : null;
}
