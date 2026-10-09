import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { ImportedAssetMetadata } from '../../shared/asset-import';
import type {
  ProjectAssetAuditResponse,
  ProjectAssetFileOperationResponse,
  ProjectAssetOrganizationAction,
  ProjectAssetTrashMove,
} from '../../shared/project-asset-audit';
import {
  inferAssetKindFromExtension,
  parseAssetData,
} from '../../shared/project-schema/authoring-assets';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import { PROJECT_WORKSPACE_ABSENT_REVISION } from '../../shared/project-workspace/project-workspace-transaction';
import { moveProjectAssetFileTransaction } from './project-asset-file-transaction';

function projectRootFromFile(projectFilePath: string): string {
  return path.dirname(path.resolve(projectFilePath));
}
function slashPath(value: string): string {
  return value.split(path.sep).join('/');
}
function diagnostic(
  pathValue: string | undefined,
  message: string,
  severity: 'error' | 'warning' | 'info' = 'error',
) {
  return { severity, path: pathValue, message };
}

function mimeForExtension(extension: string): string | undefined {
  switch (extension.toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.bmp':
      return 'image/bmp';
    case '.svg':
      return 'image/svg+xml';
    case '.ttf':
      return 'font/ttf';
    case '.otf':
      return 'font/otf';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    case '.mp3':
      return 'audio/mpeg';
    case '.ogg':
      return 'audio/ogg';
    case '.wav':
      return 'audio/wav';
    case '.flac':
      return 'audio/flac';
    case '.m4a':
      return 'audio/mp4';
    case '.mp4':
      return 'video/mp4';
    case '.m4v':
      return 'video/x-m4v';
    case '.webm':
      return 'video/webm';
    case '.mkv':
      return 'video/x-matroska';
    case '.mov':
      return 'video/quicktime';
    case '.lua':
      return 'text/x-lua';
    case '.json':
      return 'application/json';
    case '.txt':
      return 'text/plain';
    default:
      return undefined;
  }
}
const MEDIA_KINDS = new Set(['image', 'font', 'audio', 'video']);
const INSPECTION_BYTES = 4096;
const INSPECTION_CONCURRENCY = 6;

function isRecognizedMedia(extension: string, bytes: Buffer): boolean {
  const ascii = (start: number, end: number) => bytes.toString('ascii', start, end);
  const starts = (magic: string) => ascii(0, magic.length) === magic;
  switch (extension) {
    case '.png':
      return (
        bytes.length >= 33 &&
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        bytes.readUInt32BE(8) === 13 &&
        ascii(12, 16) === 'IHDR' &&
        bytes.readUInt32BE(16) > 0 &&
        bytes.readUInt32BE(20) > 0
      );
    case '.jpg':
    case '.jpeg':
      return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case '.gif':
      return (
        bytes.length >= 13 &&
        (starts('GIF87a') || starts('GIF89a')) &&
        bytes.readUInt16LE(6) > 0 &&
        bytes.readUInt16LE(8) > 0
      );
    case '.webp':
      return (
        bytes.length >= 20 &&
        starts('RIFF') &&
        ascii(8, 12) === 'WEBP' &&
        ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(12, 16))
      );
    case '.bmp':
      return starts('BM') && bytes.length >= 26 && bytes.readInt32LE(18) > 0;
    case '.svg':
      return /<svg(?:\s|>)/i.test(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    case '.ttf':
      return (
        bytes.length >= 28 &&
        bytes.readUInt32BE(0) === 0x00010000 &&
        bytes.readUInt16BE(4) > 0 &&
        bytes.length >= 12 + bytes.readUInt16BE(4) * 16
      );
    case '.otf':
      return (
        starts('OTTO') &&
        bytes.length >= 28 &&
        bytes.readUInt16BE(4) > 0 &&
        bytes.length >= 12 + bytes.readUInt16BE(4) * 16
      );
    case '.woff':
      return starts('wOFF') && bytes.length >= 44;
    case '.woff2':
      return starts('wOF2') && bytes.length >= 48;
    case '.mp3':
      return (
        (bytes.length >= 10 && starts('ID3') && bytes[3] >= 2 && bytes[3] <= 4) ||
        (bytes.length >= 4 && bytes[0] === 0xff && (bytes[1] & 0xe6) === 0xe2)
      );
    case '.ogg':
      return starts('OggS');
    case '.wav':
      return starts('RIFF') && bytes.length >= 16 && ascii(8, 12) === 'WAVE';
    case '.flac':
      return starts('fLaC');
    case '.m4a':
    case '.mp4':
    case '.m4v':
    case '.mov':
      return bytes.length >= 12 && ascii(4, 8) === 'ftyp';
    case '.mkv':
    case '.webm':
      return (
        bytes.length >= 8 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
      );
    default:
      return false;
  }
}

