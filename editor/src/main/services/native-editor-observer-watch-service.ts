import path from 'node:path';
import type { ProjectWorkspaceWatchEvent } from '../../shared/project-workspace-watch';
import type { ProjectValidationDiagnostic } from '../../shared/project-schema/project-validation';
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
  const assetRevisions: Record<string, `sha256:${string}` | 'absent'> = {};
  for (const file of assets) {
    const hash = observation.revisions[file];
    if (hash === 'absent' || (hash && /^sha256:[a-f0-9]{64}$/u.test(hash)))
      assetRevisions[file] = hash as `sha256:${string}` | 'absent';
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

  constructor(
    private readonly bridge: NativeBridge,
    private readonly authority: Authority,
    private readonly publish: (event: ProjectWorkspaceWatchEvent) => void,
  ) {}

  start(projectSessionId: string): void {
    this.close();
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
    for (const release of this.unsubscribe.splice(0)) release();
  }
}
