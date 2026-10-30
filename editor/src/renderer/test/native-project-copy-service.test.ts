import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dialogState = vi.hoisted(() => ({ destination: '', confirmed: true }));
vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [dialogState.destination] }),
    showMessageBox: async () => ({ response: dialogState.confirmed ? 1 : 0 }),
  },
}));
import { saveNativeProjectCopyAs } from '../../main/services/native-project-copy-service';

const roots: string[] = [];
async function fixture() {
  const parent = await mkdtemp(path.join(tmpdir(), 'nt-native-copy-'));
  roots.push(parent);
  const source = path.join(parent, 'source');
  const destination = path.join(parent, 'destination');
  await mkdir(path.join(source, 'records', 'rooms'), { recursive: true });
  await mkdir(path.join(source, 'scripts'), { recursive: true });
  await mkdir(path.join(source, '.noveltea', 'transactions'), { recursive: true });
  await mkdir(destination);
  await writeFile(
    path.join(source, 'project.yaml'),
    'project: \n  id: original # native comment\n',
  );
  await writeFile(path.join(source, 'records', 'rooms', 'main.yaml'), 'id: main # keep\n');
  await writeFile(path.join(source, 'scripts', 'game.lua'), '-- source\n');
  await writeFile(path.join(source, '.noveltea', 'transactions', 'stale.json'), 'LOCAL');
  dialogState.destination = destination;
  dialogState.confirmed = true;
  return { source, destination };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native saved Project Copy As', () => {
  it('copies byte-exact saved YAML and sources, never reserializing renderer Project content', async () => {
    const { source, destination } = await fixture();
    const verify = vi.fn().mockResolvedValue(undefined);
    const response = await saveNativeProjectCopyAs(
      {} as never,
      source,
      { project: { id: 'malicious-renderer-content' }, editor: {} },
      verify,
    );
    expect(response.success).toBe(true);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(destination, 'project.yaml'), 'utf8')).toBe(
      'project: \n  id: original # native comment\n',
    );
    expect(await readFile(path.join(destination, 'records', 'rooms', 'main.yaml'), 'utf8')).toBe(
      'id: main # keep\n',
    );
    expect(await readFile(path.join(destination, 'scripts', 'game.lua'), 'utf8')).toBe(
      '-- source\n',
    );
    await expect(
      readFile(path.join(destination, '.noveltea', 'transactions', 'stale.json')),
    ).rejects.toThrow();
    expect(
      await readFile(path.join(destination, '.noveltea', 'editor', 'state.json'), 'utf8'),
    ).toContain('recovery');
  });

  it('leaves the destination unchanged on a stale native source verification', async () => {
    const { source, destination } = await fixture();
    let checks = 0;
    const result = await saveNativeProjectCopyAs({} as never, source, {}, async () => {
      if (++checks === 2) throw new Error('WORKSPACE_REVISION_CONFLICT');
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('WORKSPACE_REVISION_CONFLICT');
    expect(await readdir(destination)).toEqual([]);
  });

  it('preserves unrelated destination files and refuses linked sources', async () => {
    const { source, destination } = await fixture();
    await writeFile(path.join(destination, 'notes.txt'), 'KEEP');
    const result = await saveNativeProjectCopyAs({} as never, source, {}, async () => undefined);
    expect(result.success, result.error).toBe(true);
    expect(await readFile(path.join(destination, 'notes.txt'), 'utf8')).toBe('KEEP');
    const second = await fixture();
    await symlink(
      path.join(second.source, 'project.yaml'),
      path.join(second.source, 'outside.yaml'),
    );
    const refused = await saveNativeProjectCopyAs(
      {} as never,
      second.source,
      {},
      async () => undefined,
    );
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('symbolic link');
    expect(await readdir(second.destination)).toEqual([]);
  });
});
