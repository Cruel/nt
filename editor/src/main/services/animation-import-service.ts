import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AssetImportResponse, ImportedAssetMetadata } from '../../shared/asset-import';
import {
  defaultAssetIdFromFilename,
  sanitizeAssetFilename,
} from '../../shared/project-schema/authoring-assets';
import { prepareRasterAnimation } from './raster-animation-import';
import { MAX_RASTER_IMPORT_FRAMES } from './raster-import-limits';
import { writeProjectAssetFilesTransaction } from './project-asset-file-transaction';

const MAX_SOURCE_BYTES = 128 * 1024 * 1024;

export async function importAnimationFiles(
  projectRoot: string,
  sourcePaths: string[],
  frameDurationMs: number,
  assertAuthority: () => void = () => {},
): Promise<AssetImportResponse> {
  try {
    assertAuthority();
    if (!sourcePaths.length || sourcePaths.length > MAX_RASTER_IMPORT_FRAMES)
      throw new Error('Invalid Animation source count.');
    const order = new Intl.Collator('en', { numeric: true, sensitivity: 'variant' });
    const sorted = [...sourcePaths].sort(
      (a, b) => order.compare(path.basename(a), path.basename(b)) || order.compare(a, b),
    );
    const sources = [];
    let sourceBytes = 0;
    for (const filename of sorted) {
      const stat = await fs.stat(filename);
      sourceBytes += stat.size;
      if (!stat.isFile() || sourceBytes > MAX_SOURCE_BYTES)
        throw new Error('Animation sources exceed the file-size limit.');
      const bytes = await fs.readFile(filename);
      sourceBytes += bytes.length - stat.size;
      if (sourceBytes > MAX_SOURCE_BYTES)
        throw new Error('Animation sources exceed the file-size limit.');
      sources.push({ name: path.basename(filename), bytes });
    }
    const prepared = await prepareRasterAnimation(sources, frameDurationMs);
    const label = path.parse(sources[0]!.name).name;
    const stem = defaultAssetIdFromFilename(label);
    let directory = `assets/images/${stem}-animation`;
    for (let suffix = 2; ; suffix++) {
      try {
        await fs.access(path.join(projectRoot, directory));
        directory = `assets/images/${stem}-animation-${suffix}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        break;
      }
    }
    const importedAt = new Date().toISOString();
    const assets: ImportedAssetMetadata[] = [];
    const files: { path: string; bytes: Buffer }[] = [];
    const metadata = (name: string, originalPath: string, relative: string, bytes: Buffer) => ({
      originalPath,
      originalName: name,
      projectRelativePath: relative,
      extension: path.extname(name).toLowerCase(),
      byteSize: bytes.length,
      contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      importedAt,
    });
    for (const [index, frame] of prepared.frames.entries()) {
      const name = `${stem}-frame-${String(index + 1).padStart(4, '0')}.png`;
      const relative = `${directory}/${name}`;
      files.push({ path: relative, bytes: frame.png });
      assets.push({
        ...metadata(
          name,
          sorted[prepared.format === 'image-sequence' ? index : 0]!,
          relative,
          frame.png,
        ),
        kind: 'image',
        mimeType: 'image/png',
        imageMetadata: { ...prepared.canvas, hasAlpha: true, orientation: 1 },
      });
    }
    const sourceAssetIndices: number[] = [];
    for (const [index, source] of sources.entries()) {
      const relative = `${directory}/sources/${String(index + 1).padStart(4, '0')}-${sanitizeAssetFilename(source.name)}`;
      files.push({ path: relative, bytes: source.bytes });
      sourceAssetIndices.push(assets.length);
      assets.push({
        ...metadata(source.name, sorted[index]!, relative, source.bytes),
        kind: 'binary',
        mimeType: 'application/octet-stream',
        imageMetadata: null,
      });
    }
    assertAuthority();
    await writeProjectAssetFilesTransaction(projectRoot, files, 'Animation import');
    return {
      ok: true,
      success: true,
      assets,
      diagnostics: [],
      animation: {
        label,
        format: prepared.format,
        canvas: prepared.canvas,
        frameDurationMs,
        frames: prepared.frames.map((frame, assetIndex) => ({
          assetIndex,
          durationMs: frame.durationMs,
        })),
        sourceAssetIndices,
      },
    };
  } catch (error) {
    return {
      ok: false,
      success: false,
      assets: [],
      diagnostics: [],
      error: error instanceof Error ? error.message : 'Animation import failed.',
    };
  }
}
