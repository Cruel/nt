import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import chokidar, { type FSWatcher } from 'chokidar';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { ProjectAssetFileOperationResponse } from '../../shared/project-asset-audit';
import type { ProjectWorkspaceWatchEvent } from '../../shared/project-workspace-watch';
import { createNodeProjectWorkspaceService } from '../../shared/project-workspace/node-project-workspace-service';
import { assetSourcePaths } from '../../shared/project-workspace/project-workspace-service';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';

export const PROJECT_WORKSPACE_WATCH_STABILITY_THRESHOLD_MS = 200;
export const PROJECT_WORKSPACE_WATCH_POLL_INTERVAL_MS = 50;
export const PROJECT_WORKSPACE_WATCH_QUIET_PERIOD_MS = 150;

interface ActiveWatcher {
  projectSessionId: string;
  projectRoot: string;
  watcher: FSWatcher;
  timer: NodeJS.Timeout | null;
  authoringChangedPaths: Set<string>;
  assetChangedPaths: Set<string>;
  assetSourcePaths: Set<string>;
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

export type ProjectWorkspaceWatchPathRoute = 'authoring' | 'asset' | 'transaction' | 'ignore';

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
  return isTemporaryPath(relative);
}

export function classifyProjectWorkspaceWatchPath(
  projectRoot: string,
  filePath: string,
  knownAssetSourcePaths: ReadonlySet<string> = new Set(),
): ProjectWorkspaceWatchPathRoute {
  const relative = projectRelative(projectRoot, filePath);
  if (shouldIgnoreProjectWorkspaceWatchPath(projectRoot, filePath)) return 'ignore';
  if (!relative || relative === '.') return 'authoring';
  if (isTransactionObservationPath(relative)) return 'transaction';
  const isKnownAssetSource = [...knownAssetSourcePaths].some(
    (assetPath) => relative === assetPath || assetPath.startsWith(`${relative}/`),
  );
  if (relative === 'assets' || relative.startsWith('assets/') || isKnownAssetSource) return 'asset';
  if (
    ['project.json', 'properties.json', 'localization.json', 'editor.json'].includes(relative) ||
    relative === 'records' ||
    relative.startsWith('records/') ||
    relative === 'scripts' ||
    relative.startsWith('scripts/')
  )
    return 'authoring';
  return 'ignore';
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

interface AssembledWatchCandidate {
  readonly candidate: ProjectWorkspaceWatchEvent['candidate'];
  readonly project: AuthoringProject | null;
}

async function assembleCandidate(projectRoot: string): Promise<AssembledWatchCandidate> {
  const opened = await createNodeProjectWorkspaceService().open(projectRoot);
  if (!opened.ok)
    return {
      candidate: {
        success: false,
        diagnostics: opened.diagnostics,
      },
      project: null,
    };
  return {
    candidate: {
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
    },
    project: opened.snapshot.project,
  };
}

export function refreshProjectWorkspaceWatchAssetSourcePaths(
  target: Set<string>,
  project: AuthoringProject,
): void {
  target.clear();
  assetSourcePaths(project).forEach((assetPath) => target.add(assetPath));
}

async function flushWatcher(
  owner: BrowserWindow,
  watcher: ActiveWatcher,
  isSessionCurrent: (projectSessionId: string) => boolean,
  refreshSession: (
    projectSessionId: string,
    projectFilePath: string,
    project?: AuthoringProject,
  ) => Promise<void>,
) {
  if (activeWatcher !== watcher || !isSessionCurrent(watcher.projectSessionId)) return;
  watcher.timer = null;
  // Opening a workspace performs transaction recovery. Never invoke it while another NovelTea
  // writer still owns the project; the journal/lock watcher will schedule the committed state.
  if (await hasActiveNovelTeaWriter(watcher.projectRoot)) return;
  const authoringChangedPaths = [...watcher.authoringChangedPaths].sort();
  const assetChangedPaths = [...watcher.assetChangedPaths].sort();
  if (authoringChangedPaths.length === 0 && assetChangedPaths.length === 0) return;
  watcher.authoringChangedPaths.clear();
  watcher.assetChangedPaths.clear();
  const changedPaths = [...new Set([...authoringChangedPaths, ...assetChangedPaths])].sort();
  const manifestPath = path.join(watcher.projectRoot, 'project.json');
  const assembled = await assembleCandidate(watcher.projectRoot);
  const candidate = assembled.candidate;
  if (candidate.success) {
    try {
      await refreshSession(watcher.projectSessionId, manifestPath, assembled.project ?? undefined);
    } catch {
      return;
    }
  }
  if (assembled.project)
    refreshProjectWorkspaceWatchAssetSourcePaths(watcher.assetSourcePaths, assembled.project);
  if (
    activeWatcher !== watcher ||
    !isSessionCurrent(watcher.projectSessionId) ||
    owner.isDestroyed()
  )
    return;
  owner.webContents.send(IPC_CHANNELS.PROJECT_WORKSPACE_WATCH_EVENT, {
    projectSessionId: watcher.projectSessionId,
    changedPaths,
    authoringChangedPaths,
    assetChangedPaths,
    candidate,
  } satisfies ProjectWorkspaceWatchEvent);
}

function scheduleWatcher(
  owner: BrowserWindow,
  watcher: ActiveWatcher,
  filePath: string,
  isSessionCurrent: (projectSessionId: string) => boolean,
  refreshSession: (
    projectSessionId: string,
    projectFilePath: string,
    project?: AuthoringProject,
  ) => Promise<void>,
) {
  if (activeWatcher !== watcher || !isSessionCurrent(watcher.projectSessionId)) return;
  const relative = projectRelative(watcher.projectRoot, filePath);
  const route = classifyProjectWorkspaceWatchPath(
    watcher.projectRoot,
    filePath,
    watcher.assetSourcePaths,
  );
  if (route === 'ignore') return;
  if (route === 'authoring') watcher.authoringChangedPaths.add(relative);
  else if (route === 'asset') watcher.assetChangedPaths.add(relative);
  watcher.timer = scheduleProjectWorkspaceQuietFlush(
    watcher.timer,
    () => void flushWatcher(owner, watcher, isSessionCurrent, refreshSession),
  );
}

export async function startProjectWorkspaceWatcher(
  owner: BrowserWindow | null,
  projectSessionId: string,
  projectRootValue: string,
  isSessionCurrent: (projectSessionId: string) => boolean,
  refreshSession: (
    projectSessionId: string,
    projectFilePath: string,
    project?: AuthoringProject,
  ) => Promise<void>,
): Promise<ProjectAssetFileOperationResponse> {
  if (!owner || !projectSessionId || !projectRootValue || !isSessionCurrent(projectSessionId))
    return staleWatcherResponse();

  await stopProjectWorkspaceWatcher();
  if (!isSessionCurrent(projectSessionId)) return staleWatcherResponse();
  const projectRoot = path.resolve(projectRootValue);
  const transactionsRoot = path.join(projectRoot, '.noveltea', 'transactions');
  await fs.mkdir(transactionsRoot, { recursive: true });
  if (!isSessionCurrent(projectSessionId)) return staleWatcherResponse();
  const opened = await createNodeProjectWorkspaceService().open(projectRoot);
  if (!isSessionCurrent(projectSessionId)) return staleWatcherResponse();
  const knownAssetSourcePaths = new Set(opened.ok ? assetSourcePaths(opened.snapshot.project) : []);
  const watcher = chokidar.watch(projectRoot, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: PROJECT_WORKSPACE_WATCH_STABILITY_THRESHOLD_MS,
      pollInterval: PROJECT_WORKSPACE_WATCH_POLL_INTERVAL_MS,
    },
    atomic: true,
    ignored: (filePath) => shouldIgnoreProjectWorkspaceWatchPath(projectRoot, filePath),
  });
  const state: ActiveWatcher = {
    projectSessionId,
    projectRoot,
    watcher,
    timer: null,
    authoringChangedPaths: new Set(),
    assetChangedPaths: new Set(),
    assetSourcePaths: knownAssetSourcePaths,
  };
  const schedule = (filePath: string) =>
    scheduleWatcher(owner, state, filePath, isSessionCurrent, refreshSession);
  watcher.on('add', schedule);
  watcher.on('change', schedule);
  watcher.on('unlink', schedule);
  watcher.on('addDir', schedule);
  watcher.on('unlinkDir', schedule);
  activeWatcher = state;
  return { ok: true, success: true, diagnostics: [] };
}

export async function stopProjectWorkspaceWatcher(
  projectSessionId?: string,
): Promise<ProjectAssetFileOperationResponse> {
  if (!activeWatcher) return { ok: true, success: true, diagnostics: [] };
  if (projectSessionId && activeWatcher.projectSessionId !== projectSessionId)
    return staleWatcherResponse();
  const watcher = activeWatcher;
  activeWatcher = null;
  if (watcher.timer) clearTimeout(watcher.timer);
  await watcher.watcher.close();
  return { ok: true, success: true, diagnostics: [] };
}

function staleWatcherResponse(): ProjectAssetFileOperationResponse {
  const message = 'Project session is stale or unknown.';
  return {
    ok: false,
    success: false,
    diagnostics: [{ severity: 'error', path: '/project.json', message }],
    error: message,
  };
}
