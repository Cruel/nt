import type { PreparedRuntimePackageOptions } from '../shared/project-schema/prepared-runtime-artifact';

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
  const pinnedEntries = options.fileEntries.filter((entry) => byPath.has(entry.packagePath));
  if (pinnedEntries.length === 0) return options;
  const pinnedPaths = new Set(pinnedEntries.map((entry) => entry.packagePath));
  return {
    ...options,
    fileEntries: options.fileEntries.filter((entry) => !pinnedPaths.has(entry.packagePath)),
    textEntries: [
      ...options.textEntries.filter((entry) => !pinnedPaths.has(entry.packagePath)),
      ...pinnedEntries.map((entry) => ({
        text: byPath.get(entry.packagePath)!.text,
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
