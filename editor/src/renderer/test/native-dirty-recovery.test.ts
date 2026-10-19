import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { NativeDirtyCheckpointStore } from '../../main/services/native-dirty-checkpoint-store';
import { withNativeRecoveredTextSources } from '../../main/services/native-recovery-editor-state';
import { emptyEditorProjectState } from '../../shared/project-schema/editor-project-state';

const original = 'return "saved"\n';
const revision = `sha256:${createHash('sha256').update(original).digest('hex')}` as const;
const checkpoint = {
  batches: [
    {
      patches: [{ operation: 'replace' as const, path: '/project/name', value: 'Unsaved' }],
      diskPreconditions: { project: revision },
    },
  ],
  textSources: { 'scripts/helper.lua': { text: 'return "edited"\n', diskRevision: revision } },
  conflicts: { project: ['/project/name'] },
  pendingFields: { '/rooms/hall/label': 'incomplete input' },
};

describe('durable native editor recovery', () => {
  it('writes a versioned atomic local checkpoint and rejects old identity or partial data', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-dirty-'));
    try {
      const store = new NativeDirtyCheckpointStore();
      expect(await store.read(root, 'same-project')).toBeNull();
      await store.write(root, 'same-project', checkpoint);
      expect(await store.read(root, 'same-project')).toEqual(checkpoint);
      await expect(store.read(root, 'other-project')).rejects.toThrow('another Project identity');
      const location = path.join(root, '.noveltea/editor/native-dirty-state.json');
      const published = JSON.parse(await readFile(location, 'utf8'));
      expect(published).toMatchObject({ version: 1, projectId: 'same-project' });
      await writeFile(location, '{"version":1,"projectId":');
      await expect(store.read(root, 'same-project')).rejects.toThrow('incomplete or incompatible');
      await writeFile(location, JSON.stringify({ ...published, version: 2 }));
      await expect(store.read(root, 'same-project')).rejects.toThrow('incomplete or incompatible');
      await writeFile(
        location,
        JSON.stringify({
          ...published,
          checkpoint: {
            ...checkpoint,
            batches: [
              {
                patches: [{ operation: 'replace', path: '/project/name', value: 'Unsaved' }],
                diskPreconditions: {},
              },
            ],
          },
        }),
      );
      await expect(store.read(root, 'same-project')).rejects.toThrow('incomplete or incompatible');
      await store.write(root, 'same-project', {
        batches: [],
        textSources: {},
        conflicts: {},
        pendingFields: {},
      });
      expect((await store.read(root, 'same-project'))?.batches).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects symlink substitution of the recovery journal', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-dirty-link-'));
    try {
      await mkdir(path.join(root, '.noveltea/editor'), { recursive: true });
      const location = path.join(root, '.noveltea/editor/native-dirty-state.json');
      await symlink(path.join(root, 'elsewhere'), location);
      const store = new NativeDirtyCheckpointStore();
      await expect(store.read(root, 'same-project')).rejects.toThrow('symbolic link');
      await expect(store.write(root, 'same-project', checkpoint)).rejects.toThrow('symbolic link');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rehydrates acknowledged staged text by physical source identity, not Layout display path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-dirty-text-'));
    try {
      await mkdir(path.join(root, 'records/layouts/hall'), { recursive: true });
      await writeFile(path.join(root, 'records/layouts/hall/layout.rml'), original);
      const source = 'records/layouts/hall/layout.rml';
      const files = [
        {
          id: 'layouts/hall/layout.rml',
          displayPath: 'layouts/hall/layout.rml',
          projectRelativePath: source,
          kind: 'layout-rml' as const,
          text: true,
        },
      ];
      const state = await withNativeRecoveredTextSources(root, emptyEditorProjectState(), files, {
        [source]: { text: '<rml>dirty</rml>', diskRevision: revision },
      });
      expect(state.sourceRecoveryById['layouts/hall/layout.rml']).toMatchObject({
        text: '<rml>dirty</rml>',
        baseText: original,
        baseContentHash: revision,
        file: { projectRelativePath: source },
      });
      await writeFile(path.join(root, source), 'external edit');
      await expect(
        withNativeRecoveredTextSources(root, emptyEditorProjectState(), files, {
          [source]: { text: 'dirty', diskRevision: revision },
        }),
      ).rejects.toThrow('changed on disk');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
