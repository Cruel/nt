import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import chokidar, { type FSWatcher } from 'chokidar';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { ProjectAssetFileOperationResponse } from '../../shared/project-asset-audit';
import type { ProjectWorkspaceWatchEvent } from '../../shared/project-workspace-watch';
import { createNodeProjectWorkspaceService } from '../../shared/project-workspace/node-project-workspace-service';

export const PROJECT_WORKSPACE_WATCH_STABILITY_THRESHOLD_MS = 2000;
export const PROJECT_WORKSPACE_WATCH_POLL_INTERVAL_MS = 250;
export const PROJECT_WORKSPACE_WATCH_QUIET_PERIOD_MS = 1000;

interface ActiveWatcher {
  projectRoot: string;
  watcher: FSWatcher;
  timer: NodeJS.Timeout | null;
  changedPaths: Set<string>;
  assetAuditChanged: boolean;
}

let activeWatcher: ActiveWatcher | null = null;

function slashPath(value: string): string {
  return value.split(path.sep).join('/');
}

function projectRelative(projectRoot: string, filePath: string): string {
  return slashPath(path.relative(projectRoot, filePath));
}

function isTransactionObservationPath(relative: string): boolean {
  if (relative === '.noveltea' || relative === '.noveltea/transactions') return true;
  if (!relative.startsWith('.noveltea/transactions/')) return false;
  const segments = relative.split('/');
  if (segments[2] === '.writer-lock') return segments.length <= 4;
  return segments.length === 3 || (segments.length === 4 && segments[3] === 'manifest.json');
}

function isTemporaryPath(relative: string): boolean {
  const base = path.posix.basename(relative);
  if (base === '.DS_Store' || base === 'Thumbs.db') return true;
  if (base.startsWith('.~') || base.startsWith('~')) return true;
  return /(?:\.tmp|\.temp|\.swp|\.swo|\.bak)$/i.test(base);
}

export function shouldIgnoreProjectWorkspaceWatchPath(
  projectRoot: string,
  filePath: string,
): boolean {
  const relative = projectRelative(projectRoot, filePath);
  if (!relative || relative === '.') return false;
  if (isTransactionObservationPath(relative)) return false;
  if (relative === '.noveltea' || relative.startsWith('.noveltea/')) return true;
  if (relative === 'workflows' || relative.startsWith('workflows/')) return true;
  const first = relative.split('/')[0];
  if (
    ['.git', 'node_modules', 'dist', 'dist-electron', 'out', 'build', 'generated'].includes(first)
  )
    return true;
  if (isTemporaryPath(relative)) return true;
  return false;
}

export function scheduleProjectWorkspaceQuietFlush(
  timer: NodeJS.Timeout | null,
  callback: () => void,
): NodeJS.Timeout {
  if (timer) clearTimeout(timer);
  return setTimeout(callback, PROJECT_WORKSPACE_WATCH_QUIET_PERIOD_MS);
}

async function hasActiveNovelTeaWriter(projectRoot: string): Promise<boolean> {
  const transactionsRoot = path.join(projectRoot, '.noveltea', 'transactions');
  try {
    await fs.access(path.join(transactionsRoot, '.writer-lock'));
    return true;
  } catch {
    return false;
  }
}

async function assembleCandidate(
  projectRoot: string,
): Promise<ProjectWorkspaceWatchEvent['candidate']> {
  const opened = await createNodeProjectWorkspaceService().open(projectRoot);
  if (!opened.ok)
    return {
      success: false,
      diagnostics: opened.diagnostics,
    };
  return {
    success: true,
    diagnostics: opened.diagnostics,
    contentProject: opened.contentProject,
    savedContentProject: opened.savedContentProject,
    editorState: opened.editorState,
    workspaceRevision: opened.snapshot.workspaceRevision,
    fileRevisions: Object.fromEntries(
      Object.entries(opened.snapshot.fileRevisions).map(([file, revision]) => [
        file,
        revision.contentHash,
      ]),
    ),
    scriptSourcePaths: { ...opened.snapshot.scriptSourcePaths },
  };
}

