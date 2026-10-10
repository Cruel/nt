import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { collectRuntimeDistributionNotices } from '../../shared/runtime-distribution-notices';
import type { RuntimeArtifactPathAdapter } from '../../shared/runtime-artifact-preparation';

const digest = (text: string) =>
  `sha256:${createHash('sha256').update(text).digest('hex')}` as const;

function fixture(contents: Record<string, string>) {
  const project = createAuthoringProject({ name: 'Notices', version: '1.0.0', author: 'Tester' });
  project.settings.distributionNotices = [
    { path: 'support/licenses/global.md', displayName: 'Project notice' },
  ];
  for (const id of ['included', 'excluded']) {
    const data = assetDataFromImportMetadata({
      kind: 'image',
      projectRelativePath: `assets/images/${id}.png`,
      extension: '.png',
      imageMetadata: { width: 2, height: 2, hasAlpha: false, orientation: 1 },
    });
    data.attachments = [{ path: `support/licenses/${id}.txt`, purpose: 'distribution-notice' }];
    project.assets[id] = { id, label: id, data };
  }
  const paths: RuntimeArtifactPathAdapter = {
    resolveProjectSource: (root, source) => `${root}/${source}`,
    shaderAssetRoot: () => undefined,
    readProjectTextSources: async (_root, entries) =>
      entries.map(({ assetId, projectRelativePath }) =>
        Object.hasOwn(contents, projectRelativePath)
          ? {
              status: 'ready' as const,
              assetId,
              projectRelativePath,
              contentHash: digest(contents[projectRelativePath]!),
              text: contents[projectRelativePath]!,
            }
          : { status: 'unavailable' as const, assetId },
      ),
  };
  return { project, paths };
}

describe('Project distribution notice inventory', () => {
  it('selects the packaged physical Asset closure, includes Project-wide notices and preserves distinct paths', async () => {
    const contents = {
      'support/licenses/global.md': '# literal markdown\r\n',
      'support/licenses/included.txt': 'identical',
      'support/licenses/excluded.txt': 'identical',
    };
    const { project, paths } = fixture(contents);
    project.assets.included!.data.attachments!.push({
      path: 'support/licenses/global.md',
      purpose: 'distribution-notice',
    });
    const result = await collectRuntimeDistributionNotices(
      project,
      new Set(['included']),
      '/game',
      paths,
    );
    expect(result.fileEntries.map(({ packagePath }) => packagePath)).toEqual([
      'licenses/support/licenses/global.md',
      'licenses/support/licenses/included.txt',
    ]);
    expect(result.fileEntries.every((entry) => entry.expectedSha256.startsWith('sha256:'))).toBe(
      true,
    );
    expect(JSON.parse(result.textEntry.text).notices).toEqual([
      {
        path: 'licenses/support/licenses/global.md',
        source: 'support/licenses/global.md',
        displayName: 'Project notice',
        contentHash: digest(contents['support/licenses/global.md']),
      },
      {
        path: 'licenses/support/licenses/included.txt',
        source: 'support/licenses/included.txt',
        displayName: 'included.txt',
        contentHash: digest('identical'),
      },
    ]);
    project.settings.distributionNotices.push({ path: 'support/licenses/included.txt' });
    const both = await collectRuntimeDistributionNotices(
      project,
      new Set(['included', 'excluded']),
      '/game',
      paths,
    );
    expect(both.fileEntries.map((entry) => entry.packagePath)).toEqual([
      'licenses/support/licenses/excluded.txt',
      'licenses/support/licenses/global.md',
      'licenses/support/licenses/included.txt',
    ]);
    expect(both.fileEntries[0]!.expectedSha256).toBe(both.fileEntries[2]!.expectedSha256);
  });

  it('rejects conflicting explicit names and never depends on a discarded Asset notice', async () => {
    const { project, paths } = fixture({ 'support/licenses/global.md': 'notice' });
    await expect(
      collectRuntimeDistributionNotices(project, new Set(), '/game', paths),
    ).resolves.toMatchObject({
      fileEntries: [
        expect.objectContaining({ packagePath: 'licenses/support/licenses/global.md' }),
      ],
    });
    project.assets.included!.data.attachments = [
      {
        path: 'support/licenses/global.md',
        purpose: 'distribution-notice',
        displayName: 'Conflicting name',
      },
    ];
    await expect(
      collectRuntimeDistributionNotices(project, new Set(['included']), '/game', paths),
    ).rejects.toThrow(/Conflicting/);
  });

  it('blocks missing, unsafe, oversized, and control-containing applicable files', async () => {
    const contents: Record<string, string> = { 'support/licenses/global.md': 'valid' };
    const { project, paths } = fixture(contents);
    await expect(
      collectRuntimeDistributionNotices(project, new Set(['included']), '/game', paths),
    ).rejects.toThrow(/missing/);
    project.settings.distributionNotices = [{ path: '../escaped.txt' }];
    await expect(
      collectRuntimeDistributionNotices(project, new Set(), '/game', paths),
    ).rejects.toThrow();
    project.settings.distributionNotices = [{ path: 'support/licenses/global.md' }];
    contents['support/licenses/global.md'] = 'x'.repeat(1024 * 1024 + 1);
    await expect(
      collectRuntimeDistributionNotices(project, new Set(), '/game', paths),
    ).rejects.toThrow(/too large/);
    contents['support/licenses/global.md'] = 'hi\u0000there';
    await expect(
      collectRuntimeDistributionNotices(project, new Set(), '/game', paths),
    ).rejects.toThrow(/controls/);
    contents['support/licenses/global.md'] = '';
    await expect(
      collectRuntimeDistributionNotices(project, new Set(), '/game', paths),
    ).rejects.toThrow(/empty/);
  });

  it('rejects an index larger than the canonical runtime notice limit', async () => {
    const { project, paths } = fixture({});
    project.settings.distributionNotices = Array.from({ length: 513 }, (_, index) => ({
      path: `support/licenses/notice-${index}.txt`,
    }));
    await expect(
      collectRuntimeDistributionNotices(project, new Set(), '/game', paths),
    ).rejects.toThrow(/512-entry/);
  });
});
