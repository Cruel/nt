import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  createNodeProjectWorkspaceFileSystem,
  type ProjectWorkspaceFileSystem,
} from '../../shared/project-workspace';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noveltea-workspace-fs-'));
  temporaryRoots.push(root);
  return root;
}

const implementations: readonly [string, () => ProjectWorkspaceFileSystem][] = [
  ['Node async operations', createNodeProjectWorkspaceFileSystem],
];

describe.each(implementations)('%s workspace filesystem contract', (_name, createFileSystem) => {
  it('shares atomic write, inspection, path, and removal behavior', async () => {
    const fileSystem = createFileSystem();
    const root = await temporaryRoot();
    const nested = fileSystem.joinPath(root, 'nested');
    const target = fileSystem.joinPath(nested, 'value.txt');

    expect(fileSystem.joinPath()).toBe('.');
    expect(await fileSystem.inspect(target)).toBe('missing');
    expect(await fileSystem.listDirectory(nested)).toEqual([]);

    await fileSystem.writeTextAtomic(target, 'hello');
    expect(await fileSystem.inspect(target)).toBe('file');
    expect(await fileSystem.readText(target)).toBe('hello');
    expect(Array.from(await fileSystem.readBytes(target))).toEqual([104, 101, 108, 108, 111]);
    expect(await fileSystem.listDirectory(nested)).toEqual(['value.txt']);
    expect(await fileSystem.realpath(nested)).toBe(await fs.realpath(nested));

    const exclusive = fileSystem.joinPath(root, 'exclusive');
    expect(await fileSystem.createDirectoryExclusive(exclusive)).toBe(true);
    expect(await fileSystem.createDirectoryExclusive(exclusive)).toBe(false);
    await fileSystem.removeFile(target);
    await fileSystem.removeFile(target);
    expect(await fileSystem.inspect(target)).toBe('missing');
    const child = fileSystem.joinPath(nested, 'child', 'nested.txt');
    await fileSystem.writeTextAtomic(child, 'nested');
    expect(await fileSystem.inspect(child)).toBe('file');
    await fileSystem.removeDirectory(nested);
    expect(await fileSystem.inspect(nested)).toBe('missing');
  });

  it('reports exact nanosecond metadata for regular Node filesystem paths', async () => {
    const fileSystem = createFileSystem();
    const root = await temporaryRoot();
    const target = fileSystem.joinPath(root, 'metadata.bin');
    await fileSystem.writeBytesAtomic(target, new Uint8Array([1, 2, 3]));

    const metadata = await fileSystem.readPathMetadata?.(target);
    expect(metadata).toMatchObject({ kind: 'file', byteSize: 3 });
    expect(metadata?.mtimeNanoseconds).toMatch(/^\d+$/u);
  });
});

describe('workspace filesystem host metadata override', () => {
  it('uses an injected exact metadata reader without changing the remaining filesystem adapter', async () => {
    const observed: string[] = [];
    const fileSystem = createNodeProjectWorkspaceFileSystem(async (value) => {
      observed.push(value);
      return { kind: 'file', byteSize: 7, mtimeNanoseconds: '1234567890123456789' };
    });

    await expect(fileSystem.readPathMetadata('/native/bridge')).resolves.toEqual({
      kind: 'file',
      byteSize: 7,
      mtimeNanoseconds: '1234567890123456789',
    });
    expect(observed).toEqual(['/native/bridge']);
  });
});
