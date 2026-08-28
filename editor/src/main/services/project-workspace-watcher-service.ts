import { promises as fs } from 'node:fs';
import path from 'node:path';
import { powerMonitor, type BrowserWindow } from 'electron';
import chokidar, { type FSWatcher } from 'chokidar';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import type { ProjectAssetFileOperationResponse } from '../../shared/project-asset-audit';
import type { ProjectMutationPathValue } from '../../shared/editor-tooling';
import type { ProjectWorkspaceWatchEvent } from '../../shared/project-workspace-watch';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { stripLocalEditorProjectState } from '../../shared/project-schema/editor-project-state';
import type { ProjectValidationDiagnostic } from '../../shared/project-schema/project-validation';
import { assetSourcePaths } from '../../shared/project-workspace/project-workspace-service';
import { buildJsonPointer } from '../../shared/json-pointer';
import type { ActiveProjectWorkspaceSession } from './active-project-workspace-session';

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
  transactionObserved: boolean;
  assetSourcePaths: Set<string>;
  workspaceSession: ActiveProjectWorkspaceSession;
  resumeHandler: () => void;
  automaticRetryUsed: boolean;
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
    ['project.json', 'traits.json', 'localization.json', 'editor.json'].includes(relative) ||
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

export function refreshProjectWorkspaceWatchAssetSourcePaths(
  target: Set<string>,
  project: AuthoringProject,
): void {
  target.clear();
  assetSourcePaths(project).forEach((assetPath) => target.add(assetPath));
}

function appendExternalValues(
  before: unknown,
  after: unknown,
  segments: readonly string[],
  output: Record<string, ProjectMutationPathValue>,
): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const beforeObject = before !== null && typeof before === 'object' && !Array.isArray(before);
  const afterObject = after !== null && typeof after === 'object' && !Array.isArray(after);
  if (beforeObject && afterObject) {
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      const leftHas = Object.prototype.hasOwnProperty.call(left, key);
      const rightHas = Object.prototype.hasOwnProperty.call(right, key);
      const pointer = buildJsonPointer([...segments, key]);
      if (!rightHas) {
        output[pointer] = { exists: false };
        continue;
      }
      if (!leftHas) {
        output[pointer] = { exists: true, value: structuredClone(right[key]) };
        continue;
      }
      appendExternalValues(left[key], right[key], [...segments, key], output);
    }
    return;
  }
  const pointer = buildJsonPointer(segments);
  if (pointer) output[pointer] = { exists: true, value: structuredClone(after) };
}

function externalValues(before: AuthoringProject, after: AuthoringProject) {
  const output: Record<string, ProjectMutationPathValue> = {};
  appendExternalValues(
    stripLocalEditorProjectState(before),
    stripLocalEditorProjectState(after),
    [],
    output,
  );
  return output;
}

export async function filterExternallyChangedAuthoringPaths(
  session: ActiveProjectWorkspaceSession,
  paths: readonly string[],
): Promise<string[]> {
  const external: string[] = [];
  for (const relative of paths) {
    const current = await session.readFreshRevision(relative);
    if (session.requiresAuthoringReassembly(relative, current)) external.push(relative);
  }
  return external;
}

function successfulAuthoringWatchResult(
  before: ReturnType<ActiveProjectWorkspaceSession['snapshot']>,
  after: ReturnType<ActiveProjectWorkspaceSession['snapshot']>,
  changedPaths: readonly string[],
  diagnostics: readonly import('../../shared/project-schema/project-validation').ProjectValidationDiagnostic[],
): Extract<NonNullable<ProjectWorkspaceWatchEvent['authoring']>, { success: true }> {
  const values = externalValues(before.project, after.project);
  const involvedFiles = new Set(
    changedPaths.filter(
      (file) =>
        before.canonicalSourceFiles.includes(file) || after.canonicalSourceFiles.includes(file),
    ),
  );
  return {
    success: true,
    diagnostics,
    affectedPaths: Object.keys(values).sort(),
    externalValueByPath: values,
    fileRevisions: Object.fromEntries(
      [...involvedFiles]
        .sort()
        .map((file) => [file, after.fileRevisions[file]?.contentHash ?? 'absent']),
    ),
    scriptSourcePaths: { ...after.scriptSourcePaths },
  };
}

