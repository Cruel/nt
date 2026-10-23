import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { OpenProjectResponse } from '../../shared/editor-tooling';
import type { ActiveProjectSessionService } from './active-project-session-service';
import type { NativeEditorSessionController } from './native-editor-session-controller';
import { readNativeEditorLocalState } from './native-editor-local-state';
import { withNativeRecoveredTextSources } from './native-recovery-editor-state';

type NativeOpenSession = Pick<
  ActiveProjectSessionService,
  | 'activateProjectFile'
  | 'acceptNativeProject'
  | 'currentSessionId'
  | 'isProjectActivationCurrent'
  | 'closeActiveProject'
  | 'listProjectSourceFiles'
>;
type NativeOpenController = Pick<
  NativeEditorSessionController,
  | 'admitFromNative'
  | 'recoveredContentProject'
  | 'recoveredConflicts'
  | 'recoveredTextSources'
  | 'close'
>;

/**
 * Native-only editor Open admission, prepared for the atomic editor/CLI
 * production switch. This module does not instantiate or import the retired
 * Workspace reader. No caller-provided content is accepted as Project truth.
 */
export async function openNativeEditorProject(
  requestedPath: string,
  activationGeneration: number,
  sessions: NativeOpenSession,
  native: NativeOpenController,
): Promise<OpenProjectResponse> {
  const fallbackRoot = path.resolve(requestedPath);
  let manifestPath = path.join(fallbackRoot, 'project.yaml');
  let projectSessionId: string | null = null;
  try {
    // The native worker requires a main-owned admitted session. A failed
    // candidate Open must never revoke an existing dirty editor Project.
    // Coordinated production activation must stage a second candidate before
    // relaxing this guard; cold native Open is independently supported now.
    if (sessions.currentSessionId())
      throw new Error('Native Project handoff requires pre-admission of the new Project.');
    const candidate = await realpath(fallbackRoot);
    const file = (await stat(candidate)).isDirectory()
      ? path.join(candidate, 'project.yaml')
      : candidate;
    if (path.basename(file) !== 'project.yaml')
      throw new Error('Expected the Project directory or its project.yaml manifest.');
    manifestPath = await realpath(file);
    const manifest = await stat(manifestPath);
    if (!manifest.isFile()) throw new Error('Project manifest is not a regular file.');
    const root = path.dirname(manifestPath);
    projectSessionId = await sessions.activateProjectFile(manifestPath, activationGeneration);
    const admitted = await native.admitFromNative(projectSessionId);
    if (!sessions.isProjectActivationCurrent(activationGeneration))
      throw new Error('Project activation was superseded.');
    const state = await readNativeEditorLocalState(root, admitted.savedProject);
    if (!sessions.isProjectActivationCurrent(activationGeneration))
      throw new Error('Project activation was superseded during local recovery.');
    await sessions.acceptNativeProject(projectSessionId, admitted.savedProject);
    const textSources = native.recoveredTextSources();
    const editorState = Object.keys(textSources).length
      ? await withNativeRecoveredTextSources(
          root,
          state,
          (await sessions.listProjectSourceFiles({ projectSessionId })).files,
          textSources,
        )
      : state;
    if (!sessions.isProjectActivationCurrent(activationGeneration))
      throw new Error('Project activation was superseded during source recovery.');
    const scriptSourcePaths = Object.fromEntries(
      Object.entries(admitted.savedProject.scripts).flatMap(([id, record]) =>
        record.data.source.kind === 'project-file' ? [[id, record.data.source.path]] : [],
      ),
    );
    const recoveryFileRevisions = Object.fromEntries(
      Object.entries(admitted.sourceRevisions).filter(
        (pair): pair is [string, `sha256:${string}` | 'absent'] =>
          pair[1] === 'absent' || /^sha256:[a-f0-9]{64}$/u.test(pair[1]),
      ),
    );
    const recovered = native.recoveredContentProject();
    return {
      ok: true,
      success: true,
      diagnostics: admitted.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        category: 'Project validation',
      })),
      contentProject: admitted.savedProject,
      savedContentProject: admitted.savedProject,
      editorState,
      repairs: [],
      recoveryFileRevisions,
      scriptSourcePaths,
      projectPath: root,
      projectFilePath: manifestPath,
      projectSessionId,
      nativeWorkingRevision: admitted.revision,
      ...(recovered ? { nativeRecoveredContentProject: recovered } : {}),
      ...(recovered ? { nativeRecoveredConflicts: native.recoveredConflicts() } : {}),
    };
  } catch (error) {
    // Do not revoke an overlapping activation that has already superseded us.
    if (
      projectSessionId &&
      sessions.isProjectActivationCurrent(activationGeneration) &&
      sessions.currentSessionId() === projectSessionId
    ) {
      native.close();
      sessions.closeActiveProject();
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: true,
      success: false,
      diagnostics: [{ severity: 'error', path: '/project.yaml', message }],
      error: message,
      projectPath: path.dirname(manifestPath),
      projectFilePath: manifestPath,
    };
  }
}
