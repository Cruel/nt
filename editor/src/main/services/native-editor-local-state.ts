import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  EDITOR_PROJECT_STATE_SCHEMA,
  editorProjectStateSchema,
  emptyEditorProjectState,
  type EditorProjectState,
} from '../../shared/project-schema/editor-project-state';
import { EDITOR_LOCAL_STATE_SCHEMA } from '../../shared/project-workspace/project-workspace-contracts';

// Only non-Project UI state is decoded here. Tracked editor organization comes
// from native editor.yaml admission, never from this optional local document.
const localStateSchema = editorProjectStateSchema
  .omit({ schema: true, chapters: true, tags: true, recordMetadata: true })
  .extend({ schema: z.literal(EDITOR_LOCAL_STATE_SCHEMA) })
  .strict();
const LOCAL_STATE_MAX_BYTES = 24 * 1024 * 1024;

/** Read the current local editor-only schema without touching the retired
 * Project workspace reader. Corrupt journals are preserved and block Open:
 * an absent optional file is not equivalent to an unreadable recovery file. */
export async function readNativeEditorLocalState(
  projectRoot: string,
  nativeProject: AuthoringProject,
): Promise<EditorProjectState> {
  const root = await realpath(projectRoot);
  const directory = path.join(root, '.noveltea', 'editor');
  const filename = path.join(directory, 'state.json');
  let local = emptyEditorProjectState();
  try {
    for (const component of [path.join(root, '.noveltea'), directory, filename]) {
      const stat = await lstat(component);
      if (stat.isSymbolicLink()) throw new Error('Editor recovery path is a symbolic link.');
      if (component === filename && !stat.isFile())
        throw new Error('Editor recovery document is not a regular file.');
      if (component !== filename && !stat.isDirectory())
        throw new Error('Editor recovery directory is not a directory.');
    }
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > LOCAL_STATE_MAX_BYTES)
        throw new Error('Editor recovery document is not a supported regular file.');
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (bytes.byteLength > LOCAL_STATE_MAX_BYTES)
      throw new Error('Editor recovery document exceeds the maximum size.');
    const parsed = localStateSchema.safeParse(JSON.parse(bytes.toString('utf8')) as unknown);
    if (!parsed.success) throw new Error('Editor recovery document has an invalid schema.');
    local = {
      ...local,
      ...parsed.data,
      schema: EDITOR_PROJECT_STATE_SCHEMA,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        `Editor local state cannot be recovered: ${error instanceof Error ? error.message : String(error)}. The original file was preserved.`,
      );
    }
  }
  return {
    ...local,
    chapters: nativeProject.editor.chapters,
    tags: nativeProject.editor.tags,
    recordMetadata: nativeProject.editor.recordMetadata,
  };
}