async function readMediaHeader(absolutePath: string): Promise<Buffer> {
  const handle = await fs.open(absolutePath, 'r');
  try {
    const bytes = Buffer.alloc(INSPECTION_BYTES);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function mapLimited<T, U>(values: T[], mapper: (value: T) => Promise<U>): Promise<U[]> {
  const results: U[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(INSPECTION_CONCURRENCY, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await mapper(values[index]);
      }
    }),
  );
  return results;
}

function correctFolder(kind: string): string {
  return { image: 'images', font: 'fonts', audio: 'audio', video: 'video' }[kind] ?? '';
}

function isTemporaryOrHiddenAssetPath(filePath: string) {
  const base = path.basename(filePath);
  if (base === '.DS_Store' || base === 'Thumbs.db') return true;
  if (base.startsWith('.') || base.startsWith('~') || base.startsWith('.~')) return true;
  const ext = path.extname(base).toLowerCase();
  return ext === '.tmp' || ext === '.part' || ext === '.crdownload' || ext === '.download';
}

function safeProjectRelativePath(projectFilePath: string, projectRelativePath: string) {
  const projectRoot = projectRootFromFile(projectFilePath);
  const absolute = path.resolve(projectRoot, projectRelativePath);
  const relative = path.relative(projectRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return { projectRoot, absolute, relative: slashPath(relative) };
}

function safeAssetRelativePath(projectFilePath: string, projectRelativePath: string) {
  const resolved = safeProjectRelativePath(projectFilePath, projectRelativePath);
  if (!resolved) return null;
  if (resolved.relative !== 'assets' && !resolved.relative.startsWith('assets/')) return null;
  return resolved;
}

async function walkFiles(root: string): Promise<string[]> {
  let entries: Array<import('node:fs').Dirent> = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (isTemporaryOrHiddenAssetPath(absolute)) continue;
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolute)));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

async function inspectUntrackedAssetFile(
  projectRoot: string,
  absolutePath: string,
  stat: import('node:fs').Stats,
): Promise<ProjectAssetAuditResponse['untrackedFiles'][number]> {
  const relative = slashPath(path.relative(projectRoot, absolutePath));
  const extension = path.extname(absolutePath).toLowerCase();
  const mimeType = mimeForExtension(extension);
  const kind = inferAssetKindFromExtension(extension);
  const importable =
    MEDIA_KINDS.has(kind) &&
    stat.size > 0 &&
    isRecognizedMedia(extension, await readMediaHeader(absolutePath));
  const folder = correctFolder(kind);
  const suggestedMove =
    importable && folder && !relative.startsWith(`assets/${folder}/`)
      ? 'correct-folder'
      : !MEDIA_KINDS.has(kind)
        ? 'support'
        : undefined;
  return {
    projectRelativePath: relative,
    absolutePath,
    kind,
    extension,
    mimeType,
    byteSize: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    revision: `${stat.size}:${stat.mtimeMs}`,
    importable,
    suggestedMove,
  };
}

function referencedAssetPaths(project: unknown) {
  const paths = new Set<string>();
  if (!isAuthoringProject(project)) return paths;
  for (const record of Object.values(project.assets)) {
    const data = parseAssetData(record.data);
    if (data?.source.path) paths.add(data.source.path);
    if (data) for (const attachment of data.attachments) paths.add(attachment.path);
  }
  return paths;
}

