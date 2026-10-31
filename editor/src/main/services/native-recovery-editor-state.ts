import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { EditorProjectState } from '../../shared/project-schema/editor-project-state';
import type { ProjectSourceFile } from '../../shared/project-source-files';
import type { NativeDirtyCheckpoint } from './native-authoring-working-project';

/** Rebuild the ordinary source-buffer UX from the verified native text journal.
 * Source IDs (particularly Layout companions) are not physical paths. */
export async function withNativeRecoveredTextSources(
  root: string,
  editorState: EditorProjectState,
  files: readonly ProjectSourceFile[],
  textSources: NativeDirtyCheckpoint['textSources'],
  sourceRevisionFor?: (bytes: Uint8Array) => string,
): Promise<EditorProjectState> {
  const sourceRecoveryById = { ...editorState.sourceRecoveryById };
  const canonicalRoot = await realpath(root);
  for (const [physicalPath, source] of Object.entries(textSources)) {
    const file = files.find((entry) => entry.projectRelativePath === physicalPath && entry.text);
    if (!file || file.kind === 'asset')
      throw new Error(
        `Native staged source '${physicalPath}' is not an admitted editor text file.`,
      );
    const canonicalSource = await realpath(path.join(canonicalRoot, physicalPath));
    const relative = path.relative(canonicalRoot, canonicalSource);
    if (
      !relative ||
      relative.startsWith(`..${path.sep}`) ||
      relative === '..' ||
      path.isAbsolute(relative)
    )
      throw new Error('Native recovered source escaped the active Project.');
    const baseText = await readFile(canonicalSource, 'utf8');
    const revision = source.diskRevision.startsWith('xxh3-128:')
      ? sourceRevisionFor?.(Buffer.from(baseText))
      : `sha256:${createHash('sha256').update(baseText).digest('hex')}`;
    if (revision !== source.diskRevision)
      throw new Error(`Native recovered text source '${physicalPath}' changed on disk.`);
    const prior = sourceRecoveryById[file.id];
    if (prior && prior.text !== source.text && prior.baseContentHash === source.diskRevision)
      throw new Error(
        `Editor text recovery for '${physicalPath}' differs from the acknowledged native journal. Open without native certification to resolve the pending buffer.`,
      );
    sourceRecoveryById[file.id] = {
      file: {
        id: file.id,
        displayPath: file.displayPath,
        projectRelativePath: file.projectRelativePath,
        kind: file.kind,
      },
      text: source.text,
      baseText,
      baseContentHash: source.diskRevision,
    };
  }
  return { ...editorState, sourceRecoveryById };
}
