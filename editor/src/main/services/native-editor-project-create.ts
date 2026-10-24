import path from 'node:path';
import type { CreateProjectRequest, SaveProjectResponse } from '../../shared/editor-tooling';
import { invokeNovelTeaNativeOperation } from '../../shared/noveltea-cli-subprocess';

type NativeCreate = (operation: string, request: unknown) => Promise<unknown>;

/** Create is an independent native filesystem transaction. The UI separately
 * opens the resulting Project through candidate admission; no legacy Workspace
 * writer, initializer or TypeScript Project validator is invoked. */
export async function createNativeEditorProject(
  request: CreateProjectRequest,
  invoke: NativeCreate = invokeNovelTeaNativeOperation,
): Promise<SaveProjectResponse> {
  try {
    if (!request.projectDirectory.trim()) throw new Error('Project directory is required.');
    if (!request.projectName.trim()) throw new Error('Project name is required.');
    const destination = path.resolve(request.projectDirectory.trim());
    const raw = await invoke('native-project-create', {
      projectRoot: destination,
      name: request.projectName,
    });
    if (!raw || typeof raw !== 'object' || !('ok' in raw) || raw.ok !== true) {
      const failure = raw as { error?: unknown } | null;
      throw new Error(
        typeof failure?.error === 'string' ? failure.error : 'Native Project creation failed.',
      );
    }
    if (
      !('projectRoot' in raw) ||
      raw.projectRoot !== destination ||
      !('projectFilePath' in raw) ||
      raw.projectFilePath !== path.join(destination, 'project.yaml') ||
      !('projectId' in raw) ||
      typeof raw.projectId !== 'string' ||
      !raw.projectId
    )
      throw new Error('Native Project creation returned an invalid destination or identity.');
    return {
      ok: true,
      success: true,
      projectPath: destination,
      projectFilePath: raw.projectFilePath,
      diagnostics: [],
    };
  } catch (error) {
    return {
      ok: false,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
