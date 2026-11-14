import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  NativeWorkingSourcePublisher,
  copyNativeWorkingSourceTree,
} from '../../main/services/native-working-source-publisher';
import { planOfflineWorkingSourceImport } from '../../main/services/native-working-source-import';
import { workingSourceManifestSchema } from '../../shared/project-workspace/working-source-contract';
import type { NativeDirtyCheckpoint } from '../../main/services/native-authoring-working-project';
import type { nativeAuthoringSnapshotSchema } from '../../main/services/native-authoring-worker-contract';
import type { z } from 'zod';

type Snapshot = z.infer<typeof nativeAuthoringSnapshotSchema>;
const hash = (bytes: Uint8Array) =>
  `xxh3-128:${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`;
// The native addon uses an atomic OS exchange. The unit suite models the same
// retained-old-file result; a separate native-addon test covers the syscall.
const exchange = async (staged: string, destination: string, backup: string) => {
  await rename(destination, backup);
  await rename(staged, destination);
  await rename(backup, staged);
  return staged;
};
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
  it('plans only genuine agent changes against verified published bytes and checkpoint evidence', async () => {
    const { root, revision } = await fixture();
    try {
      const checkpoint = emptyCheckpoint();
      checkpoint.ownerEvidence = {
        'rooms/hall': {
          diskRevision: revision,
          baseline: { id: 'hall', label: 'Saved' },
          working: { id: 'hall', label: 'Working' },
        },
      };
      const published = snapshot(state('Working', 'Saved', revision));
      const publisher = new NativeWorkingSourcePublisher(200, hash, exchange);
      publisher.schedule(root, 'project-1', published, checkpoint);
      await publisher.flush();
      const unchanged = await planOfflineWorkingSourceImport(
        root,
        'project-1',
        published,
        checkpoint,
        hash,
      );
      expect(unchanged.changes).toEqual([]);
      expect(unchanged.warnings).toEqual([]);

      const file = workingPath(root, 'files/records/rooms/hall.yaml');
      await writeFile(
        file,
        (await readFile(file, 'utf8')).replace('label: Working', 'label: Agent'),
      );
      const imported = await planOfflineWorkingSourceImport(
        root,
        'project-1',
        published,
        checkpoint,
        hash,
      );
      expect(imported.obstructed).toBe(false);
      expect(imported.changes).toMatchObject([
        {
          owner: 'rooms/hall',
          patches: [{ op: 'replace', path: '/rooms/hall/label', value: 'Agent' }],
          conflicts: [],
        },
      ]);
      const mismatched = await planOfflineWorkingSourceImport(
        root,
        'another-project',
        published,
        checkpoint,
        hash,
      );
      expect(mismatched.obstructed).toBe(true);
      expect(mismatched.changes).toEqual([]);
      const noCheckpoint = await planOfflineWorkingSourceImport(
        root,
        'project-1',
        published,
        null,
        hash,
      );
      expect(noCheckpoint.obstructed).toBe(true);
      expect(noCheckpoint.changes).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves damaged, renamed and symlinked agent files instead of importing unknown evidence', async () => {
    const { root, revision } = await fixture();
    try {
      const checkpoint = emptyCheckpoint();
      checkpoint.ownerEvidence = {
        'rooms/hall': {
          diskRevision: revision,
          baseline: { id: 'hall', label: 'Saved' },
          working: { id: 'hall', label: 'Working' },
        },
      };
      const published = snapshot(state('Working', 'Saved', revision));
      const publisher = new NativeWorkingSourcePublisher(200, hash, exchange);
      publisher.schedule(root, 'project-1', published, checkpoint);
      await publisher.flush();
      const file = workingPath(root, 'files/records/rooms/hall.yaml');
      const bytes = await readFile(file, 'utf8');
      await writeFile(file, 'id: hall\nlabel: [\n');
      const invalid = await planOfflineWorkingSourceImport(
        root,
        'project-1',
        published,
        checkpoint,
        hash,
      );
      expect(invalid.obstructed).toBe(true);
      expect(invalid.changes).toEqual([]);
      expect(await readFile(file, 'utf8')).toBe('id: hall\nlabel: [\n');
      await rm(file);
      const missing = await planOfflineWorkingSourceImport(
        root,
        'project-1',
        published,
        checkpoint,
        hash,
      );
      expect(missing.obstructed).toBe(true);
      await symlink(workingPath(root, 'manifest.json'), file);
      const linked = await planOfflineWorkingSourceImport(
        root,
        'project-1',
        published,
        checkpoint,
        hash,
      );
      expect(linked.obstructed).toBe(true);
      await rm(file);
      await writeFile(file, bytes);
      const manifest = workingSourceManifestSchema.parse(
        JSON.parse(await readFile(workingPath(root, 'manifest.json'), 'utf8')),
      );
      const hashValue = manifest.entries['records/rooms/hall.yaml']!.publishedRevision!;
      await writeFile(workingPath(root, `baselines/${hashValue.slice(7)}.blob`), 'corrupted');
      const corrupted = await planOfflineWorkingSourceImport(
        root,
        'project-1',
        published,
        checkpoint,
        hash,
      );
      expect(corrupted.obstructed).toBe(true);
      expect(corrupted.changes).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('projects only acknowledged dirty Room source and retains authored comments', async () => {
    const { root, room, source, revision } = await fixture();
    try {
      const publisher = new NativeWorkingSourcePublisher(200, hash, exchange);
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

  it('preserves invalid structured values and verbatim malformed staged YAML', async () => {
    const { root, room, source, revision } = await fixture();
    try {
      const publisher = new NativeWorkingSourcePublisher(200, hash, exchange);
      const invalid = { ...state('', 'Saved', revision), valid: false };
      publisher.schedule(root, 'project-1', snapshot(invalid), emptyCheckpoint());
      await publisher.flush();
      expect(await readFile(workingPath(root, 'files/records/rooms/hall.yaml'), 'utf8')).toContain(
        'label: "" # note',
      );
      const malformed = 'id: hall\nlabel: [\n# unsaved broken source\n';
      publisher.schedule(root, 'project-1', snapshot(invalid), {
        ...emptyCheckpoint(),
        textSources: {
          'records/rooms/hall.yaml': { text: malformed, diskRevision: revision },
        },
      });
      await publisher.flush();
      expect(await readFile(workingPath(root, 'files/records/rooms/hall.yaml'), 'utf8')).toBe(
        malformed,
      );
      expect(await readFile(room, 'utf8')).toBe(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('updates one owner without rewriting unchanged owners or manifest on an identical flush', async () => {
    const { root, revision } = await fixture();
    try {
      const other = path.join(root, 'records/rooms/second.yaml');
      const original = 'id: hall\nlabel: Saved\n';
      await writeFile(other, original);
      const secondRevision = hash(Buffer.from(original));
      const makeSnapshot = (first: string) =>
        ({
          ...snapshot(state(first, 'Saved', revision)),
          recordSnapshots: {
            'rooms/hall': state(first, 'Saved', revision),
            'rooms/second': state('Second working', 'Saved', secondRevision),
          },
        }) as Snapshot;
      const publisher = new NativeWorkingSourcePublisher(200, hash, exchange);
      publisher.schedule(root, 'project-1', makeSnapshot('First'), emptyCheckpoint());
      await publisher.flush();
      const second = workingPath(root, 'files/records/rooms/second.yaml');
      const secondBefore = await stat(second);
      const manifestPath = workingPath(root, 'manifest.json');
      publisher.schedule(root, 'project-1', makeSnapshot('Next'), emptyCheckpoint());
      await publisher.flush();
      const afterUpdate = await readFile(manifestPath);
      expect((await stat(second)).ino).toBe(secondBefore.ino);
      expect((await stat(second)).mtimeMs).toBe(secondBefore.mtimeMs);
      const after = workingSourceManifestSchema.parse(JSON.parse(afterUpdate.toString()));
      expect(after.publication).toBe(2);
      publisher.schedule(root, 'project-1', makeSnapshot('Next'), emptyCheckpoint());
      await publisher.flush();
      expect(await readFile(manifestPath)).toEqual(afterUpdate);
      expect(await readFile(second, 'utf8')).toContain('Second working');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not clobber an agent edit even if native acknowledgments continue', async () => {
    const { root, revision } = await fixture();
    try {
      const publisher = new NativeWorkingSourcePublisher(200, hash, exchange);
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
      // Once native admission acknowledged precisely these external bytes,
      // a later successful Save may prune that owner without dropping edits.
      publisher.adoptExternal(
        'records/rooms/hall.yaml',
        `sha256:${createHash('sha256')
          .update(await readFile(file))
          .digest('hex')}`,
      );
      publisher.schedule(
        root,
        'project-1',
        snapshot(state('Saved', 'Saved', revision)),
        emptyCheckpoint(),
      );
      await publisher.flush();
      await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('restores the exact agent file that wins the native exchange boundary', async () => {
    const { root, revision } = await fixture();
    try {
      const file = workingPath(root, 'files/records/rooms/hall.yaml');
      let raced = false;
      const publisher = new NativeWorkingSourcePublisher(
        200,
        hash,
        async (staged, target, backup) => {
          if (target === file && !raced) {
            raced = true;
            await writeFile(target, 'id: hall\nlabel: Agent during swap\n');
          }
          return exchange(staged, target, backup);
        },
      );
      publisher.schedule(
        root,
        'project-1',
        snapshot(state('First', 'Saved', revision)),
        emptyCheckpoint(),
      );
      await publisher.flush();
      const manifestBefore = await readFile(workingPath(root, 'manifest.json'));
      publisher.schedule(
        root,
        'project-1',
        snapshot(state('Second', 'Saved', revision)),
        emptyCheckpoint(),
      );
      await expect(publisher.flush()).rejects.toThrow(
        /Externally modified working source during atomic publication/,
      );
      expect(raced).toBe(true);
      expect(await readFile(file, 'utf8')).toContain('Agent during swap');
      expect(await readFile(workingPath(root, 'manifest.json'))).toEqual(manifestBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!process.env.NOVELTEA_AUTHORING_NODE_ADDON)(
    'uses the real native atomic exchange without losing a competing atomic-save rename',
    async () => {
      const { root, revision } = await fixture();
      try {
        const addonPath = process.env.NOVELTEA_AUTHORING_NODE_ADDON!;
        const native = createRequire(addonPath)(addonPath) as {
          exchangeWorkingSource(staged: string, target: string, backup: string): string;
        };
        const publisher = new NativeWorkingSourcePublisher(200, hash, (staged, target, backup) =>
          native.exchangeWorkingSource(staged, target, backup),
        );
        publisher.schedule(
          root,
          'project-1',
          snapshot(state('First', 'Saved', revision)),
          emptyCheckpoint(),
        );
        await publisher.flush();
        publisher.schedule(
          root,
          'project-1',
          snapshot(state('Second', 'Saved', revision)),
          emptyCheckpoint(),
        );
        await publisher.flush();
        expect(
          await readFile(workingPath(root, 'files/records/rooms/hall.yaml'), 'utf8'),
        ).toContain('Second');
        const file = workingPath(root, 'files/records/rooms/hall.yaml');
        let collided = false;
        const raced = new NativeWorkingSourcePublisher(200, hash, (staged, target, backup) => {
          if (target === file && !collided) {
            collided = true;
            const source = 'id: hall\nlabel: Agent atomic replacement\n';
            // Produce an actual alternate inode, like an agent editor Save.
            const newPath = path.join(path.dirname(file), '.other-agent-new-source');
            return writeFile(newPath, source)
              .then(() => rename(newPath, file))
              .then(() => native.exchangeWorkingSource(staged, target, backup));
          }
          return native.exchangeWorkingSource(staged, target, backup);
        });
        const manifest = await readFile(workingPath(root, 'manifest.json'));
        raced.schedule(
          root,
          'project-1',
          snapshot(state('Third', 'Saved', revision)),
          emptyCheckpoint(),
        );
        await expect(raced.flush()).rejects.toThrow(
          /Externally modified working source during atomic publication/,
        );
        expect(await readFile(file, 'utf8')).toContain('Agent atomic replacement');
        expect(await readFile(workingPath(root, 'manifest.json'))).toEqual(manifest);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('publishes exact pending source, deletions and multiple independent text owners', async () => {
    const { root, revision, room, source } = await fixture();
    try {
      const publisher = new NativeWorkingSourcePublisher(200, hash, exchange);
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
      const pending = workingPath(root, 'pending/records/rooms/hall.yaml.json');
      const proposed = { fieldText: { '/rooms/hall/data/width': '-1' }, namedText: {} };
      await writeFile(pending, JSON.stringify(proposed));
      const admitted = await planOfflineWorkingSourceImport(
        root,
        'project-1',
        snapshot(state('Saved', 'Saved', revision)),
        checkpoint,
        hash,
      );
      expect(admitted.obstructed).toBe(false);
      expect(admitted.changes[0]?.pending).toEqual({ '/rooms/hall/data/width': '-1' });
      await writeFile(room, source.replace('label: Saved', 'label: Disk changed'));
      const stale = await planOfflineWorkingSourceImport(
        root,
        'project-1',
        snapshot(state('Saved', 'Saved', revision)),
        checkpoint,
        hash,
      );
      expect(stale.obstructed).toBe(true);
      expect(stale.changes).toEqual([]);
      expect(JSON.parse(await readFile(pending, 'utf8'))).toEqual(proposed);
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
      const publisher = new NativeWorkingSourcePublisher(200, hash, exchange);
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
      const publisher = new NativeWorkingSourcePublisher(200, hash, exchange);
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
      const publisher = new NativeWorkingSourcePublisher(200, hash, exchange);
      const checkpoint = emptyCheckpoint();
      checkpoint.ownerEvidence = {
        'rooms/hall': {
          diskRevision: revision,
          baseline: { id: 'hall', label: 'Saved' },
          working: { id: 'hall', label: 'Working' },
        },
      };
      publisher.schedule(
        root,
        'project-1',
        snapshot(state('Working', 'Saved', revision)),
        checkpoint,
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
      // A normal Copy As rebinds the identity to the actual selected destination.
      // Use the same tree with that identity to certify cold-import eligibility.
      await writeFile(
        workingPath(destination, 'manifest.json'),
        JSON.stringify({ ...manifest, projectRoot: destination }),
      );
      const copied = await planOfflineWorkingSourceImport(
        destination,
        'project-1',
        snapshot(state('Working', 'Saved', revision)),
        checkpoint,
        hash,
      );
      expect(copied.obstructed).toBe(false);
      expect(copied.changes[0]?.patches).toEqual([
        { op: 'replace', path: '/rooms/hall/label', value: 'Agent fixed' },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    }
  });

  it('keeps a pending-only draft separately from a clean physical owner', async () => {
    const { root, revision, source, room } = await fixture();
    try {
      const publisher = new NativeWorkingSourcePublisher(200, hash, exchange);
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
      const publisher = new NativeWorkingSourcePublisher(200, hash, exchange);
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
