import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import type { SaveProjectResponse } from '../../shared/editor-tooling';
import { parseEditorProjectState } from '../../shared/project-schema/editor-project-state';
import { projectWorkspaceLocalStateFile } from '../../shared/editor-local-state-file';

/** Copy verified native saved sources byte-for-byte; never serialize YAML in TypeScript. */
export async function saveNativeProjectCopyAs(
  owner: BrowserWindow | null,
  sourceProjectRoot: string,
  editorCopyDocument: unknown,
  verifyNativeSavedSources: () => Promise<void>,
): Promise<SaveProjectResponse> {
  if (!owner) return { ok: false, success: false, error: 'No editor window is available.' };
  const sourceRoot = await fs.realpath(sourceProjectRoot);
  const selection = await dialog.showOpenDialog(owner, {
    title: 'Save NovelTea Project Copy',
    defaultPath: sourceRoot,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (selection.canceled || !selection.filePaths[0])
    return { ok: false, success: false, error: 'Save canceled.' };
  const target = path.resolve(selection.filePaths[0]);
  const staging = path.join(path.dirname(target), `.noveltea-copy-${randomUUID()}`);
  let staged = false;
  const created: string[] = [];
  try {
    const destReal = await fs.realpath(target);
    if (destReal !== target)
      throw new Error('Project Copy destination must not be a symbolic link.');
    if (
      target === sourceRoot ||
      target.startsWith(sourceRoot + path.sep) ||
      sourceRoot.startsWith(target + path.sep)
    )
      throw new Error('Project Copy destination must be outside the original Project tree.');
    if (
      (await fs.lstat(path.join(target, 'project.yaml')).catch(() => null)) ||
      (await fs.lstat(path.join(target, '.noveltea')).catch(() => null)) ||
      (await fs.lstat(path.join(target, 'records')).catch(() => null))
    )
      throw new Error('Project Copy destination already contains Project sources or state.');
    const existing = await fs.readdir(target);
    if (existing.length) {
      const answer = await dialog.showMessageBox(owner, {
        type: 'warning',
        buttons: ['Cancel', 'Save Here'],
        defaultId: 0,
        cancelId: 0,
        title: 'Save project in non-empty folder?',
        message: 'The selected folder is not empty.',
        detail: 'NovelTea will not overwrite existing files.',
      });
      if (answer.response !== 1) return { ok: false, success: false, error: 'Save canceled.' };
    }
    await verifyNativeSavedSources();
    staged = true;
    await fs.cp(sourceRoot, staging, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: async (item) => {
        const relative = path.relative(sourceRoot, item);
        if (relative === '') return true;
        const segments = relative.split(path.sep);
        if (
          segments.some((segment) => ['.git', '.noveltea'].includes(segment)) ||
          ['node_modules', 'dist', 'build', '.cache'].includes(segments[0]!)
        )
          return false;
        const stat = await fs.lstat(item);
        if (stat.isSymbolicLink())
          throw new Error('Project source contains a symbolic link: ' + relative);
        return stat.isDirectory() || stat.isFile();
      },
    });
    const editor = parseEditorProjectState(
      editorCopyDocument &&
        typeof editorCopyDocument === 'object' &&
        !Array.isArray(editorCopyDocument) &&
        'editor' in editorCopyDocument
        ? editorCopyDocument.editor
        : undefined,
    );
    await fs.mkdir(path.join(staging, '.noveltea', 'editor'), { recursive: true });
    await fs.writeFile(
      path.join(staging, '.noveltea', 'editor', 'state.json'),
      projectWorkspaceLocalStateFile(editor),
    );
    await verifyNativeSavedSources();
    if (existing.length) {
      const additions = await fs.readdir(staging);
      for (const entry of additions) {
        try {
          await fs.lstat(path.join(target, entry));
          throw new Error('Project Copy destination was modified: ' + entry);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      for (const entry of additions) {
        const dest = path.join(target, entry);
        const source = path.join(staging, entry);
        if ((await fs.lstat(source)).isDirectory()) {
          // Refuse a destination that appeared since preflight; rename may
          // replace an empty directory on POSIX and lose unrelated data.
          await fs.mkdir(dest);
          created.push(dest);
          for (const child of await fs.readdir(source))
            await fs.cp(path.join(source, child), path.join(dest, child), {
              recursive: true,
              force: false,
              errorOnExist: true,
            });
        } else {
          await fs.copyFile(source, dest, constants.COPYFILE_EXCL);
          created.push(dest);
        }
      }
    } else {
      await fs.rmdir(target);
      try {
        await fs.rename(staging, target);
        staged = false;
      } catch (error) {
        await fs.mkdir(target).catch(() => undefined);
        throw error;
      }
    }
    return {
      ok: true,
      success: true,
      projectPath: target,
      projectFilePath: path.join(target, 'project.yaml'),
      diagnostics: [],
    };
  } catch (error) {
    for (const entry of created.reverse())
      await fs.rm(entry, { recursive: true, force: true }).catch(() => undefined);
    return {
      ok: false,
      success: false,
      error: error instanceof Error ? error.message : 'Native Project Copy failed.',
      diagnostics: [],
    };
  } finally {
    if (staged) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
