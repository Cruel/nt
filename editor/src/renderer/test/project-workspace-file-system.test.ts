import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  createNodeProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  projectWorkspaceFiles,
  type ProjectWorkspaceFileSystem,
} from '../../shared/project-workspace';

import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

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

  it('binds decoded text to exact source bytes without caching later freshness proofs', async () => {
    const fileSystem = createFileSystem();
    const root = await temporaryRoot();
    const target = fileSystem.joinPath(root, 'text.lua');
    await fileSystem.writeBytesAtomic(
      target,
      new Uint8Array([0xef, 0xbb, 0xbf, 0xc3, 0xa9, 0xff, 0x0d, 0x0a]),
    );
    const observed = await fileSystem.readTextWithRevision!(target);
    expect(observed).toEqual({
      text: '\uFEFFé\uFFFD\r\n',
      revision: {
        contentHash: 'sha256:59572212b8c2d4fb3de2a5bcbbb33075195edd024bc26f365a27b65c6bb4bfbd',
        byteSize: 8,
      },
    });
    expect(observed.text).toBe(await fileSystem.readText(target));
    await fileSystem.writeTextAtomic(target, 'changed');
    expect(await fileSystem.readFileRevision(target)).not.toEqual(observed.revision);
  });

  it('admits the same source revisions and Project through combined text reads', async () => {
    const fileSystem = createFileSystem();
    const root = await temporaryRoot();
    const project = createAuthoringProject({ id: 'read-once', name: 'Read once' });
    for (const [file, text] of Object.entries(projectWorkspaceFiles(project, project.editor)))
      await fileSystem.writeTextAtomic(fileSystem.joinPath(root, file), text);
    const combined = await new ProjectWorkspaceService(fileSystem).open(root);
    // The optional adapter method changes admission work, not the admitted generation contract.
    Object.defineProperty(fileSystem, 'readTextWithRevision', { value: undefined });
    const separate = await new ProjectWorkspaceService(fileSystem).open(root);
    expect(combined.ok).toBe(true);
    expect(separate.ok).toBe(true);
    if (!combined.ok || !separate.ok) return;
    expect(combined.snapshot.project).toEqual(separate.snapshot.project);
    expect(combined.snapshot.fileRevisions).toEqual(separate.snapshot.fileRevisions);
    expect(combined.diagnostics).toEqual(separate.diagnostics);
  });

  it('reports exact nanosecond metadata for regular Node filesystem paths', async () => {
    const fileSystem = createFileSystem();
    const root = await temporaryRoot();
    const target = fileSystem.joinPath(root, 'metadata.bin');
    await fileSystem.writeBytesAtomic(target, new Uint8Array([1, 2, 3]));

    const metadata = await fileSystem.readPathMetadata?.(target);
    expect(metadata).toMatchObject({ kind: 'file', byteSize: 3 });
    expect(metadata?.sourceIdentity).toMatch(process.platform === 'win32' ? /^win:/u : /^posix:/u);
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
