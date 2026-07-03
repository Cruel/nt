import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import chokidar, { type FSWatcher } from 'chokidar';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { ImportedAssetMetadata } from '../../shared/asset-import';
import type { ProjectAssetAuditResponse, ProjectAssetFileOperationResponse, ProjectAssetTrashMove } from '../../shared/project-asset-audit';
import { assetDataFromImportMetadata, inferAssetKindFromExtension, parseAssetData } from '../../shared/project-schema/authoring-assets';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';

interface ActiveWatcher {
  projectFilePath: string;
  watcher: FSWatcher;
  timer: NodeJS.Timeout | null;
}

let activeWatcher: ActiveWatcher | null = null;

function projectRootFromFile(projectFilePath: string): string {
  return path.dirname(path.resolve(projectFilePath));
}

function slashPath(value: string): string {
  return value.split(path.sep).join('/');
}

function diagnostic(pathValue: string | undefined, message: string, severity: 'error' | 'warning' | 'info' = 'error') {
  return { severity, path: pathValue, message };
}

function mimeForExtension(extension: string): string | undefined {
  switch (extension.toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.svg': return 'image/svg+xml';
    case '.ttf': return 'font/ttf';
    case '.otf': return 'font/otf';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.mp3': return 'audio/mpeg';
    case '.ogg': return 'audio/ogg';
    case '.wav': return 'audio/wav';
    case '.lua': return 'text/x-lua';
    case '.json': return 'application/json';
    case '.txt': return 'text/plain';
    default: return undefined;
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
      files.push(...await walkFiles(absolute));
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

async function inspectUntrackedAssetFile(projectRoot: string, absolutePath: string): Promise<ProjectAssetAuditResponse['untrackedFiles'][number]> {
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

async function metadataForExistingAsset(projectFilePath: string, projectRelativePath: string): Promise<ImportedAssetMetadata> {
  const safe = safeAssetRelativePath(projectFilePath, projectRelativePath);
  if (!safe) throw new Error('Asset path is not inside the project assets directory.');
  const bytes = await fs.readFile(safe.absolute);
  const extension = path.extname(safe.absolute).toLowerCase();
  const kind = inferAssetKindFromExtension(extension);
  return {
    originalPath: safe.absolute,
    originalName: path.basename(safe.absolute),
    projectRelativePath: safe.relative,
    kind,
    extension,
    mimeType: mimeForExtension(extension),
    byteSize: bytes.byteLength,
    contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    importedAt: new Date().toISOString(),
  };
}

async function trashPathFor(projectFilePath: string, projectRelativePath: string) {
  const projectRoot = projectRootFromFile(projectFilePath);
  const operationId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2)}`;
  const trashRelativePath = slashPath(path.join('.noveltea', 'trash', 'assets', operationId, projectRelativePath));
  const absolute = path.resolve(projectRoot, trashRelativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  return { trashRelativePath, absolute };
}

async function moveAssetToTrash(projectFilePath: string, projectRelativePath: string) {
  const safe = safeAssetRelativePath(projectFilePath, projectRelativePath);
  if (!safe) throw new Error('Only files inside assets/ can be moved to project trash.');
  const destination = await trashPathFor(projectFilePath, safe.relative);
  await fs.rename(safe.absolute, destination.absolute);
  return { projectRelativePath: safe.relative, trashRelativePath: destination.trashRelativePath };
}

export async function auditProjectAssets(projectFilePath: string, project: unknown): Promise<ProjectAssetAuditResponse> {
  if (!projectFilePath) return { ok: false, success: false, untrackedFiles: [], skippedUnstableFiles: [], diagnostics: [diagnostic('/assets', 'Asset audit requires a saved project file.')], error: 'Project file path is required.' };
  const projectRoot = projectRootFromFile(projectFilePath);
  const assetsRoot = path.join(projectRoot, 'assets');
  const referenced = referencedAssetPaths(project);
  const untrackedFiles: ProjectAssetAuditResponse['untrackedFiles'] = [];
  const skippedUnstableFiles: string[] = [];
  const diagnostics: ProjectAssetAuditResponse['diagnostics'] = [];
  try {
    const files = await walkFiles(assetsRoot);
    const candidates = files
      .map((absolutePath) => ({ absolutePath, relative: slashPath(path.relative(projectRoot, absolutePath)) }))
      .filter((file) => !referenced.has(file.relative));
    const inspected = await Promise.all(candidates.map(async ({ absolutePath, relative }) => {
      try {
        if (!await isFileStable(absolutePath)) return { relative, unstable: true as const };
        return { file: await inspectUntrackedAssetFile(projectRoot, absolutePath) };
      } catch (error) {
        return { relative, error };
      }
    }));
    for (const result of inspected) {
      if ('file' in result && result.file) untrackedFiles.push(result.file);
      else if ('unstable' in result) skippedUnstableFiles.push(result.relative);
      else diagnostics.push(diagnostic(result.relative, result.error instanceof Error ? result.error.message : 'Failed to inspect asset file.', 'warning'));
    }
    untrackedFiles.sort((left, right) => left.projectRelativePath.localeCompare(right.projectRelativePath));
    return { ok: diagnostics.every((item) => item.severity !== 'error'), success: true, projectFilePath, untrackedFiles, skippedUnstableFiles, diagnostics };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Asset audit failed.';
    return { ok: false, success: false, projectFilePath, untrackedFiles: [], skippedUnstableFiles, diagnostics: [diagnostic('/assets', message)], error: message };
  }
}

export async function importUntrackedProjectAssets(projectFilePath: string, projectRelativePaths: string[]): Promise<ProjectAssetFileOperationResponse> {
  const assets: ImportedAssetMetadata[] = [];
  const diagnostics: ProjectAssetFileOperationResponse['diagnostics'] = [];
  for (const relativePath of projectRelativePaths) {
    try {
      assets.push(await metadataForExistingAsset(projectFilePath, relativePath));
    } catch (error) {
      diagnostics.push(diagnostic(relativePath, error instanceof Error ? error.message : 'Failed to import untracked asset.'));
    }
  }
  return { ok: diagnostics.every((item) => item.severity !== 'error'), success: assets.length > 0, assets, diagnostics, error: diagnostics.find((item) => item.severity === 'error')?.message };
}

export async function trashProjectAssetFiles(projectFilePath: string, projectRelativePaths: string[]): Promise<ProjectAssetFileOperationResponse> {
  const moved: NonNullable<ProjectAssetFileOperationResponse['moved']> = [];
  const diagnostics: ProjectAssetFileOperationResponse['diagnostics'] = [];
  for (const relativePath of projectRelativePaths) {
    try {
      moved.push(await moveAssetToTrash(projectFilePath, relativePath));
    } catch (error) {
      diagnostics.push(diagnostic(relativePath, error instanceof Error ? error.message : 'Failed to move asset to project trash.'));
    }
  }
  return { ok: diagnostics.every((item) => item.severity !== 'error'), success: moved.length > 0, moved, diagnostics, error: diagnostics.find((item) => item.severity === 'error')?.message };
}

export async function restoreProjectAssetFiles(projectFilePath: string, moves: ProjectAssetTrashMove[]): Promise<ProjectAssetFileOperationResponse> {
  const projectRoot = projectRootFromFile(projectFilePath);
  const restored: ProjectAssetTrashMove[] = [];
  const diagnostics: ProjectAssetFileOperationResponse['diagnostics'] = [];
  for (const move of moves) {
    try {
      const sourceSafe = safeProjectRelativePath(projectFilePath, move.trashRelativePath);
      const targetSafe = safeAssetRelativePath(projectFilePath, move.projectRelativePath);
      if (!sourceSafe || !targetSafe) throw new Error('Restore path escapes the project.');
      try {
        await fs.access(targetSafe.absolute);
        throw new Error('Cannot restore trashed asset because the original asset path is occupied.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await fs.mkdir(path.dirname(targetSafe.absolute), { recursive: true });
      await fs.rename(path.resolve(projectRoot, move.trashRelativePath), targetSafe.absolute);
      restored.push(move);
    } catch (error) {
      diagnostics.push(diagnostic(move.projectRelativePath, error instanceof Error ? error.message : 'Failed to restore project asset file.'));
    }
  }
  return { ok: diagnostics.every((item) => item.severity !== 'error'), success: restored.length > 0, restored, diagnostics, error: diagnostics.find((item) => item.severity === 'error')?.message };
}

export async function purgeProjectTrash(projectFilePath: string | null | undefined): Promise<ProjectAssetFileOperationResponse> {
  if (!projectFilePath) return { ok: true, success: true, diagnostics: [] };
  const trashRoot = path.join(projectRootFromFile(projectFilePath), '.noveltea', 'trash');
  try {
    await fs.rm(trashRoot, { recursive: true, force: true });
    return { ok: true, success: true, diagnostics: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to purge project trash.';
    return { ok: false, success: false, diagnostics: [diagnostic('.noveltea/trash', message)], error: message };
  }
}

export async function startProjectAssetWatcher(owner: BrowserWindow | null, projectFilePath: string): Promise<ProjectAssetFileOperationResponse> {
  await stopProjectAssetWatcher();
  if (!owner || !projectFilePath) return { ok: false, success: false, diagnostics: [diagnostic('/assets', 'No project window or project file path is available.')], error: 'No project window or project file path is available.' };
  const projectRoot = projectRootFromFile(projectFilePath);
  const assetsRoot = path.join(projectRoot, 'assets');
  await fs.mkdir(assetsRoot, { recursive: true });
  const schedule = () => {
    if (!activeWatcher || activeWatcher.projectFilePath !== projectFilePath) return;
    if (activeWatcher.timer) clearTimeout(activeWatcher.timer);
    activeWatcher.timer = setTimeout(() => {
      if (!owner.isDestroyed()) owner.webContents.send(IPC_CHANNELS.PROJECT_ASSET_AUDIT_EVENT, { projectFilePath, reason: 'watcher' });
    }, 1000);
  };
  const watcher = chokidar.watch(assetsRoot, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 250 },
    atomic: true,
    ignored: (filePath) => {
      const relative = slashPath(path.relative(projectRoot, filePath));
      return relative.startsWith('.noveltea/') || isTemporaryOrHiddenAssetPath(filePath);
    },
  });
  watcher.on('add', schedule);
  watcher.on('change', schedule);
  watcher.on('unlink', schedule);
  watcher.on('addDir', schedule);
  watcher.on('unlinkDir', schedule);
  activeWatcher = { projectFilePath, watcher, timer: null };
  return { ok: true, success: true, diagnostics: [] };
}

export async function stopProjectAssetWatcher(): Promise<ProjectAssetFileOperationResponse> {
  if (!activeWatcher) return { ok: true, success: true, diagnostics: [] };
  const watcher = activeWatcher;
  activeWatcher = null;
  if (watcher.timer) clearTimeout(watcher.timer);
  await watcher.watcher.close();
  return { ok: true, success: true, diagnostics: [] };
}
