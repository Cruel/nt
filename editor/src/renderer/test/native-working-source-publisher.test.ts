import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  NativeWorkingSourcePublisher,
  copyNativeWorkingSourceTree,
} from '../../main/services/native-working-source-publisher';
import { workingSourceManifestSchema } from '../../shared/project-workspace/working-source-contract';
import type { NativeDirtyCheckpoint } from '../../main/services/native-authoring-working-project';
import type { nativeAuthoringSnapshotSchema } from '../../main/services/native-authoring-worker-contract';
import type { z } from 'zod';

type Snapshot = z.infer<typeof nativeAuthoringSnapshotSchema>;
const hash = (bytes: Uint8Array) =>
  `xxh3-128:${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`;
const emptyCheckpoint = (): NativeDirtyCheckpoint => ({
  batches: [],
  textSources: {},
  conflicts: {},
  pendingFields: {},
});
const state = (label: string, baseline = 'Saved', diskSourceRevision = 'absent') => ({
  source: { id: 'hall', label },
  baseline: { id: 'hall', label: baseline },
  normalized: { id: 'hall', label },
  workingRevision: 1,
  diskSourceRevision,
  dirty: label !== baseline,
  dirtyPatches:
    label !== baseline ? [{ operation: 'replace' as const, path: '/label', value: label }] : [],
  valid: true,
  diagnostics: [],
});
const snapshot = (room = state('Working')) =>
  ({
    ...state('Manifest', 'Manifest'),
    recordSnapshots: { 'rooms/hall': room },
  }) as unknown as Snapshot;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'noveltea-working-publisher-'));
  const room = path.join(root, 'records/rooms/hall.yaml');
  await mkdir(path.dirname(room), { recursive: true });
  const source = 'id: hall # authored identity\nlabel: Saved # note\n';
  await writeFile(room, source);
  return { root, room, source, revision: hash(Buffer.from(source)) };
}

const workingPath = (root: string, relative: string) =>
  path.join(root, '.noveltea/editor/working', relative);

