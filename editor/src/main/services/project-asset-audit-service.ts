import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { ImportedAssetMetadata } from '../../shared/asset-import';
import type {
  ProjectAssetAuditResponse,
  ProjectAssetFileOperationResponse,
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
function isImageMime(mimeType?: string) {
  return !!mimeType && mimeType.startsWith('image/');
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

async function isFileStable(absolutePath: string) {
  const first = await fs.stat(absolutePath);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const second = await fs.stat(absolutePath);
  return first.size === second.size && first.mtimeMs === second.mtimeMs;
}

async function inspectUntrackedAssetFile(
  projectRoot: string,
  absolutePath: string,
): Promise<ProjectAssetAuditResponse['untrackedFiles'][number]> {
  const relative = slashPath(path.relative(projectRoot, absolutePath));
  const stat = await fs.stat(absolutePath);
  const extension = path.extname(absolutePath).toLowerCase();
  const mimeType = mimeForExtension(extension);
  let previewUrl: string | undefined;
  if (isImageMime(mimeType) && stat.size <= 15 * 1024 * 1024) {
    const bytes = await fs.readFile(absolutePath);
    previewUrl = `data:${mimeType};base64,${bytes.toString('base64')}`;
  }
  return {
    projectRelativePath: relative,
    absolutePath,
    kind: inferAssetKindFromExtension(extension),
    extension,
    mimeType,
    byteSize: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    previewUrl,
  };
}

function referencedAssetPaths(project: unknown) {
  const paths = new Set<string>();
  if (!isAuthoringProject(project)) return paths;
  for (const record of Object.values(project.assets)) {
    const data = parseAssetData(record.data);
    if (data?.source.path) paths.add(data.source.path);
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
    const inspected = await Promise.all(
      candidates.map(async ({ absolutePath, relative }) => {
        try {
          if (!(await isFileStable(absolutePath))) return { relative, unstable: true as const };
          return { file: await inspectUntrackedAssetFile(projectRoot, absolutePath) };
        } catch (error) {
          return { relative, error };
        }
      }),
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