async function metadataForExistingAsset(
  projectFilePath: string,
  projectRelativePath: string,
): Promise<ImportedAssetMetadata> {
  const safe = safeAssetRelativePath(projectFilePath, projectRelativePath);
  if (!safe) throw new Error('Asset path is not inside the project assets directory.');
  const bytes = await fs.readFile(safe.absolute);
  const extension = path.extname(safe.absolute).toLowerCase();
  const kind = inferAssetKindFromExtension(extension);
  if (MEDIA_KINDS.has(kind) && !isRecognizedMedia(extension, bytes.subarray(0, INSPECTION_BYTES)))
    throw new Error(`File does not contain a recognized ${kind} format (${extension}).`);
  const common = {
    originalPath: safe.absolute,
    originalName: path.basename(safe.absolute),
    projectRelativePath: safe.relative,
    extension,
    mimeType: mimeForExtension(extension),
    byteSize: bytes.byteLength,
    contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    importedAt: new Date().toISOString(),
  };
  if (kind !== 'image') return { ...common, kind, imageMetadata: null };
  const imageMetadata = await sharp(bytes, { failOn: 'error' })
    .metadata()
    .then((metadata) => {
      if (!metadata.width || !metadata.height)
        throw new Error('Image dimensions could not be determined.');
      if (metadata.width > 65535 || metadata.height > 65535)
        throw new Error('Image dimensions must not exceed 65535 pixels.');
      return {
        width: metadata.width,
        height: metadata.height,
        hasAlpha: metadata.hasAlpha,
        orientation: (metadata.orientation ?? 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
      };
    });
  return { ...common, kind, imageMetadata };
}

async function trashPathFor(projectFilePath: string, projectRelativePath: string) {
  const projectRoot = projectRootFromFile(projectFilePath);
  const operationId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2)}`;
  const trashRelativePath = slashPath(
    path.join('.noveltea', 'trash', 'assets', operationId, projectRelativePath),
  );
  const absolute = path.resolve(projectRoot, trashRelativePath);
  return { trashRelativePath, absolute };
}

async function moveAssetToTrash(
  projectFilePath: string,
  projectRelativePath: string,
  assertAuthority?: () => void,
) {
  const safe = safeAssetRelativePath(projectFilePath, projectRelativePath);
  if (!safe) throw new Error('Only files inside assets/ can be moved to project trash.');
  const destination = await trashPathFor(projectFilePath, safe.relative);
  assertAuthority?.();
  await moveProjectAssetFileTransaction(
    projectRootFromFile(projectFilePath),
    safe.relative,
    destination.trashRelativePath,
    'asset trash',
    PROJECT_WORKSPACE_ABSENT_REVISION,
  );
  return { projectRelativePath: safe.relative, trashRelativePath: destination.trashRelativePath };
}

export async function auditProjectAssets(
  projectFilePath: string,
  project: unknown,
  assertAuthority?: () => void,
): Promise<ProjectAssetAuditResponse> {
  if (!projectFilePath)
    return {
      ok: false,
      success: false,
      untrackedFiles: [],
      skippedUnstableFiles: [],
      diagnostics: [diagnostic('/assets', 'Asset audit requires a saved project file.')],
      error: 'Project file path is required.',
    };
  assertAuthority?.();
  const projectRoot = projectRootFromFile(projectFilePath);
  const assetsRoot = path.join(projectRoot, 'assets');
  const referenced = referencedAssetPaths(project);
  const untrackedFiles: ProjectAssetAuditResponse['untrackedFiles'] = [];
  const skippedUnstableFiles: string[] = [];
  const diagnostics: ProjectAssetAuditResponse['diagnostics'] = [];
  try {
    const files = await walkFiles(assetsRoot);
    assertAuthority?.();
    const candidates = files
      .map((absolutePath) => ({
        absolutePath,
        relative: slashPath(path.relative(projectRoot, absolutePath)),
      }))
      .filter((file) => !referenced.has(file.relative));
    const initialStats = await mapLimited(candidates, async ({ absolutePath }) => {
      try {
        return await fs.stat(absolutePath);
      } catch {
        return null;
      }
    });
    // One shared settle interval keeps file-write stability checks bounded for large batches.
    if (candidates.length) await new Promise((resolve) => setTimeout(resolve, 200));
    const inspected = await mapLimited(
      candidates.map((candidate, index) => ({ ...candidate, first: initialStats[index] })),
      async ({ absolutePath, relative, first }) => {
        try {
          const second = await fs.stat(absolutePath);
          if (!first || first.size !== second.size || first.mtimeMs !== second.mtimeMs)
            return { relative, unstable: true as const };
          return { file: await inspectUntrackedAssetFile(projectRoot, absolutePath, second) };
        } catch (error) {
          return { relative, error };
        }
      },
    );
    assertAuthority?.();
    for (const result of inspected) {
      if ('file' in result && result.file) untrackedFiles.push(result.file);
      else if ('unstable' in result) skippedUnstableFiles.push(result.relative);
      else
        diagnostics.push(
          diagnostic(
            result.relative,
            result.error instanceof Error ? result.error.message : 'Failed to inspect asset file.',
            'warning',
          ),
        );
    }
    untrackedFiles.sort((left, right) =>
      left.projectRelativePath.localeCompare(right.projectRelativePath),
    );
    return {
      ok: diagnostics.every((item) => item.severity !== 'error'),
      success: true,
      projectFilePath,
      untrackedFiles,
      skippedUnstableFiles,
      diagnostics,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Asset audit failed.';
    return {
      ok: false,
      success: false,
      projectFilePath,
      untrackedFiles: [],
      skippedUnstableFiles,
      diagnostics: [diagnostic('/assets', message)],
      error: message,
    };
  }
}
export async function importUntrackedProjectAssets(
  projectFilePath: string,
  projectRelativePaths: string[],
  assertAuthority?: () => void,
): Promise<ProjectAssetFileOperationResponse> {
  const assets: ImportedAssetMetadata[] = [];
  const diagnostics: ProjectAssetFileOperationResponse['diagnostics'] = [];
  for (const relativePath of projectRelativePaths) {
    try {
      assertAuthority?.();
      assets.push(await metadataForExistingAsset(projectFilePath, relativePath));
    } catch (error) {
      diagnostics.push(
        diagnostic(
          relativePath,
          error instanceof Error ? error.message : 'Failed to import untracked asset.',
        ),
      );
    }
  }
  return {
    ok: diagnostics.every((item) => item.severity !== 'error'),
    success: assets.length > 0,
    assets,
    diagnostics,
    error: diagnostics.find((item) => item.severity === 'error')?.message,
  };
}

export async function organizeUntrackedProjectAsset(
  projectFilePath: string,
  project: unknown,
  projectRelativePath: string,
  action: ProjectAssetOrganizationAction,
  assertAuthority?: () => void,
): Promise<ProjectAssetFileOperationResponse> {
  try {
    assertAuthority?.();
    const safe = safeAssetRelativePath(projectFilePath, projectRelativePath);
    if (!safe || !safe.relative.startsWith('assets/'))
      throw new Error('Only unregistered files inside assets/ can be organized.');
    if (referencedAssetPaths(project).has(safe.relative))
      throw new Error('Registered or attached Project files cannot be moved from discovery.');
    const sourceStat = await fs.lstat(safe.absolute);
    if (!sourceStat.isFile()) throw new Error('Source must be a regular file.');
    const kind = inferAssetKindFromExtension(path.extname(safe.relative).toLowerCase());
    const folder = correctFolder(kind);
    if (action === 'support' && MEDIA_KINDS.has(kind))
      throw new Error('Move to Support is for nonmedia files.');
    if (action === 'correct-folder') {
      if (
        !folder ||
        !isRecognizedMedia(
          path.extname(safe.relative).toLowerCase(),
          await readMediaHeader(safe.absolute),
        )
      )
        throw new Error('Only recognized media can be moved to the matching Asset folder.');
    }
    const destinationRelativePath = slashPath(
      path.posix.join(
        action === 'support' ? 'support' : `assets/${folder}`,
        path.posix.basename(safe.relative),
      ),
    );
    if (safe.relative === destinationRelativePath)
      throw new Error('File is already in its suggested folder.');
    const rootReal = await fs.realpath(safe.projectRoot);
    const sourceReal = await fs.realpath(safe.absolute);
    if (!sourceReal.startsWith(`${rootReal}${path.sep}`))
      throw new Error('Source resolves outside the Project.');
    const destinationSafe = safeProjectRelativePath(projectFilePath, destinationRelativePath);
    if (!destinationSafe) throw new Error('Destination escapes the Project.');
    // Check existing ancestors, including symlinked folders, before the transactional move.
    let ancestor = path.dirname(destinationSafe.absolute);
    while (ancestor !== safe.projectRoot && ancestor !== path.dirname(ancestor)) {
      try {
        const real = await fs.realpath(ancestor);
        if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`))
          throw new Error('Destination folder resolves outside the Project.');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        ancestor = path.dirname(ancestor);
      }
    }
    assertAuthority?.();
    await moveProjectAssetFileTransaction(
      safe.projectRoot,
      safe.relative,
      destinationRelativePath,
      'organize untracked asset',
      PROJECT_WORKSPACE_ABSENT_REVISION,
    );
    return { ok: true, success: true, diagnostics: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not move untracked file.';
    return {
      ok: false,
      success: false,
      diagnostics: [diagnostic(projectRelativePath, message)],
      error: message,
    };
  }
}