describe('native working-source publisher (#625)', () => {
  it('projects only acknowledged dirty Room source and retains authored comments', async () => {
    const { root, room, source, revision } = await fixture();
    try {
      const publisher = new NativeWorkingSourcePublisher(200, hash);
      const projected = snapshot(state('Working', 'Saved', revision));
      publisher.schedule(root, 'project-1', projected, emptyCheckpoint());
      await publisher.flush();
      const file = await readFile(workingPath(root, 'files/records/rooms/hall.yaml'), 'utf8');
      expect(file).toContain('label: Working # note');
      expect(file).toContain('id: hall # authored identity');
      expect(await readFile(room, 'utf8')).toBe(source);
      const manifest = workingSourceManifestSchema.parse(
        JSON.parse(await readFile(workingPath(root, 'manifest.json'), 'utf8')),
      );
      expect(Object.keys(manifest.entries)).toEqual(['records/rooms/hall.yaml']);
      expect(manifest.entries['records/rooms/hall.yaml']!.diskRevision).toBe(revision);

      // Repeating the same projection does not rewrite the owned source bytes.
      publisher.schedule(root, 'project-1', projected, emptyCheckpoint());
      await publisher.flush();
      expect(await readFile(workingPath(root, 'files/records/rooms/hall.yaml'), 'utf8')).toBe(file);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not clobber an agent edit even if native acknowledgments continue', async () => {
    const { root, revision } = await fixture();
    try {
      const publisher = new NativeWorkingSourcePublisher(200, hash);
      publisher.schedule(
        root,
        'project-1',
        snapshot(state('Working', 'Saved', revision)),
        emptyCheckpoint(),
      );
      await publisher.flush();
      const file = workingPath(root, 'files/records/rooms/hall.yaml');
      await writeFile(file, 'id: hall\nlabel: Agent repaired\n');
      publisher.schedule(
        root,
        'project-1',
        snapshot(state('Native next', 'Saved', revision)),
        emptyCheckpoint(),
      );
      await expect(publisher.flush()).rejects.toThrow(/Externally modified working source/);
      expect(await readFile(file, 'utf8')).toContain('Agent repaired');
      expect(publisher.error).toContain('Externally modified working source');
      // A clean native state also cannot prune an unadopted agent repair.
      publisher.schedule(
        root,
        'project-1',
        snapshot(state('Saved', 'Saved', revision)),
        emptyCheckpoint(),
      );
      await expect(publisher.flush()).rejects.toThrow(/cannot be pruned/);
      expect(await readFile(file, 'utf8')).toContain('Agent repaired');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes exact pending source, deletions and multiple independent text owners', async () => {
    const { root, revision } = await fixture();
    try {
      const publisher = new NativeWorkingSourcePublisher(200, hash);
      const checkpoint: NativeDirtyCheckpoint = {
        batches: [
          {
            patches: [{ operation: 'remove', path: '/rooms/old' }],
            diskPreconditions: { 'rooms/old': revision },
          },
        ],
        textSources: {
          'scripts/helper.lua': { text: 'return "unsaved"\n', diskRevision: 'absent' },
          'shaders/a.sc': { text: 'not valid yet', diskRevision: 'absent' },
        },
        conflicts: {},
        pendingFields: { '/rooms/hall/data/width': '-' },
      };
      publisher.schedule(
        root,
        'project-1',
        snapshot(state('Working', 'Saved', revision)),
        checkpoint,
      );
      await publisher.flush();
      expect(await readFile(workingPath(root, 'files/scripts/helper.lua'), 'utf8')).toBe(
        'return "unsaved"\n',
      );
      expect(await readFile(workingPath(root, 'files/shaders/a.sc'), 'utf8')).toBe('not valid yet');
      expect(
        await readFile(workingPath(root, 'deletions/records/rooms/old.yaml.delete.json'), 'utf8'),
      ).toBe('{"deleted":true}\n');
      expect(
        JSON.parse(
          await readFile(workingPath(root, 'pending/records/rooms/hall.yaml.json'), 'utf8'),
        ),
      ).toEqual({ fieldText: { '/rooms/hall/data/width': '-' }, namedText: {} });
      const manifest = workingSourceManifestSchema.parse(
        JSON.parse(await readFile(workingPath(root, 'manifest.json'), 'utf8')),
      );
      expect(Object.keys(manifest.entries)).toHaveLength(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('collapses rapid native edits and prunes only unchanged projected bytes on Undo', async () => {
    const { root, revision } = await fixture();
    try {
      const publisher = new NativeWorkingSourcePublisher(200, hash);
      publisher.schedule(
        root,
        'project-1',
        snapshot(state('First', 'Saved', revision)),
        emptyCheckpoint(),
      );
      publisher.schedule(
        root,
        'project-1',
        snapshot(state('Second', 'Saved', revision)),
        emptyCheckpoint(),
      );
      publisher.schedule(
        root,
        'project-1',
        snapshot(state('Third', 'Saved', revision)),
        emptyCheckpoint(),
      );
      await publisher.flush();
      expect(await readFile(workingPath(root, 'files/records/rooms/hall.yaml'), 'utf8')).toContain(
        'Third',
      );
      publisher.schedule(
        root,
        'project-1',
        snapshot(state('Saved', 'Saved', revision)),
        emptyCheckpoint(),
      );
      await publisher.flush();
      await expect(
        readFile(workingPath(root, 'files/records/rooms/hall.yaml')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      const manifest = workingSourceManifestSchema.parse(
        JSON.parse(await readFile(workingPath(root, 'manifest.json'), 'utf8')),
      );
      expect(manifest.entries).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects symlinked working targets and unverified saved revisions', async () => {
    const { root, revision } = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'noveltea-working-outside-'));
    try {
      const publisher = new NativeWorkingSourcePublisher(200, hash);
      await mkdir(path.join(root, '.noveltea/editor'), { recursive: true });
      await symlink(outside, path.join(root, '.noveltea/editor/working'));
      publisher.schedule(
        root,
        'project-1',
        snapshot(state('Working', 'Saved', revision)),
        emptyCheckpoint(),
      );
      await expect(publisher.flush()).rejects.toThrow(/Unsafe working-source directory/);
      expect(await readFile(path.join(root, 'records/rooms/hall.yaml'), 'utf8')).toContain('Saved');
      await rm(path.join(root, '.noveltea/editor/working'));
      publisher.schedule(
        root,
        'project-1',
        snapshot(state('Working', 'Saved', 'xxh3-128:' + 'f'.repeat(32))),
        emptyCheckpoint(),
      );
      await expect(publisher.flush()).rejects.toThrow(/Authored source changed before projection/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('copies an agent-modified working file and rebinds the manifest without changing tracked YAML', async () => {
    const { root, revision, room, source } = await fixture();
    const destination = await mkdtemp(path.join(tmpdir(), 'noveltea-working-copy-'));
    try {
      const publisher = new NativeWorkingSourcePublisher(200, hash);
      publisher.schedule(
        root,
        'project-1',
        snapshot(state('Working', 'Saved', revision)),
        emptyCheckpoint(),
      );
      await publisher.flush();
      const file = 'files/records/rooms/hall.yaml';
      const agentBytes = 'id: hall\nlabel: Agent fixed\n';
      await writeFile(workingPath(root, file), agentBytes);
      await copyNativeWorkingSourceTree(root, destination, '/final/project-copy', 'project-1');
      expect(await readFile(workingPath(destination, file), 'utf8')).toBe(agentBytes);
      expect(await readFile(room, 'utf8')).toBe(source);
      const manifest = workingSourceManifestSchema.parse(
        JSON.parse(await readFile(workingPath(destination, 'manifest.json'), 'utf8')),
      );
      expect(manifest.projectRoot).toBe('/final/project-copy');
      expect(manifest.entries['records/rooms/hall.yaml']!.publishedRevision).not.toBe(
        `sha256:${createHash('sha256').update(agentBytes).digest('hex')}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    }
  });

  it('keeps a pending-only draft separately from a clean physical owner', async () => {
    const { root, revision, source, room } = await fixture();
    try {
      const publisher = new NativeWorkingSourcePublisher(200, hash);
      const checkpoint = emptyCheckpoint();
      checkpoint.pendingFields['/rooms/hall/data/width'] = '-';
      publisher.schedule(
        root,
        'project-1',
        snapshot(state('Saved', 'Saved', revision)),
        checkpoint,
      );
      await publisher.flush();
      const manifest = workingSourceManifestSchema.parse(
        JSON.parse(await readFile(workingPath(root, 'manifest.json'), 'utf8')),
      );
      expect(manifest.entries['records/rooms/hall.yaml']).toMatchObject({
        representation: 'pending-only',
        diskRevision: revision,
        publishedRevision: null,
      });
      await expect(
        readFile(workingPath(root, 'files/records/rooms/hall.yaml')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(room, 'utf8')).toBe(source);
      expect(
        JSON.parse(
          await readFile(workingPath(root, 'pending/records/rooms/hall.yaml.json'), 'utf8'),
        ),
      ).toEqual({ fieldText: { '/rooms/hall/data/width': '-' }, namedText: {} });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves ambiguous crash artifacts and refuses damaged publisher baseline evidence', async () => {
    const { root, revision } = await fixture();
    try {
      const file = workingPath(root, 'files/records/rooms/hall.yaml');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'id: hall\nlabel: unsafely interrupted publication\n');
      const publisher = new NativeWorkingSourcePublisher(200, hash);
      publisher.schedule(
        root,
        'project-1',
        snapshot(state('Working', 'Saved', revision)),
        emptyCheckpoint(),
      );
      await expect(publisher.flush()).rejects.toThrow(/Externally modified working source/);
      expect(await readFile(file, 'utf8')).toContain('interrupted publication');
      await rm(file);
      publisher.schedule(
        root,
        'project-1',
        snapshot(state('Working', 'Saved', revision)),
        emptyCheckpoint(),
      );
      await publisher.flush();
      const manifest = workingSourceManifestSchema.parse(
        JSON.parse(await readFile(workingPath(root, 'manifest.json'), 'utf8')),
      );
      const published = manifest.entries['records/rooms/hall.yaml']!.publishedRevision!;
      const baseline = workingPath(root, `baselines/${published.slice('sha256:'.length)}.blob`);
      await writeFile(baseline, 'corrupted baseline');
      publisher.schedule(
        root,
        'project-1',
        snapshot(state('Native next', 'Saved', revision)),
        emptyCheckpoint(),
      );
      await expect(publisher.flush()).rejects.toThrow(/baseline is damaged/);
      expect(await readFile(file, 'utf8')).toContain('Working');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
