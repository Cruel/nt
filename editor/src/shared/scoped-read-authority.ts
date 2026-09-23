export interface ScopedReadAuthorityEntry {
  readonly path: string;
  readonly sourceIdentity?: string;
  readonly byteSize?: number;
  readonly mtimeNanoseconds?: string | null;
  readonly contentHash?: string | null;
}

export interface ScopedReadAuthorityObservation {
  readonly delta: Readonly<{
    added: readonly string[];
    changed: readonly string[];
    removed: readonly string[];
  }>;
  readonly manifest: Readonly<{ entries: readonly ScopedReadAuthorityEntry[] }>;
}

export interface ScopedReadAuthorityToken {
  readonly canonicalRoot: string;
  readonly requiredSemanticPaths: readonly string[];
  readonly authoritySignature: string;
  readonly relevantDeltaPaths: readonly string[];
}

export function physicalPathRequiredBySemanticPaths(
  path: string,
  requiredSemanticPaths: readonly string[],
  assetSourcePaths: ReadonlySet<string>,
): boolean {
  if (requiredSemanticPaths.includes('/')) return true;
  for (const semanticPath of requiredSemanticPaths) {
    if (
      semanticPath === '/project' ||
      semanticPath.startsWith('/project/') ||
      semanticPath === '/settings' ||
      semanticPath.startsWith('/settings/') ||
      semanticPath === '/export' ||
      semanticPath.startsWith('/export/') ||
      semanticPath === '/bootstrapModule' ||
      semanticPath === '/entrypoint' ||
      semanticPath === '/inventories' ||
      semanticPath.startsWith('/inventories/') ||
      semanticPath === '/interactableInstances' ||
      semanticPath.startsWith('/interactableInstances/')
    ) {
      if (path === 'project.json') return true;
      continue;
    }
    if (semanticPath === '/assets' || semanticPath.startsWith('/assets/')) {
      if (
        /^records\/assets\/[^/]+\.json$/u.test(path) ||
        path.startsWith('assets/') ||
        assetSourcePaths.has(path)
      )
        return true;
      continue;
    }
    if (semanticPath === '/localization' || semanticPath.startsWith('/localization/')) {
      if (path === 'project.json' || path.startsWith('i18n/')) return true;
      continue;
    }
    const record = /^\/([^/]+)\/([^/]+)/u.exec(semanticPath);
    if (record && path === `records/${record[1]}/${record[2]}.json`) return true;
  }
  return false;
}

export function scopedAuthoritySignature(
  observation: ScopedReadAuthorityObservation,
  requiredSemanticPaths: readonly string[],
  assetSourcePaths: ReadonlySet<string>,
): string {
  return JSON.stringify(
    observation.manifest.entries
      .filter((entry) =>
        physicalPathRequiredBySemanticPaths(entry.path, requiredSemanticPaths, assetSourcePaths),
      )
      .map((entry) => [
        entry.path,
        entry.sourceIdentity ?? null,
        entry.byteSize ?? null,
        entry.mtimeNanoseconds ?? null,
        entry.contentHash ?? null,
      ]),
  );
}

export function scopedAuthorityRelevantDeltaPaths(
  observation: ScopedReadAuthorityObservation,
  requiredSemanticPaths: readonly string[],
  assetSourcePaths: ReadonlySet<string>,
): readonly string[] {
  return Object.freeze(
    [...observation.delta.added, ...observation.delta.changed, ...observation.delta.removed]
      .filter((path) =>
        physicalPathRequiredBySemanticPaths(path, requiredSemanticPaths, assetSourcePaths),
      )
      .sort(),
  );
}
