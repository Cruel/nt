import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vite-plus/test';
// @ts-expect-error The packaged-editor verifier is intentionally authored as a Node ESM script.
import { findSharpNativeClosure } from '../../../scripts/verify-packaged-editor.mjs';

const temporaryRoots: string[] = [];

async function createUnpackedRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-packaged-editor-test-'));
  temporaryRoots.push(root);
  const imageRoot = path.join(root, 'node_modules', '@img');
  await mkdir(imageRoot, { recursive: true });
  return { root, imageRoot };
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
