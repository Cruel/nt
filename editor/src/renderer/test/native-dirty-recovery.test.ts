import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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
  it('quarantines a foreign Project checkpoint once, preserving every original byte', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-dirty-'));
    try {
      const store = new NativeDirtyCheckpointStore();
      expect(await store.read(root, 'same-project')).toBeNull();
      await store.write(root, 'same-project', checkpoint);
      expect(await store.read(root, 'same-project')).toEqual(checkpoint);
      const location = path.join(root, '.noveltea/editor/native-dirty-state.json');
      const originalBytes = await readFile(location);
      const result = await store.readResult(root, 'other-project');
      expect(result.checkpoint).toBeNull();
      expect(result.warning).toContain('another Project identity');
      const archives = (await readdir(path.dirname(location))).filter((name) =>
        name.includes('.quarantine-'),
      );
      expect(archives).toHaveLength(1);
      expect(await readFile(path.join(path.dirname(location), archives[0]))).toEqual(originalBytes);
      expect(await store.readResult(root, 'other-project')).toEqual({
        checkpoint: {
          batches: [],
          textSources: {},
          conflicts: {},
          pendingFields: {},
        },
      });
      expect(
        (await readdir(path.dirname(location))).filter((name) => name.includes('.quarantine-')),
      ).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { name: 'malformed', bytes: '{"version":1,"projectId":' },
    { name: 'unsupported', bytes: JSON.stringify({ version: 2, projectRoot: 'ignored' }) },
    { name: 'truncated', bytes: '{"version":1,"checkpoint":{"batches": [' },
    { name: 'invalid UTF-8', bytes: Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]) },
  ])('quarantines $name recovery and keeps it inactive on repeat Open', async ({ bytes }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-dirty-damaged-'));
    try {
      const store = new NativeDirtyCheckpointStore();
      const location = path.join(root, '.noveltea/editor/native-dirty-state.json');
      await mkdir(path.dirname(location), { recursive: true });
      await writeFile(location, bytes);
      const result = await store.readResult(root, 'same-project');
      expect(result.checkpoint).toBeNull();
      expect(result.warning).toContain('original recovery bytes are preserved at');
      const archives = (await readdir(path.dirname(location))).filter((name) =>
        name.includes('.quarantine-'),
      );
      expect(archives).toHaveLength(1);
      const preserved = await readFile(path.join(path.dirname(location), archives[0]));
      expect(preserved.equals(Buffer.from(bytes))).toBe(true);
      await store.readResult(root, 'same-project');
      expect(
        (await readdir(path.dirname(location))).filter((name) => name.includes('.quarantine-')),
      ).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers independently valid entries without replaying a damaged batch suffix', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-dirty-partial-'));
    try {
      const store = new NativeDirtyCheckpointStore();
      const evidence = {
        diskRevision: revision,
        baseline: { name: 'Saved' },
        working: { name: 'Unsaved' },
      };
      const intact = { ...checkpoint, ownerEvidence: { project: evidence } };
      await store.write(root, 'same-project', intact);
      expect(await store.read(root, 'same-project')).toEqual(intact);
      const location = path.join(root, '.noveltea/editor/native-dirty-state.json');
      const published = JSON.parse(await readFile(location, 'utf8'));
      await writeFile(
        location,
        JSON.stringify({
          ...published,
          checkpoint: {
            ...published.checkpoint,
            textSources: {
              'scripts/helper.lua': checkpoint.textSources['scripts/helper.lua'],
              'scripts/broken.lua': {
                text: 'bad',
                diskRevision: `sha256:${createHash('sha256').update(original).digest('hex')}`,
              },
            },
            batches: [
              checkpoint.batches[0],
              {
                patches: [{ operation: 'replace', path: '/rooms/hall/label', value: 'bad' }],
                diskPreconditions: {},
              },
              checkpoint.batches[0],
            ],
            ownerEvidence: {
              project: evidence,
              'rooms/unrelated': evidence,
              'rooms/bad': { ...evidence, diskRevision: 'sha256:invalid' },
            },
          },
        }),
      );
      const result = await store.readResult(root, 'same-project');
      expect(result.warning).toContain(
        'Verified independent unsaved entries were retained for native replay',
      );
      expect(result.checkpoint).toMatchObject({
        batches: [checkpoint.batches[0]],
        ownerEvidence: { project: evidence },
        textSources: { 'scripts/helper.lua': checkpoint.textSources['scripts/helper.lua'] },
        pendingFields: checkpoint.pendingFields,
      });
      expect(result.checkpoint?.ownerEvidence?.['rooms/unrelated']).toBeUndefined();
      expect(result.checkpoint?.ownerEvidence?.['rooms/bad']).toBeUndefined();
      expect(result.checkpoint?.textSources['scripts/broken.lua']).toBeUndefined();
      expect(await store.readResult(root, 'same-project')).toEqual({
        checkpoint: result.checkpoint,
      });
      const archived = (await readdir(path.dirname(location))).filter((name) =>
        name.includes('.quarantine-'),
      );
      expect(archived).toHaveLength(1);
      expect(await readFile(path.join(path.dirname(location), archived[0]), 'utf8')).toContain(
        'scripts/broken.lua',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('quarantines oversized recovery without loading the oversized payload', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-dirty-large-'));
    try {
      const filename = path.join(root, '.noveltea/editor/native-dirty-state.json');
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, Buffer.alloc(24 * 1024 * 1024 + 1, 65));
      const result = await new NativeDirtyCheckpointStore().readResult(root, 'same-project');
      expect(result.warning).toContain('oversized');
      expect(result.checkpoint).toBeNull();
      expect(
        (await readdir(path.dirname(filename))).filter((name) => name.includes('.quarantine-')),
      ).toHaveLength(1);
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

  it('refuses a symlinked recovery directory without publishing a checkpoint outside the Project', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-dirty-directory-link-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'native-dirty-external-'));
    try {
      await mkdir(path.join(root, '.noveltea'));
      await symlink(outside, path.join(root, '.noveltea/editor'));
      const store = new NativeDirtyCheckpointStore();
      await expect(store.readResult(root, 'same-project')).rejects.toThrow(/unsafe/);
      await expect(store.write(root, 'same-project', checkpoint)).rejects.toThrow(/unsafe/);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
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
