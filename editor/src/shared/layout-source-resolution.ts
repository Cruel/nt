import type { AuthoringProject } from './project-schema/authoring-project';
import { isSafeProjectAssetPath, parseAssetData } from './project-schema/authoring-assets';

function dirnameProjectPath(value: string): string {
  const separator = value.lastIndexOf('/');
  return separator < 0 ? '' : value.slice(0, separator);
}

export function normalizeProjectRelativePath(value: string): string | null {
  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const normalized = segments.join('/');
  return normalized && isSafeProjectAssetPath(normalized) ? normalized : null;
}

export function resolveLayoutProjectUri(uri: string, containingPath: string | null): string | null {
  const trimmed = uri.trim();
  if (
    !trimmed ||
    /[?#\\]/.test(trimmed) ||
    trimmed.startsWith('//') ||
    /^[a-zA-Z]:/.test(trimmed) ||
    (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !trimmed.startsWith('project:/'))
  )
    return null;
  const projectAbsolute = trimmed.startsWith('project:/');
  const relative = projectAbsolute ? trimmed.slice('project:/'.length) : trimmed;
  const base = containingPath ? dirnameProjectPath(containingPath) : '';
  return normalizeProjectRelativePath(
    projectAbsolute ? relative : [base, relative].filter(Boolean).join('/'),
  );
}

export function layoutSourceUrlForAssetPath(projectRelativePath: string): string {
  const normalized = normalizeProjectRelativePath(projectRelativePath);
  if (!normalized) throw new Error(`Unsafe Layout source path '${projectRelativePath}'.`);
  return `project:/${normalized}`;
}

export function authoringAssetPath(project: AuthoringProject, assetId: string): string | null {
  return parseAssetData(project.assets[assetId]?.data)?.source.path ?? null;
}

export function declaredLayoutDependencyByResolvedPath(
  project: AuthoringProject,
  ids: readonly string[],
  requiredKind: 'script' | 'template',
  resolvedPath: string,
): string | null {
  const matches = ids.filter((id) => {
    const data = parseAssetData(project.assets[id]?.data);
    if (!data || data.source.path !== resolvedPath) return false;
    if (requiredKind === 'script') return data.kind === 'script';
    const basename = data.source.path.slice(data.source.path.lastIndexOf('/') + 1);
    return data.kind === 'text' && basename.toLowerCase().endsWith('.rml');
  });
  return matches.length === 1 ? matches[0]! : null;
}