function scheduleAutomaticWatcherRetry(
  owner: BrowserWindow,
  watcher: ActiveWatcher,
  isSessionCurrent: (projectSessionId: string) => boolean,
  refreshSession: (
    projectSessionId: string,
    projectFilePath: string,
    project?: AuthoringProject,
  ) => Promise<void>,
): void {
  if (
    watcher.automaticRetryUsed ||
    activeWatcher !== watcher ||
    !isSessionCurrent(watcher.projectSessionId)
  )
    return;
  watcher.automaticRetryUsed = true;
  watcher.timer = scheduleProjectWorkspaceQuietFlush(watcher.timer, () =>
    invokeWatcherFlush(owner, watcher, isSessionCurrent, refreshSession),
  );
}

function invokeWatcherFlush(
  owner: BrowserWindow,
  watcher: ActiveWatcher,
  isSessionCurrent: (projectSessionId: string) => boolean,
  refreshSession: (
    projectSessionId: string,
    projectFilePath: string,
    project?: AuthoringProject,
  ) => Promise<void>,
): void {
  void flushWatcher(owner, watcher, isSessionCurrent, refreshSession).catch(() => {
    watcher.workspaceSession.markResyncNeeded();
    scheduleAutomaticWatcherRetry(owner, watcher, isSessionCurrent, refreshSession);
  });
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
  const transactionObserved = watcher.transactionObserved;
  watcher.transactionObserved = false;
  const observedAuthoringChangedPaths = [...watcher.authoringChangedPaths].sort();
  const assetChangedPaths = [...watcher.assetChangedPaths].sort();
  const needsResync = watcher.workspaceSession.coherenceState() === 'resync-needed';
  if (
    observedAuthoringChangedPaths.length === 0 &&
    assetChangedPaths.length === 0 &&
    !needsResync &&
    !transactionObserved
  )
    return;
  watcher.authoringChangedPaths.clear();
  watcher.assetChangedPaths.clear();
  let authoringChangedPaths: string[] = [];
  let authoring: ProjectWorkspaceWatchEvent['authoring'];
  try {
    await watcher.workspaceSession.runExclusive(async () => {
      if (watcher.workspaceSession.coherenceState() === 'resync-needed') {
        const before = watcher.workspaceSession.snapshot();
        const resync = await watcher.workspaceSession.resynchronizeAuthoring();
        authoringChangedPaths = [...resync.changedPaths];
        if (!resync.opened.ok) {
          authoring = { success: false, diagnostics: resync.opened.diagnostics };
          return;
        }
        authoring = successfulAuthoringWatchResult(
          before,
          resync.opened.snapshot,
          authoringChangedPaths,
          resync.opened.diagnostics,
        );
        return;
      }
      if (transactionObserved) {
        const before = watcher.workspaceSession.snapshot();
        const recovery = await watcher.workspaceSession.recoverPendingTransactions();
        if (recovery.recovered) {
          authoringChangedPaths = [...recovery.changedPaths];
          if (recovery.opened && !recovery.opened.ok) {
            authoring = { success: false, diagnostics: recovery.opened.diagnostics };
            return;
          }
          if (recovery.opened?.ok && authoringChangedPaths.length > 0) {
            authoring = successfulAuthoringWatchResult(
              before,
              recovery.opened.snapshot,
              authoringChangedPaths,
              recovery.opened.diagnostics,
            );
            return;
          }
        }
      }
      authoringChangedPaths = await filterExternallyChangedAuthoringPaths(
        watcher.workspaceSession,
        observedAuthoringChangedPaths,
      );
      if (authoringChangedPaths.length === 0) return;
      const before = watcher.workspaceSession.snapshot();
      const opened = await watcher.workspaceSession.reassemble(authoringChangedPaths);
      if (!opened.ok) {
        authoring = { success: false, diagnostics: opened.diagnostics };
        return;
      }
      authoring = successfulAuthoringWatchResult(
        before,
        opened.snapshot,
        authoringChangedPaths,
        opened.diagnostics,
      );
    });
  } catch {
    observedAuthoringChangedPaths.forEach((relativePath) =>
      watcher.authoringChangedPaths.add(relativePath),
    );
    if (transactionObserved) watcher.transactionObserved = true;
    watcher.workspaceSession.markResyncNeeded();
    scheduleAutomaticWatcherRetry(owner, watcher, isSessionCurrent, refreshSession);
    return;
  }
  let assetFileRevisions: Record<string, `sha256:${string}` | 'absent'> | undefined;
  if (assetChangedPaths.length > 0) {
    try {
      assetFileRevisions = await watcher.workspaceSession.runExclusive(() =>
        watcher.workspaceSession.observeAssetRevisions(assetChangedPaths),
      );
    } catch {
      assetChangedPaths.forEach((relativePath) => watcher.assetChangedPaths.add(relativePath));
      scheduleAutomaticWatcherRetry(owner, watcher, isSessionCurrent, refreshSession);
    }
  }
  const publishedAssetChangedPaths = assetFileRevisions ? assetChangedPaths : [];
  const assetDiagnostics: ProjectValidationDiagnostic[] = assetFileRevisions
    ? Object.entries(assetFileRevisions).flatMap(([relativePath, revision]) =>
        revision === 'absent' && watcher.assetSourcePaths.has(relativePath)
          ? [
              {
                code: 'workspace.asset-source.missing',
                severity: 'error' as const,
                category: 'Asset source',
                path: `/${relativePath}`,
                message: `Referenced asset source '${relativePath}' is missing.`,
                boundaries: ['authoring'],
                ownerPaths: [`/${relativePath}`],
              },
            ]
          : [],
      )
    : [];
  if (authoringChangedPaths.length === 0 && publishedAssetChangedPaths.length === 0 && !authoring)
    return;
  const changedPaths = [
    ...new Set([...authoringChangedPaths, ...publishedAssetChangedPaths]),
  ].sort();
  const manifestPath = path.join(watcher.projectRoot, 'project.json');
  const project = authoring?.success ? watcher.workspaceSession.project() : null;
  if (project) {
    try {
      await refreshSession(watcher.projectSessionId, manifestPath, project);
    } catch {
      return;
    }
  }
  if (project) refreshProjectWorkspaceWatchAssetSourcePaths(watcher.assetSourcePaths, project);
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
    assetChangedPaths: publishedAssetChangedPaths,
    ...(assetFileRevisions ? { assetFileRevisions } : {}),
    ...(assetDiagnostics.length > 0 ? { assetDiagnostics } : {}),
    ...(authoring ? { authoring } : {}),
  } satisfies ProjectWorkspaceWatchEvent);
  if (watcher.authoringChangedPaths.size === 0 && watcher.assetChangedPaths.size === 0)
    watcher.automaticRetryUsed = false;
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
  watcher.automaticRetryUsed = false;
  if (route === 'authoring') watcher.authoringChangedPaths.add(relative);
  else if (route === 'asset') watcher.assetChangedPaths.add(relative);
  else if (route === 'transaction') watcher.transactionObserved = true;
  watcher.timer = scheduleProjectWorkspaceQuietFlush(watcher.timer, () =>
    invokeWatcherFlush(owner, watcher, isSessionCurrent, refreshSession),
  );
}

