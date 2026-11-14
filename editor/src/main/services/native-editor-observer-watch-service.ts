import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { WORKING_SOURCE_ROOT } from '../../shared/project-workspace/working-source-contract';
import type { ProjectWorkspaceWatchEvent } from '../../shared/project-watch-events';
import type { ProjectValidationDiagnostic } from '../../shared/project-schema/project-diagnostic-projection';
import type { ActiveProjectSessionService } from './active-project-session-service';
import type { NativeAuthoringSessionBridge } from './native-authoring-session-bridge';
import type { NativeAuthoringEvent } from './native-authoring-worker-contract';

type NativeDelta = Extract<NativeAuthoringEvent, { type: 'delta' }>;
type NativeBridge = Pick<NativeAuthoringSessionBridge, 'subscribe' | 'onFailure'>;
type Authority = Pick<ActiveProjectSessionService, 'isCurrent'>;

function sourceDiagnostic(
  code: string,
  pathValue: string,
  message: string,
): ProjectValidationDiagnostic {
  const pointer = '/' + pathValue.replaceAll('~', '~0').replaceAll('/', '~1');
  return {
    code,
    severity: 'error',
    category: 'Project source',
    path: pointer,
    message,
    ownerPaths: [pointer],
    boundaries: ['authoring'],
  };
}

function safePhysicalSourcePath(file: string): boolean {
  return (
    file.length > 0 &&
    file.indexOf('\\') === -1 &&
    file.indexOf('\0') === -1 &&
    !path.posix.isAbsolute(file) &&
    !/^[A-Za-z]:/u.test(file) &&
    path.posix.normalize(file) === file &&
    !file.split('/').some((part) => part === '.' || part === '..' || part === '')
  );
}

/** Consume the real native observer's exact-byte revisions rather than a
 * duplicate filesystem watcher or TypeScript Workspace reassembly. The
 * renderer's native revision-checked reconciliation owns semantic admission. */
export function watchEventFromNativeObservation(
  projectSessionId: string,
  delta: NativeDelta,
): ProjectWorkspaceWatchEvent | null {
  const observation = delta.observation;
  const paths = [
    ...new Set([...observation.added, ...observation.changed, ...observation.removed]),
  ];
  const invalidPaths = paths.filter((file) => !safePhysicalSourcePath(file));
  const authorityReady =
    observation.authoritative &&
    observation.scopedAuthority &&
    !observation.error &&
    !invalidPaths.length;
  const diagnostics: ProjectValidationDiagnostic[] = [
    ...observation.invalidSources.map((invalid) =>
      sourceDiagnostic('native.source.invalid', invalid.path, invalid.error),
    ),
    ...observation.recordDiagnostics.map(
      (diagnostic): ProjectValidationDiagnostic => ({
        ...diagnostic,
        category: 'Project source',
        boundaries: ['authoring'],
        ownerPaths: [diagnostic.path],
      }),
    ),
    ...invalidPaths.map((file) =>
      sourceDiagnostic(
        'native.observer.unsafe-path',
        file,
        'Native observer reported an unsafe path.',
      ),
    ),
    ...(!authorityReady
      ? [
          sourceDiagnostic(
            'native.observer.authority-uncertain',
            'project.yaml',
            observation.error || 'Native Project source observation lacks exact authority.',
          ),
        ]
      : []),
  ];
  // No unverified path can trigger a write, silent rebase or automatic Project
  // reconciliation. Explicit error diagnostics remain visible to the user.
  if (!authorityReady)
    return {
      projectSessionId,
      changedPaths: [],
      authoringChangedPaths: [],
      assetChangedPaths: [],
      sourceChangedPaths: [],
      sourceDiagnostics: diagnostics,
    };
  const yaml = paths.filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'));
  const assets = paths.filter(
    (file) =>
      file.startsWith('assets/') || file.startsWith('support/') || file.startsWith('supporting/'),
  );
  const assetSet = new Set(assets);
  const sources = paths.filter(
    (file) => !file.endsWith('.yaml') && !file.endsWith('.yml') && !assetSet.has(file),
  );
  const assetRevisions: Record<string, `xxh3-128:${string}` | 'absent'> = {};
  for (const file of assets) {
    const hash = observation.revisions[file];
    if (hash === 'absent' || (hash && /^xxh3-128:[a-f0-9]{32}$/u.test(hash)))
      assetRevisions[file] = hash as `xxh3-128:${string}` | 'absent';
  }
  const absentProof = assets.filter((file) => !(file in assetRevisions));
  if (absentProof.length)
    diagnostics.push(
      ...absentProof.map((file) =>
        sourceDiagnostic(
          'native.observer.asset-proof-missing',
          file,
          'Asset source revision was not reported by native observation.',
        ),
      ),
    );
  if (!paths.length && !diagnostics.length) return null;
  return {
    projectSessionId,
    changedPaths: paths,
    authoringChangedPaths: yaml,
    sourceChangedPaths: sources,
    assetChangedPaths: assets.filter((file) => file in assetRevisions),
    assetFileRevisions: assetRevisions,
    sourceDiagnostics: diagnostics,
  };
}

