import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  inspectWorkingSourcePublication,
  isWorkingSourceOwner,
  workingSourceForNativeOwner,
  workingSourceBaselinePath,
  workingSourceManifestSchema,
  workingSourcePaths,
  workingSourcePendingSchema,
} from '../../shared/project-workspace/working-source-contract';

const root = path.resolve(process.cwd(), 'src/renderer/test/fixtures/working-source-projection');
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

async function fixture(relative: string): Promise<Buffer> {
  return readFile(path.join(root, relative));
}

describe('agent-editable working-source contract (#624)', () => {
  it('pins an exact-byte, per-physical-owner fixture including malformed YAML, text, deletion and drafts', async () => {
    const manifest = workingSourceManifestSchema.parse(
      JSON.parse((await fixture('manifest.json')).toString()),
    );
    expect(manifest.publication).toBe(7);
    expect(Object.keys(manifest.entries)).toEqual([
      'records/rooms/hall.yaml',
      'records/rooms/trouble.yaml',
      'scripts/helper.lua',
      'records/rooms/old.yaml',
    ]);
    for (const [owner, entry] of Object.entries(manifest.entries)) {
      const paths = workingSourcePaths(owner);
      const published = await fixture(
        entry.representation === 'deleted' ? paths.deletion : paths.file,
      );
      expect(digest(published)).toBe(entry.publishedRevision);
      const baseline = await fixture(workingSourceBaselinePath(entry.publishedRevision!));
      expect(baseline).toEqual(published);
      expect(
        inspectWorkingSourcePublication(
          entry.publishedRevision!,
          digest(baseline),
          digest(published),
        ),
      ).toBe('unchanged');
      if (entry.pendingRevision) {
        const pending = await fixture(paths.pending);
        expect(digest(pending)).toBe(entry.pendingRevision);
        expect(await fixture(workingSourceBaselinePath(entry.pendingRevision))).toEqual(pending);
        expect(workingSourcePendingSchema.parse(JSON.parse(pending.toString()))).toEqual({
          fieldText: { '/rooms/hall/data/width': '-' },
          namedText: { 'source-yaml': 'data: [broken' },
        });
      }
    }
    expect((await fixture('files/records/rooms/trouble.yaml')).toString()).toBe(
      'id: trouble\ndata: [broken\n',
    );
    expect(
      JSON.parse((await fixture('deletions/records/rooms/old.yaml.delete.json')).toString()),
    ).toEqual({ deleted: true });
  });

  it('maps all relevant source families without allowing lexical escapes or unsupported files', () => {
    for (const owner of [
      'project.yaml',
      'traits.yaml',
      'editor.yaml',
      'i18n/project.yaml',
      'i18n/messages.yaml',
      'i18n/usage-notes.yaml',
      'i18n/tracking.yaml',
      'i18n/orphans.yaml',
      'i18n/locales/fr-CA.yaml',
      'i18n/assets/ja.yaml',
      'records/rooms/hall.yaml',
      'records/layouts/menu/layout.yaml',
      'records/layouts/menu/layout.rml',
      'records/layouts/menu/layout.rcss',
      'records/layouts/menu/layout.lua',
      'scripts/helper.lua',
      'scripts/sub/util.lua',
      'shaders/material/frag.sc',
    ]) {
      expect(isWorkingSourceOwner(owner), owner).toBe(true);
      const paths = workingSourcePaths(owner);
      expect(paths.file).toBe(`files/${owner}`);
      expect(new Set(Object.values(paths)).size).toBe(3);
    }
    for (const owner of [
      '',
      '/project.yaml',
      '../project.yaml',
      'records/../project.yaml',
      'records/rooms/../../secrets.yaml',
      'scripts/x/../helper.lua',
      'scripts\\evil.lua',
      'C:/project.yaml',
      '.noveltea/editor/state.json',
      'records/unknown/item.yaml',
      'records/layouts/menu.yaml',
      'records/assets/image.png',
      'workflows/workflow.json',
      'assets/source.png',
      'records/rooms/.',
      'scripts/folder/',
      'shaders/folder/',
    ]) {
      expect(isWorkingSourceOwner(owner), owner).toBe(false);
      expect(() => workingSourcePaths(owner)).toThrow();
    }
  });

  it('maps native physical ownership without conflating it with logical Save units', () => {
    expect(workingSourceForNativeOwner('project')).toBe('project.yaml');
    expect(workingSourceForNativeOwner('traits')).toBe('traits.yaml');
    expect(workingSourceForNativeOwner('editor')).toBe('editor.yaml');
    expect(workingSourceForNativeOwner('rooms/hall')).toBe('records/rooms/hall.yaml');
    expect(workingSourceForNativeOwner('layouts/menu')).toBe('records/layouts/menu/layout.yaml');
    expect(workingSourceForNativeOwner('i18n/locales/fr.yaml')).toBe('i18n/locales/fr.yaml');
    expect(workingSourceForNativeOwner('scripts/helper.lua')).toBe('scripts/helper.lua');
    expect(workingSourceForNativeOwner('record:rooms:hall')).toBeNull();
    expect(workingSourceForNativeOwner('constructor')).toBeNull();
    expect(workingSourceForNativeOwner('rooms/../../escape')).toBeNull();
    expect(workingSourceForNativeOwner('rooms/bad\\name')).toBeNull();
  });

  it('rejects fabricated owners, wrong revisions, missing metadata and alternate shapes', async () => {
    const manifest = JSON.parse((await fixture('manifest.json')).toString());
    expect(workingSourceManifestSchema.safeParse({ ...manifest, publication: -1 }).success).toBe(
      false,
    );
    expect(workingSourceManifestSchema.safeParse({ ...manifest, schema: 'other' }).success).toBe(
      false,
    );
    expect(workingSourceManifestSchema.safeParse({ ...manifest, version: 1 }).success).toBe(false);
    expect(
      workingSourceManifestSchema.safeParse({
        ...manifest,
        entries: {
          ...manifest.entries,
          '../escaped.yaml': manifest.entries['records/rooms/hall.yaml'],
        },
      }).success,
    ).toBe(false);
    const altered = structuredClone(manifest);
    altered.entries['records/rooms/hall.yaml'].diskRevision = 'sha256:' + 'a'.repeat(64);
    expect(workingSourceManifestSchema.safeParse(altered).success).toBe(false);
    expect(
      workingSourceManifestSchema.safeParse({
        ...manifest,
        entries: {
          'project.yaml': {
            representation: 'pending-only',
            publishedRevision: null,
            pendingRevision: 'sha256:' + 'a'.repeat(64),
            diskRevision: 'absent',
            checkpointRevision: 'sha256:' + 'b'.repeat(64),
            localStateRevision: null,
          },
        },
      }).success,
    ).toBe(true);
  });

  it('distinguishes stale published bytes and damaged baselines from unchanged files', async () => {
    const manifest = workingSourceManifestSchema.parse(
      JSON.parse((await fixture('manifest.json')).toString()),
    );
    const room = manifest.entries['records/rooms/hall.yaml']!;
    const baseline = await fixture(workingSourceBaselinePath(room.publishedRevision!));
    const agentEdit = Buffer.from(baseline.toString().replace('Unfinished', 'Agent repaired'));
    expect(
      inspectWorkingSourcePublication(room.publishedRevision!, digest(baseline), digest(agentEdit)),
    ).toBe('changed');
    expect(
      inspectWorkingSourcePublication(room.publishedRevision!, digest(agentEdit), digest(baseline)),
    ).toBe('untrusted-baseline');
    expect(inspectWorkingSourcePublication(room.publishedRevision!, null, null)).toBe(
      'untrusted-baseline',
    );
    expect(inspectWorkingSourcePublication(room.publishedRevision!, digest(baseline), null)).toBe(
      'changed',
    );
    expect(() => workingSourceBaselinePath('../other')).toThrow();
  });
});
