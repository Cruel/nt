import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import {
  publishNativeComfyUiOutputs,
  publishNativeStagedComfyUiAssets,
} from '../../main/services/native-comfyui-asset-publication';
import type { ComfyUiGeneratedImage } from '../../main/services/comfyui-run-service';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const hash = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
const bytes = new Uint8Array([137, 80, 78, 71]);
const output: ComfyUiGeneratedImage = {
  outputId: 'image',
  format: 'png',
  mimeType: 'image/png',
  byteSize: bytes.length,
  contentHash: hash(bytes),
  width: 1,
  height: 1,
  hasAlpha: true,
  bytes,
};
const workflow = { id: 'fixture', label: 'Fixture' } as never;

it('publishes filesystem output through native-only helpers without reading any Project', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nt-native-publication-'));
  dirs.push(dir);
  const destination = path.join(dir, 'output.png');
  const native = vi.fn();
  const result = await publishNativeComfyUiOutputs({
    projectRoot: null,
    workflow,
    promptId: 'prompt',
    plan: {
      routes: {
        image: { outputId: 'image', target: 'filesystem', path: destination, cardinality: 'one' },
      },
    },
    outputs: { image: [output] },
    force: false,
    nativeProjectCommands: native,
  });
  expect(result.image).toEqual([
    expect.objectContaining({
      target: 'filesystem',
      path: destination,
      contentHash: output.contentHash,
    }),
  ]);
  expect(await readFile(destination)).toEqual(Buffer.from(bytes));
  expect(native).not.toHaveBeenCalled();
});

it('rolls back a replaced filesystem output when native Asset publication fails', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nt-native-publication-'));
  dirs.push(dir);
  const destination = path.join(dir, 'output.png');
  await writeFile(destination, 'previous-bytes');
  const native = vi.fn(async () => ({ ok: false, error: 'Source revision conflict.' }));
  await expect(
    publishNativeComfyUiOutputs({
      projectRoot: '/project',
      workflow,
      promptId: 'prompt',
      plan: {
        routes: {
          image: { outputId: 'image', target: 'filesystem', path: destination, cardinality: 'one' },
          asset: { outputId: 'asset', target: 'asset', cardinality: 'one' },
        },
      },
      outputs: { image: [output], asset: [{ ...output, outputId: 'asset' }] },
      force: true,
      nativeProjectCommands: native,
    }),
  ).rejects.toMatchObject({ code: 'COMFYUI_ASSET_PUBLICATION_CONFLICT' });
  expect(await readFile(destination, 'utf8')).toBe('previous-bytes');
  expect((await readdir(dir)).sort()).toEqual(['output.png']);
  expect(native).toHaveBeenCalledOnce();
});

it('rejects uncertain native transactions without retry or invented published Assets', async () => {
  const staged = {
    projectRoot: '/project',
    workflow: { id: 'fixture', label: 'Fixture' },
    promptId: 'prompt',
    assets: [
      {
        outputId: 'image',
        stagedPath: '/stage/image.png',
        output: {
          outputId: 'image',
          format: output.format,
          mimeType: output.mimeType,
          byteSize: output.byteSize,
          contentHash: output.contentHash,
          width: output.width,
          height: output.height,
          hasAlpha: output.hasAlpha,
        },
      },
    ],
  };
  const uncertain = vi.fn(async () => {
    throw Error('Transport lost after commit');
  });
  await expect(publishNativeStagedComfyUiAssets(staged, uncertain)).rejects.toMatchObject({
    code: 'COMFYUI_ASSET_PUBLICATION_FAILED',
  });
  expect(uncertain).toHaveBeenCalledOnce();
  const incomplete = vi.fn(async () => ({ ok: true, fields: { assets: [] } }));
  await expect(publishNativeStagedComfyUiAssets(staged, incomplete)).rejects.toMatchObject({
    code: 'COMFYUI_ASSET_PUBLICATION_FAILED',
  });
});