async function flushWatcher(owner: BrowserWindow, watcher: ActiveWatcher) {
  if (activeWatcher !== watcher) return;
  watcher.timer = null;
  // Opening a workspace performs transaction recovery. Never invoke it while another NovelTea
  // writer still owns the project; the journal/lock watcher will schedule the committed state.
  if (await hasActiveNovelTeaWriter(watcher.projectRoot)) return;
  const changedPaths = [...watcher.changedPaths].sort();
  const assetAuditChanged = watcher.assetAuditChanged;
  if (changedPaths.length === 0 && !assetAuditChanged) return;
  watcher.changedPaths.clear();
  watcher.assetAuditChanged = false;
  const manifestPath = path.join(watcher.projectRoot, 'project.json');
  const candidate = await assembleCandidate(watcher.projectRoot);
  if (activeWatcher !== watcher || owner.isDestroyed()) return;
  owner.webContents.send(IPC_CHANNELS.PROJECT_WORKSPACE_WATCH_EVENT, {
    projectRoot: watcher.projectRoot,
    manifestPath,
    changedPaths,
    assetAuditChanged,
    candidate,
  } satisfies ProjectWorkspaceWatchEvent);
}

function scheduleWatcher(owner: BrowserWindow, watcher: ActiveWatcher, filePath: string) {
  if (activeWatcher !== watcher) return;
  const relative = projectRelative(watcher.projectRoot, filePath);
  if (!relative.startsWith('.noveltea/transactions/')) {
    watcher.changedPaths.add(relative);
    if (relative === 'assets' || relative.startsWith('assets/')) watcher.assetAuditChanged = true;
  }
  watcher.timer = scheduleProjectWorkspaceQuietFlush(
    watcher.timer,
    () => void flushWatcher(owner, watcher),
  );
}

export async function startProjectWorkspaceWatcher(
  owner: BrowserWindow | null,
  projectRootValue: string,
): Promise<ProjectAssetFileOperationResponse> {
  await stopProjectWorkspaceWatcher();
  if (!owner || !projectRootValue) {
    const message = 'No project window or project root is available.';
    return {
      ok: false,
      success: false,
      diagnostics: [{ severity: 'error', path: '/project.json', message }],
      error: message,
    };
  }
  const projectRoot = path.resolve(projectRootValue);
  const transactionsRoot = path.join(projectRoot, '.noveltea', 'transactions');
  await fs.mkdir(transactionsRoot, { recursive: true });
  const watcher = chokidar.watch([projectRoot, transactionsRoot], {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: PROJECT_WORKSPACE_WATCH_STABILITY_THRESHOLD_MS,
      pollInterval: PROJECT_WORKSPACE_WATCH_POLL_INTERVAL_MS,
    },
    atomic: true,
    ignored: (filePath) => shouldIgnoreProjectWorkspaceWatchPath(projectRoot, filePath),
  });
  const state: ActiveWatcher = {
    projectRoot,
    watcher,
    timer: null,
    changedPaths: new Set(),
    assetAuditChanged: false,
  };
  const schedule = (filePath: string) => scheduleWatcher(owner, state, filePath);
  watcher.on('add', schedule);
  watcher.on('change', schedule);
  watcher.on('unlink', schedule);
  watcher.on('addDir', schedule);
  watcher.on('unlinkDir', schedule);
  activeWatcher = state;
  return { ok: true, success: true, diagnostics: [] };
}

export async function stopProjectWorkspaceWatcher(): Promise<ProjectAssetFileOperationResponse> {
  if (!activeWatcher) return { ok: true, success: true, diagnostics: [] };
  const watcher = activeWatcher;
  activeWatcher = null;
  if (watcher.timer) clearTimeout(watcher.timer);
  await watcher.watcher.close();
  return { ok: true, success: true, diagnostics: [] };
}
