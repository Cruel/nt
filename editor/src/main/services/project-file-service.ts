import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import type { SaveProjectResponse } from '../../shared/editor-tooling';

function jsonText(project: unknown): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}

async function writeProjectAtomic(project: unknown, projectFilePath: string): Promise<void> {
  const absolute = path.resolve(projectFilePath);
  const directory = path.dirname(absolute);
  const temporary = path.join(directory, `.${path.basename(absolute)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temporary, jsonText(project), 'utf8');
  await fs.rename(temporary, absolute);
}

function projectPathFromFile(projectFilePath: string): string {
  return path.dirname(path.resolve(projectFilePath));
}

export async function saveProject(project: unknown, projectFilePath: string): Promise<SaveProjectResponse> {
  if (!projectFilePath || typeof projectFilePath !== 'string') {
    return { ok: false, success: false, error: 'Project save requires a project file path.' };
  }
  try {
    await writeProjectAtomic(project, projectFilePath);
    const absolute = path.resolve(projectFilePath);
    return { ok: true, success: true, projectPath: projectPathFromFile(absolute), projectFilePath: absolute };
  } catch (error) {
    return {
      ok: false,
      success: false,
      error: error instanceof Error ? error.message : 'Project save failed.',
    };
  }
}

export async function saveProjectAs(
  owner: BrowserWindow | null,
  project: unknown,
  defaultPath: string | null = null,
): Promise<SaveProjectResponse> {
  if (!owner) return { ok: false, success: false, error: 'No editor window is available.' };
  const result = await dialog.showSaveDialog(owner, {
    title: 'Save NovelTea Project',
    defaultPath: defaultPath ?? 'game.json',
    filters: [
      { name: 'NovelTea Project', extensions: ['json', 'game'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, success: false, error: 'Save canceled.' };
  }
  return saveProject(project, result.filePath);
}