export async function startProjectWorkspaceWatcher(
  owner: BrowserWindow | null,
  projectSessionId: string,
  projectRootValue: string,
  workspaceSession: ActiveProjectWorkspaceSession,
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
  await workspaceSession.captureAuthoringFileStamps();
  const knownAssetSourcePaths = new Set(workspaceSession.knownAssetSourcePaths());
  const watcher = chokidar.watch(projectRoot, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: PROJECT_WORKSPACE_WATCH_STABILITY_THRESHOLD_MS,
      pollInterval: PROJECT_WORKSPACE_WATCH_POLL_INTERVAL_MS,
    },
    atomic: true,
    ignored: (filePath) => shouldIgnoreProjectWorkspaceWatchPath(projectRoot, filePath),
  });
  const state = {} as ActiveWatcher;
  const requestResync = () => {
    if (activeWatcher !== state || !isSessionCurrent(projectSessionId)) return;
    state.automaticRetryUsed = false;
    workspaceSession.markResyncNeeded();
    state.timer = scheduleProjectWorkspaceQuietFlush(state.timer, () =>
      invokeWatcherFlush(owner, state, isSessionCurrent, refreshSession),
    );
  };
  Object.assign(state, {
    projectSessionId,
    projectRoot,
    watcher,
    timer: null,
    authoringChangedPaths: new Set(),
    assetChangedPaths: new Set(),
    transactionObserved: false,
    assetSourcePaths: knownAssetSourcePaths,
    workspaceSession,
    resumeHandler: requestResync,
    automaticRetryUsed: false,
  } satisfies ActiveWatcher);
  const schedule = (filePath: string) =>
    scheduleWatcher(owner, state, filePath, isSessionCurrent, refreshSession);
  watcher.on('add', schedule);
  watcher.on('change', schedule);
  watcher.on('unlink', schedule);
  watcher.on('addDir', schedule);
  watcher.on('unlinkDir', schedule);
  watcher.on('error', requestResync);
  powerMonitor.on('resume', requestResync);
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
  powerMonitor.removeListener('resume', watcher.resumeHandler);
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