export class NativeEditorObserverWatchService {
  private unsubscribe: (() => void)[] = [];
  private workingWatcher: FSWatcher | null = null;
  private workingTimer: ReturnType<typeof setTimeout> | null = null;
  private workingRecheck: ReturnType<typeof setInterval> | null = null;
  private workingGeneration = 0;

  constructor(
    private readonly bridge: NativeBridge,
    private readonly authority: Authority,
    private readonly publish: (event: ProjectWorkspaceWatchEvent) => void,
    private readonly workingRoot?: (projectSessionId: string) => string,
  ) {}

  private notifyWorking(projectSessionId: string, generation: number): void {
    if (generation !== this.workingGeneration || !this.authority.isCurrent(projectSessionId))
      return;
    if (this.workingTimer) clearTimeout(this.workingTimer);
    this.workingTimer = setTimeout(() => {
      this.workingTimer = null;
      if (generation !== this.workingGeneration || !this.authority.isCurrent(projectSessionId))
        return;
      // Only a hint; native import verifies exact bytes and active revision.
      this.publish({
        projectSessionId,
        changedPaths: [],
        authoringChangedPaths: [],
        assetChangedPaths: [],
        workingSourceChanged: true,
      });
    }, 200);
  }

  start(projectSessionId: string): void {
    this.close();
    const generation = this.workingGeneration;
    if (this.workingRoot) {
      // Deliberately *not* a second observer of tracked YAML: only the ignored
      // working proposal tree is watched here. Polling is a portable fallback
      // for a missing initial directory or dropped platform notifications.
      const working = path.join(this.workingRoot(projectSessionId), WORKING_SOURCE_ROOT);
      this.workingWatcher = chokidar.watch(working, {
        ignoreInitial: true,
        followSymlinks: false,
        awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
        ignored: (filename) => {
          const relative = path.relative(working, filename).split(path.sep).join('/');
          return (
            relative === 'manifest.json' ||
            relative === 'baselines' ||
            relative.startsWith('baselines/')
          );
        },
      });
      this.workingWatcher.on('all', (_kind, filename) => {
        const relative = path.relative(working, filename).split(path.sep).join('/');
        if (/^(files|pending|deletions)\//.test(relative))
          this.notifyWorking(projectSessionId, generation);
      });
      // A failed native OS watch is not permission to drop future external
      // edits. The bounded snapshot import can still recheck periodically.
      this.workingWatcher.on('error', () => this.notifyWorking(projectSessionId, generation));
      this.workingRecheck = setInterval(
        () => this.notifyWorking(projectSessionId, generation),
        5000,
      );
      this.workingRecheck.unref?.();
    }
    this.unsubscribe.push(
      this.bridge.subscribe((delta) => {
        if (!this.authority.isCurrent(projectSessionId) || delta.sessionId !== projectSessionId)
          return;
        const event = watchEventFromNativeObservation(projectSessionId, delta);
        if (event) this.publish(event);
      }),
      this.bridge.onFailure((error) => {
        if (!this.authority.isCurrent(projectSessionId)) return;
        this.publish({
          projectSessionId,
          changedPaths: [],
          authoringChangedPaths: [],
          assetChangedPaths: [],
          sourceDiagnostics: [
            sourceDiagnostic('native.observer.worker-failed', 'project.yaml', error.message),
          ],
        });
      }),
    );
  }

  close(): void {
    ++this.workingGeneration;
    if (this.workingTimer) clearTimeout(this.workingTimer);
    if (this.workingRecheck) clearInterval(this.workingRecheck);
    this.workingTimer = null;
    this.workingRecheck = null;
    const watcher = this.workingWatcher;
    this.workingWatcher = null;
    if (watcher) void watcher.close();
    for (const release of this.unsubscribe.splice(0)) release();
  }
}