export async function trashProjectAssetFiles(
  projectFilePath: string,
  projectRelativePaths: string[],
  assertAuthority?: () => void,
): Promise<ProjectAssetFileOperationResponse> {
  const moved: NonNullable<ProjectAssetFileOperationResponse['moved']> = [];
  const diagnostics: ProjectAssetFileOperationResponse['diagnostics'] = [];
  for (const relativePath of projectRelativePaths) {
    try {
      assertAuthority?.();
      moved.push(await moveAssetToTrash(projectFilePath, relativePath, assertAuthority));
    } catch (error) {
      diagnostics.push(
        diagnostic(
          relativePath,
          error instanceof Error ? error.message : 'Failed to move asset to project trash.',
        ),
      );
    }
  }
  return {
    ok: diagnostics.every((item) => item.severity !== 'error'),
    success: moved.length > 0,
    moved,
    diagnostics,
    error: diagnostics.find((item) => item.severity === 'error')?.message,
  };
}

export async function restoreProjectAssetFiles(
  projectFilePath: string,
  moves: ProjectAssetTrashMove[],
  assertAuthority?: () => void,
): Promise<ProjectAssetFileOperationResponse> {
  const projectRoot = projectRootFromFile(projectFilePath);
  const restored: ProjectAssetTrashMove[] = [];
  const diagnostics: ProjectAssetFileOperationResponse['diagnostics'] = [];
  for (const move of moves) {
    try {
      assertAuthority?.();
      const sourceSafe = safeProjectRelativePath(projectFilePath, move.trashRelativePath);
      const targetSafe = safeAssetRelativePath(projectFilePath, move.projectRelativePath);
      if (!sourceSafe || !targetSafe) throw new Error('Restore path escapes the project.');
      try {
        await fs.access(targetSafe.absolute);
        throw new Error(
          'Cannot restore trashed asset because the original asset path is occupied.',
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      assertAuthority?.();
      await moveProjectAssetFileTransaction(
        projectRoot,
        move.trashRelativePath,
        targetSafe.relative,
        'asset restore',
        PROJECT_WORKSPACE_ABSENT_REVISION,
      );
      restored.push(move);
    } catch (error) {
      diagnostics.push(
        diagnostic(
          move.projectRelativePath,
          error instanceof Error ? error.message : 'Failed to restore project asset file.',
        ),
      );
    }
  }
  return {
    ok: diagnostics.every((item) => item.severity !== 'error'),
    success: restored.length > 0,
    restored,
    diagnostics,
    error: diagnostics.find((item) => item.severity === 'error')?.message,
  };
}

export async function purgeProjectTrash(
  projectFilePath: string | null | undefined,
  assertAuthority?: () => void,
): Promise<ProjectAssetFileOperationResponse> {
  if (!projectFilePath) return { ok: true, success: true, diagnostics: [] };
  assertAuthority?.();
  const trashRoot = path.join(projectRootFromFile(projectFilePath), '.noveltea', 'trash');
  try {
    await fs.rm(trashRoot, { recursive: true, force: true });
    return { ok: true, success: true, diagnostics: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to purge project trash.';
    return {
      ok: false,
      success: false,
      diagnostics: [diagnostic('.noveltea/trash', message)],
      error: message,
    };
  }
}

// Project filesystem watching is owned by project-workspace-watcher-service.ts.
