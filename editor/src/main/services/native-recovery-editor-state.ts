import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { EditorProjectState } from '../../shared/project-schema/editor-project-state';
import type { ProjectSourceFile } from '../../shared/project-source-files';
import type { NativeDirtyCheckpoint } from './native-authoring-working-project';

/** Physical source identity is already validated by native journal replay.
 * A deleted text file is absent from the fresh Files listing; reconstruct its
 * ordinary stable editor ID without inventing an authoring source. */
function recoveredSourceIdentity(physicalPath: string): ProjectSourceFile | null {
  if (
    physicalPath.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
    physicalPath.includes('\\')
  )
    return null;
  const layout = /^records\/layouts\/([a-z][a-z0-9-]*)\/layout\.(rml|rcss|lua)$/.exec(physicalPath);
  if (layout) {
    const id = `layouts/${layout[1]}/layout.${layout[2]}`;
    return {
      id,
      displayPath: id,
      projectRelativePath: physicalPath,
      kind: `layout-${layout[2]}` as 'layout-rml' | 'layout-rcss' | 'layout-lua',
      layout: { id: layout[1]!, channel: layout[2] as 'rml' | 'rcss' | 'lua' },
      text: true,
    };
  }
  if (/^scripts\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.lua$/.test(physicalPath))
    return {
      id: physicalPath,
      displayPath: physicalPath,
      projectRelativePath: physicalPath,
      kind: 'lua',
      text: true,
    };
  if (/^shaders\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.sc$/.test(physicalPath))
    return {
      id: physicalPath,
      displayPath: physicalPath,
      projectRelativePath: physicalPath,
      kind: 'shader',
      text: true,
    };
  return null;
}

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
    const previous = Object.values(editorState.sourceRecoveryById).find(
      (entry) => entry.file.projectRelativePath === physicalPath,
    );
    const file =
      files.find((entry) => entry.projectRelativePath === physicalPath && entry.text) ??
      (previous ? { ...previous.file, text: true } : recoveredSourceIdentity(physicalPath));
    if (!file || file.kind === 'asset')
      throw new Error(
        `Native staged source '${physicalPath}' is not an admitted editor text file.`,
      );
    const candidate = path.join(canonicalRoot, physicalPath);
    let canonicalSource: string;
    try {
      canonicalSource = await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      canonicalSource = path.join(
        await realpath(path.dirname(candidate)),
        path.basename(candidate),
      );
    }
    const relative = path.relative(canonicalRoot, canonicalSource);
    if (
      !relative ||
      relative.startsWith(`..${path.sep}`) ||
      relative === '..' ||
      path.isAbsolute(relative)
    )
      throw new Error('Native recovered source escaped the active Project.');
    let diskText: string;
    let exists = true;
    try {
      diskText = await readFile(canonicalSource, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      diskText = '';
      exists = false;
    }
    const revision = exists ? sourceRevisionFor?.(Buffer.from(diskText)) : 'absent';
    if (revision !== source.diskRevision)
      throw new Error(`Native recovered text source '${physicalPath}' changed on disk.`);
    const prior = sourceRecoveryById[file.id];
    if (
      prior &&
      prior.text !== source.text &&
      prior.baseContentHash === (source.conflictBaseRevision ?? source.diskRevision)
    )
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
      baseText: source.conflictBaseRevision && prior ? prior.baseText : diskText,
      baseContentHash: source.conflictBaseRevision ?? source.diskRevision,
    };
  }
  return { ...editorState, sourceRecoveryById };
}
