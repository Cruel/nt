import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { OpenProjectResponse } from '../../shared/editor-tooling';
import type { ActiveProjectSessionService } from './active-project-session-service';
import type { NativeEditorSessionController } from './native-editor-session-controller';
import { readNativeEditorLocalState } from './native-editor-local-state';
import { withNativeRecoveredTextSources } from './native-recovery-editor-state';

type NativeOpenSession = Pick<
  ActiveProjectSessionService,
  | 'stageNativeProjectFile'
  | 'commitStagedNativeProject'
  | 'discardStagedNativeProject'
  | 'acceptNativeProject'
  | 'currentSessionId'
  | 'isProjectActivationCurrent'
  | 'listProjectSourceFiles'
>;
type NativeOpenController = Pick<
  NativeEditorSessionController,
  | 'admitFromNative'
  | 'recoveredContentProject'
  | 'recoveredConflicts'
  | 'recoveredTextSources'
  | 'close'
> &
  Partial<Pick<NativeEditorSessionController, 'sourceRevisionFor'>>;

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
    projectSessionId = await sessions.stageNativeProjectFile(manifestPath, activationGeneration);
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
          native.sourceRevisionFor?.(),
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
        (pair): pair is [string, `xxh3-128:${string}` | 'absent'] =>
          pair[1] === 'absent' || /^xxh3-128:[a-f0-9]{32}$/u.test(pair[1]),
      ),
    );
    const recovered = native.recoveredContentProject();
    const response: OpenProjectResponse = {
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
    sessions.commitStagedNativeProject(projectSessionId, activationGeneration);
    return response;
  } catch (error) {
    // A failed candidate never closes the incumbent Project or its worker.
    if (projectSessionId) {
      native.close();
      sessions.discardStagedNativeProject(projectSessionId);
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
