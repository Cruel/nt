import { parseAssetData, isSafeProjectAttachmentPath } from './project-schema/authoring-assets';
import type { AuthoringProject } from './project-schema/authoring-project';
import { projectSettingsFromProject } from './project-schema/authoring-project-settings';
import type { RuntimeArtifactPathAdapter } from './runtime-artifact-preparation';

export interface NoticeInventory {
  fileEntries: { source: string; packagePath: string; storage: 'stored'; expectedSha256: string }[];
  textEntry: { text: string; packagePath: string; storage: 'compressed' };
  revisions: { path: string; hash: string }[];
}

function hasProhibitedControls(text: string): boolean {
  for (const character of text) {
    const value = character.codePointAt(0)!;
    if (
      (value < 32 && value !== 9 && value !== 10 && value !== 13) ||
      (value >= 127 && value <= 159)
    )
      return true;
  }
  return false;
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1)
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
}

export async function collectRuntimeDistributionNotices(
  project: AuthoringProject,
  includedAssetIds: ReadonlySet<string>,
  projectRoot: string | null,
  paths: RuntimeArtifactPathAdapter,
): Promise<NoticeInventory> {
  const notices = new Map<string, { name: string; explicit: boolean }>();
  const add = (file: { path: string; displayName?: string }) => {
    if (!isSafeProjectAttachmentPath(file.path) || !/\.(txt|md)$/i.test(file.path))
      throw new Error(`Invalid distribution notice path '${file.path}'.`);
    const existing = notices.get(file.path);
    if (existing && existing.explicit && file.displayName && existing.name !== file.displayName)
      throw new Error(`Conflicting distribution notice names for '${file.path}'.`);
    if (!existing || (!existing.explicit && file.displayName))
      notices.set(file.path, {
        name: file.displayName ?? file.path.split('/').at(-1)!,
        explicit: !!file.displayName,
      });
  };
  for (const notice of projectSettingsFromProject(project).distributionNotices) add(notice);
  for (const assetId of [...includedAssetIds].sort()) {
    const asset = parseAssetData(project.assets[assetId]?.data);
    for (const notice of asset?.attachments ?? [])
      if (notice.purpose === 'distribution-notice') add(notice);
  }
  const ordered = [...notices].sort(([a], [b]) => compareUnicodeCodePoints(a, b));
  // Each collection has its own 512-entry runtime catalog limit. Fail during preparation
  // instead of producing a package that the canonical reader or viewer cannot load.
  if (ordered.length > 512)
    throw new Error('Project distribution notices exceed the 512-entry runtime limit.');
  if (ordered.length > 0 && !paths.readProjectTextSources)
    throw new Error('Distribution notice bytes cannot be verified in this host.');
  const requests = ordered.map(([projectRelativePath], index) => ({
    assetId: `distribution-notice:${index}`,
    projectRelativePath,
    expectedContentHash: null,
  }));
  const results: Awaited<
    ReturnType<NonNullable<RuntimeArtifactPathAdapter['readProjectTextSources']>>
  >[number][] = [];
  // The existing text-source boundary caps aggregate reads at 16 MiB; stay below it even
  // when an authored Project has many independently required notices.
  for (let offset = 0; offset < requests.length; offset += 12)
    results.push(
      ...(await paths.readProjectTextSources!(projectRoot, requests.slice(offset, offset + 12))),
    );
  const byId = new Map(results.map((result) => [result.assetId, result]));
  const entries = ordered.map(([relative, value], index) => {
    const read = byId.get(`distribution-notice:${index}`);
    if (!read || read.status !== 'ready' || read.projectRelativePath !== relative)
      throw new Error(`Distribution notice '${relative}' is missing, unsafe, or invalid UTF-8.`);
    if (
      (read.byteLength ?? new TextEncoder().encode(read.text).length) === 0 ||
      (read.byteLength ?? new TextEncoder().encode(read.text).length) > 1024 * 1024 ||
      hasProhibitedControls(read.text)
    )
      throw new Error(
        `Distribution notice '${relative}' is empty, too large, or contains prohibited controls.`,
      );
    return {
      path: `licenses/${relative}`,
      source: relative,
      displayName: value.name,
      contentHash: read.contentHash,
    };
  });
  return {
    fileEntries: entries.map((entry) => ({
      source: paths.resolveProjectSource(projectRoot, entry.source),
      packagePath: entry.path,
      storage: 'stored' as const,
      expectedSha256: entry.contentHash,
    })),
    textEntry: {
      text: JSON.stringify({
        schema: 'noveltea.project-notices',
        notices: entries.map(({ path, source, displayName, contentHash }) => ({
          path,
          source,
          displayName,
          contentHash,
        })),
      }),
      packagePath: 'licenses/index.json',
      storage: 'compressed',
    },
    revisions: entries.map(({ source, contentHash }) => ({ path: source, hash: contentHash })),
  };
}
