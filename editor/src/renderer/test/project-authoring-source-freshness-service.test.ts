import { describe, expect, it, vi } from 'vite-plus/test';
import { advanceExternallyUpdatedAssetSourceBaselines } from '../../main/services/project-authoring-source-freshness-service';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import { emptyEditorProjectState } from '../../shared/project-schema/editor-project-state';

const oldAsset = `sha256:${'1'.repeat(64)}` as const;
const newAsset = `sha256:${'2'.repeat(64)}` as const;
const oldSource = `sha256:${'a'.repeat(64)}` as const;
const newSource = `sha256:${'b'.repeat(64)}` as const;

function fixture() {
  const project = createAuthoringProject();
  for (const id of ['alpha', 'beta']) {
    project.assets[id] = {
      id,
      label: id,
      data: {
        kind: 'binary',
        source: { type: 'project-file', path: `assets/${id}.bin` },
        aliases: [],
        contentHash: oldAsset,
        imageMetadata: null,
        attachments: [
          {
            path: 'support/sources/shared.psd',
            purpose: 'authoring-source',
            sourceBaselineHash: oldSource,
            assetBaselineHash: oldAsset,
          },
        ],
      },
    };
  }
  let snapshot = {
    projectRoot: '/project',
    project,
    workspaceRevision: 'original',
    fileRevisions: {},
    scriptSourcePaths: {},
  };
  const editorState = emptyEditorProjectState();
  const write = vi.fn(
    async (
      _root: unknown,
      _revision: unknown,
      candidate: typeof project,
      _editor: unknown,
      _sources: unknown,
      options: { targetFiles: string[] },
    ) => {
      expect(options.targetFiles).toEqual(['records/assets/alpha.json']);
      return { snapshot: { ...snapshot, project: candidate } };
    },
  );
  const readFreshRevision = vi.fn(async (relativePath: string) =>
    relativePath === 'assets/alpha.bin' ? newAsset : newSource,
  );
  const session = {
    runExclusive: async (callback: () => Promise<unknown>) => callback(),
    snapshot: () => snapshot,
    service: () => ({ write }),
    editorState: () => editorState,
    readFreshRevision,
    adopt: (updated: typeof snapshot) => {
      snapshot = updated;
    },
  };
  return { session, write, readFreshRevision, project: () => snapshot.project };
}

describe('Authoring Source freshness persistence', () => {
  it('atomically advances only the changed Asset, preserving a shared-source sibling', async () => {
    const { session, write, project } = fixture();
    const changed = await advanceExternallyUpdatedAssetSourceBaselines(session as never, {
      'assets/alpha.bin': newAsset,
    });
    expect(changed).toEqual(['records/assets/alpha.json']);
    expect(write).toHaveBeenCalledTimes(1);
    expect(parseAssetData(project().assets.alpha.data)?.attachments).toEqual([
      expect.objectContaining({ sourceBaselineHash: newSource, assetBaselineHash: newAsset }),
    ]);
    expect(parseAssetData(project().assets.beta.data)?.attachments).toEqual([
      expect.objectContaining({ sourceBaselineHash: oldSource, assetBaselineHash: oldAsset }),
    ]);
  });

  it('does not persist a timestamp-only observation or acknowledge bytes that changed during sampling', async () => {
    const same = fixture();
    expect(
      await advanceExternallyUpdatedAssetSourceBaselines(same.session as never, {
        'assets/alpha.bin': oldAsset,
      }),
    ).toEqual([]);
    expect(same.write).not.toHaveBeenCalled();

    const raced = fixture();
    raced.readFreshRevision.mockResolvedValueOnce(oldAsset);
    expect(
      await advanceExternallyUpdatedAssetSourceBaselines(raced.session as never, {
        'assets/alpha.bin': newAsset,
      }),
    ).toEqual([]);
    expect(raced.write).not.toHaveBeenCalled();
  });

  it('does not persist a stale session or advance baselines when the write fails', async () => {
    const stale = fixture();
    expect(
      await advanceExternallyUpdatedAssetSourceBaselines(
        stale.session as never,
        { 'assets/alpha.bin': newAsset },
        () => false,
      ),
    ).toEqual([]);
    expect(stale.write).not.toHaveBeenCalled();

    const failed = fixture();
    failed.write.mockRejectedValueOnce(new Error('Workspace revision conflict'));
    await expect(
      advanceExternallyUpdatedAssetSourceBaselines(failed.session as never, {
        'assets/alpha.bin': newAsset,
      }),
    ).rejects.toThrow('Workspace revision conflict');
    expect(parseAssetData(failed.project().assets.alpha.data)?.attachments).toEqual([
      expect.objectContaining({ sourceBaselineHash: oldSource, assetBaselineHash: oldAsset }),
    ]);
  });
});
