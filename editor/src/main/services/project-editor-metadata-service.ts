import path from 'node:path';
import type { SaveProjectEditorMetadataResponse } from '../../shared/editor-tooling';
import {
  editorProjectStateSchema,
  type EditorProjectState,
} from '../../shared/project-schema/editor-project-state';
import { createProjectValidationDiagnostic } from '../../shared/project-schema/project-diagnostic-projection';
import { projectWorkspaceLocalStateFile } from '../../shared/editor-local-state-file';
import { createNodeProjectWorkspaceFileSystem } from '../../shared/project-workspace/node-project-workspace-file-system';
import { assertProjectWorkspacePathContained } from '../../shared/project-workspace/project-workspace-file-system';

export async function saveProjectEditorMetadata(
  projectRoot: string,
  editorState: EditorProjectState,
  assertAuthority?: () => void,
): Promise<SaveProjectEditorMetadataResponse> {
  try {
    if (!projectRoot || typeof projectRoot !== 'string')
      throw new Error('Editor metadata save requires an active project root.');
    const root =
      path.basename(projectRoot) === 'project.yaml'
        ? path.dirname(path.resolve(projectRoot))
        : path.resolve(projectRoot);
    const parsed = editorProjectStateSchema.safeParse(editorState);
    if (!parsed.success) {
      const diagnostic = createProjectValidationDiagnostic({
        code: 'editor.metadata.invalid',
        severity: 'error',
        category: 'Project recovery',
        path: '/editor',
        message: 'Editor recovery metadata is invalid and was not written.',
        boundaries: ['authoring'],
        ownerPaths: ['/editor'],
      });
      return { ok: false, success: false, diagnostics: [diagnostic], error: diagnostic.message };
    }
    const fileSystem = createNodeProjectWorkspaceFileSystem();
    const directory = path.join(root, '.noveltea', 'editor');
    const filename = path.join(directory, 'state.json');
    // Match native Open: a linked recovery path is not an admissible journal,
    // even when its target happens to be contained in this Project.
    for (const component of [path.join(root, '.noveltea'), directory, filename]) {
      const metadata = await fileSystem.readPathMetadata(component);
      if (
        metadata.kind !== 'missing' &&
        metadata.kind !== (component === filename ? 'file' : 'directory')
      )
        throw new Error('Editor recovery path is not an ordinary local state path.');
    }
    await assertProjectWorkspacePathContained(fileSystem, root, filename);
    const text = projectWorkspaceLocalStateFile(parsed.data);
    let previous: string | null;
    try {
      previous = await fileSystem.readText(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      previous = null;
    }
    assertAuthority?.();
    if (previous !== text) await fileSystem.writeTextAtomic(filename, text);
    return { ok: true, success: true, diagnostics: [], editorState: parsed.data };
  } catch (error) {
    return {
      ok: false,
      success: false,
      diagnostics: [],
      error: error instanceof Error ? error.message : 'Editor metadata save failed.',
    };
  }
}
