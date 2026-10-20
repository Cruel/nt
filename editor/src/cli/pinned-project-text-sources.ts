import type { PreparedRuntimePackageOptions } from '../shared/project-schema/prepared-runtime-artifact';
import type { RuntimeArtifactPathAdapter } from '../shared/runtime-artifact-preparation';
import { createHash } from 'node:crypto';

export type PinnedProjectTextSources = Readonly<
  Record<string, Readonly<{ text: string; contentHash?: string }>>
>;

function normalizeProjectRelativePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\/+/, '');
}

export function pinnedProjectTextSourceRequest(sources: PinnedProjectTextSources | undefined) {
  if (!sources) return {};
  return {
    projectTextSources: Object.fromEntries(
      Object.entries(sources).map(([relativePath, source]) => [
        normalizeProjectRelativePath(relativePath),
        source.text,
      ]),
    ),
  };
}

export function packageOptionsWithPinnedProjectTextSources(
  options: PreparedRuntimePackageOptions,
  sources: PinnedProjectTextSources | undefined,
): PreparedRuntimePackageOptions {
  if (!sources) return options;
  const byPath = new Map(
    Object.entries(sources).map(([relativePath, source]) => [
      normalizeProjectRelativePath(relativePath),
      source,
    ]),
  );
  const pinnedSource = (packagePath: string) =>
    byPath.get(packagePath) ??
    (packagePath.startsWith('licenses/')
      ? byPath.get(packagePath.slice('licenses/'.length))
      : undefined);
  const pinnedEntries = options.fileEntries.filter((entry) => pinnedSource(entry.packagePath));
  if (pinnedEntries.length === 0) return options;
  const pinnedPaths = new Set(pinnedEntries.map((entry) => entry.packagePath));
  return {
    ...options,
    fileEntries: options.fileEntries.filter((entry) => !pinnedPaths.has(entry.packagePath)),
    textEntries: [
      ...options.textEntries.filter((entry) => !pinnedPaths.has(entry.packagePath)),
      ...pinnedEntries.map((entry) => ({
        text: pinnedSource(entry.packagePath)!.text,
        packagePath: entry.packagePath,
        storage: entry.storage,
      })),
    ],
  };
}

export function pinnedShaderSourceOverlays(
  sources: PinnedProjectTextSources | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!sources) return undefined;
  const entries = Object.entries(sources)
    .map(
      ([relativePath, source]) =>
        [normalizeProjectRelativePath(relativePath), source.text] as const,
    )
    .filter(([relativePath]) => relativePath.startsWith('shaders/'));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** A disposable worker must verify shader dependencies against its admitted generation, never disk. */
export function runtimeArtifactPathsWithPinnedSources(
  paths: RuntimeArtifactPathAdapter,
  sources: PinnedProjectTextSources | undefined,
): RuntimeArtifactPathAdapter {
  if (!sources) return paths;
  const byPath = new Map(
    Object.entries(sources).map(([relativePath, source]) => [
      normalizeProjectRelativePath(relativePath),
      source,
    ]),
  );
  return {
    ...paths,
    async readProjectTextSources(_projectRoot, entries) {
      return entries.map(({ assetId, projectRelativePath, expectedContentHash }) => {
        const source = byPath.get(normalizeProjectRelativePath(projectRelativePath));
        if (!source) return { status: 'unavailable' as const, assetId };
        const contentHash = (source.contentHash ??
          `sha256:${createHash('sha256').update(source.text, 'utf8').digest('hex')}`) as `sha256:${string}`;
        if (expectedContentHash !== null && expectedContentHash !== contentHash)
          return { status: 'unavailable' as const, assetId };
        return {
          status: 'ready' as const,
          assetId,
          projectRelativePath,
          contentHash,
          text: source.text,
          byteLength: Buffer.byteLength(source.text, 'utf8'),
        };
      });
    },
  };
}
