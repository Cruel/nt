import { chmod, mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  findNodePtyNativeClosure,
  findSharpNativeClosure,
  // @ts-expect-error The packaged-editor verifier is intentionally authored as a Node ESM script.
} from '../../../scripts/verify-packaged-editor.mjs';
// @ts-expect-error Distribution helper is authored as Node ESM.
import { pruneForeignNodePtyPrebuilds } from '../../../scripts/node-pty-distribution.mjs';

const temporaryRoots: string[] = [];

async function createUnpackedRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-packaged-editor-test-'));
  temporaryRoots.push(root);
  const imageRoot = path.join(root, 'node_modules', '@img');
  await mkdir(imageRoot, { recursive: true });
  return { root, imageRoot };
}

async function createNodePtyRoot() {
  const { root } = await createUnpackedRoot();
  const nodePtyRoot = path.join(root, 'node_modules', 'node-pty');
  await mkdir(nodePtyRoot, { recursive: true });
  await writeFile(path.join(nodePtyRoot, 'package.json'), '{"name":"node-pty","version":"1.1.0"}');
  return { root, nodePtyRoot };
}

async function writeNativeFile(root: string, relativePath: string) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, 'fixture');
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('packaged node-pty native closure', () => {
  it('accepts the current Linux binding and rejects foreign prebuild natives', async () => {
    const { root, nodePtyRoot } = await createNodePtyRoot();
    await writeNativeFile(nodePtyRoot, 'build/Release/pty.node');

    await expect(findNodePtyNativeClosure(root, 'linux', 'x64')).resolves.toMatchObject({
      binding: expect.stringMatching(/build\/Release\/pty\.node$/),
    });

    await writeNativeFile(nodePtyRoot, 'prebuilds/win32-x64/conpty.node');
    await expect(findNodePtyNativeClosure(root, 'linux', 'x64')).rejects.toThrow(
      'foreign node-pty native artifact',
    );
  });

  it('requires the platform-specific binding rather than accepting any .node file', async () => {
    const { root, nodePtyRoot } = await createNodePtyRoot();
    await writeNativeFile(nodePtyRoot, 'prebuilds/win32-x64/pty.node');

    await expect(findNodePtyNativeClosure(root, 'win32', 'x64')).rejects.toThrow(
      'required node-pty native binding',
    );
  });

  it('accepts only the matching Windows prebuild tuple', async () => {
    const { root, nodePtyRoot } = await createNodePtyRoot();
    await writeNativeFile(nodePtyRoot, 'prebuilds/win32-x64/conpty.node');

    await expect(findNodePtyNativeClosure(root, 'win32', 'x64')).resolves.toMatchObject({
      binding: expect.stringMatching(/prebuilds\/win32-x64\/conpty\.node$/),
    });
  });

  it('requires the executable macOS spawn-helper alongside the native binding', async () => {
    const { root, nodePtyRoot } = await createNodePtyRoot();
    await writeNativeFile(nodePtyRoot, 'prebuilds/darwin-arm64/pty.node');

    await expect(findNodePtyNativeClosure(root, 'darwin', 'arm64')).rejects.toThrow(
      'required macOS spawn-helper',
    );

    await writeNativeFile(nodePtyRoot, 'prebuilds/darwin-arm64/spawn-helper');
    await expect(findNodePtyNativeClosure(root, 'darwin', 'arm64')).rejects.toThrow(
      'spawn-helper is not executable',
    );

    await chmod(path.join(nodePtyRoot, 'prebuilds/darwin-arm64/spawn-helper'), 0o755);
    await expect(findNodePtyNativeClosure(root, 'darwin', 'arm64')).resolves.toMatchObject({
      binding: expect.stringMatching(/prebuilds\/darwin-arm64\/pty\.node$/),
      spawnHelper: expect.stringMatching(/prebuilds\/darwin-arm64\/spawn-helper$/),
    });
  });

  it('normalizes the retained macOS spawn-helper executable bit during staging', async () => {
    const { nodePtyRoot } = await createNodePtyRoot();
    await writeNativeFile(nodePtyRoot, 'prebuilds/darwin-arm64/pty.node');
    await writeNativeFile(nodePtyRoot, 'prebuilds/darwin-arm64/spawn-helper');

    await pruneForeignNodePtyPrebuilds(nodePtyRoot, 'darwin', 'arm64');

    const helper = await stat(path.join(nodePtyRoot, 'prebuilds/darwin-arm64/spawn-helper'));
    expect(helper.mode & 0o111).not.toBe(0);
  });

  it('prunes every foreign prebuild tuple while retaining the current one', async () => {
    const { nodePtyRoot } = await createNodePtyRoot();
    await writeNativeFile(nodePtyRoot, 'prebuilds/win32-x64/conpty.node');
    await writeNativeFile(nodePtyRoot, 'prebuilds/win32-arm64/conpty.node');
    await writeNativeFile(nodePtyRoot, 'prebuilds/darwin-arm64/pty.node');

    await pruneForeignNodePtyPrebuilds(nodePtyRoot, 'win32', 'x64');

    await expect(readdir(path.join(nodePtyRoot, 'prebuilds'))).resolves.toEqual(['win32-x64']);
  });
});

describe('packaged Sharp native closure', () => {
  it('accepts the Windows package that carries both the binding and libvips DLLs', async () => {
    const { root, imageRoot } = await createUnpackedRoot();
    const sharpRoot = path.join(imageRoot, 'sharp-win32-x64');
    await writeNativeFile(sharpRoot, 'lib/sharp-win32-x64.node');
    await writeNativeFile(sharpRoot, 'lib/libvips-42.dll');

    await expect(findSharpNativeClosure(root, 'win32')).resolves.toEqual({
      sharpPackages: ['sharp-win32-x64'],
      libvipsPackages: [],
    });
  });

  it('still requires a separate libvips package on Linux', async () => {
    const { root, imageRoot } = await createUnpackedRoot();
    const sharpRoot = path.join(imageRoot, 'sharp-linux-x64');
    await writeNativeFile(sharpRoot, 'lib/sharp-linux-x64.node');

    await expect(findSharpNativeClosure(root, 'linux')).rejects.toThrow(
      'Packaged @img closure is incomplete',
    );
  });
});
