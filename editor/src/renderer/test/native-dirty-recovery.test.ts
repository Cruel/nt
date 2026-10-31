import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { NativeDirtyCheckpointStore } from '../../main/services/native-dirty-checkpoint-store';
import { withNativeRecoveredTextSources } from '../../main/services/native-recovery-editor-state';
import { emptyEditorProjectState } from '../../shared/project-schema/editor-project-state';

const original = 'return "saved"\n';
const revision = `xxh3-128:${'a'.repeat(32)}` as const;
const revisionFor = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString('utf8') === original ? revision : `xxh3-128:${'0'.repeat(32)}`;
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
  it('restores XXH3-128 dirty text across a checkpoint reopen and fails closed on changed bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-dirty-xxh3-'));
    const name = 'scripts/helper.lua';
    const hash = 'xxh3-128:06b05ab6733a618578af5f94892f3950' as const;
    const sourceRevisionFor = (bytes: Uint8Array) =>
      Buffer.from(bytes).toString('utf8') === 'abc'
        ? hash
        : (`xxh3-128:${'0'.repeat(32)}` as const);
    try {
      await mkdir(path.join(root, 'scripts'));
      await writeFile(path.join(root, name), 'abc');
      const files = [
        {
          id: name,
          displayPath: name,
          projectRelativePath: name,
          kind: 'lua' as const,
          text: true,
        },
      ];
      const store = new NativeDirtyCheckpointStore();
      await store.write(root, 'project-xxh3', {
        ...checkpoint,
        batches: [{ ...checkpoint.batches[0], diskPreconditions: { project: hash } }],
        textSources: { [name]: { text: 'unsaved', diskRevision: hash } },
      });
      const loaded = await new NativeDirtyCheckpointStore().read(root, 'project-xxh3');
      expect(loaded?.batches[0].diskPreconditions).toEqual({ project: hash });
      const recovered = await withNativeRecoveredTextSources(
        root,
        emptyEditorProjectState(),
        files,
        loaded!.textSources,
        sourceRevisionFor,
      );
      expect(recovered.sourceRecoveryById[name]).toMatchObject({
        baseText: 'abc',
        baseContentHash: hash,
        text: 'unsaved',
      });
      await expect(
        withNativeRecoveredTextSources(root, emptyEditorProjectState(), files, loaded!.textSources),
      ).rejects.toThrow('changed on disk');
      await writeFile(path.join(root, name), 'external edit');
      await expect(
        withNativeRecoveredTextSources(
          root,
          emptyEditorProjectState(),
          files,
          loaded!.textSources,
          sourceRevisionFor,
        ),
      ).rejects.toThrow('changed on disk');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
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
      await writeFile(
        location,
        JSON.stringify({
          ...published,
          checkpoint: {
            ...published.checkpoint,
            textSources: {
              'scripts/helper.lua': {
                text: 'unsaved',
                diskRevision: `sha256:${createHash('sha256').update(original).digest('hex')}`,
              },
            },
          },
        }),
      );
      await expect(store.read(root, 'same-project')).rejects.toThrow('incomplete or incompatible');
      await writeFile(location, JSON.stringify(published));
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
      const state = await withNativeRecoveredTextSources(
        root,
        emptyEditorProjectState(),
        files,
        {
          [source]: { text: '<rml>dirty</rml>', diskRevision: revision },
        },
        revisionFor,
      );
      expect(state.sourceRecoveryById['layouts/hall/layout.rml']).toMatchObject({
        text: '<rml>dirty</rml>',
        baseText: original,
        baseContentHash: revision,
        file: { projectRelativePath: source },
      });
      await writeFile(path.join(root, source), 'external edit');
      await expect(
        withNativeRecoveredTextSources(
          root,
          emptyEditorProjectState(),
          files,
          {
            [source]: { text: 'dirty', diskRevision: revision },
          },
          revisionFor,
        ),
      ).rejects.toThrow('changed on disk');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
