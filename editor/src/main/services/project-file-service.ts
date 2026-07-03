import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import type { SaveProjectResponse, ToolDiagnostic } from '../../shared/editor-tooling';
import { isSafeProjectAssetPath, parseAssetData } from '../../shared/project-schema/authoring-assets';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';

function jsonText(project: unknown): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}

async function writeProjectAtomic(project: unknown, projectFilePath: string): Promise<void> {
  const absolute = path.resolve(projectFilePath);
  const directory = path.dirname(absolute);
  const temporary = path.join(directory, `.${path.basename(absolute)}.${process.pid}.${Date.now()}.tmp`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(temporary, jsonText(project), 'utf8');
  await fs.rename(temporary, absolute);
}

function projectPathFromFile(projectFilePath: string): string {
  return path.dirname(path.resolve(projectFilePath));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeFileStem(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const stem = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return stem.length > 0 ? stem : null;
}

function defaultProjectFileName(project: unknown): string {
  if (isRecord(project) && isRecord(project.project)) {
    const stem = safeFileStem(project.project.id) ?? safeFileStem(project.project.name);
    if (stem) return `${stem}.json`;
  }
  return 'new-project.json';
}

function validationErrors(project: unknown): ToolDiagnostic[] {
  if (!isAuthoringProject(project)) return [];
  return validateAuthoringProject(project).filter((diagnostic) => diagnostic.severity === 'error');
}

function collectProjectAssetPaths(project: unknown): string[] {
  if (!isRecord(project) || !isRecord(project.assets)) return [];
  const paths = new Set<string>();
  for (const record of Object.values(project.assets)) {
    if (!isRecord(record)) continue;
    const data = parseAssetData(record.data);
    if (!data || !isSafeProjectAssetPath(data.source.path)) continue;
    paths.add(data.source.path);
  }
  return [...paths].sort();
}

function assetCopyDiagnostic(pathValue: string, message: string): ToolDiagnostic {
  return { severity: 'warning', category: 'project-save', path: pathValue, message };
}

async function copyProjectAssets(project: unknown, oldProjectFilePath: string, newProjectFilePath: string): Promise<ToolDiagnostic[]> {
  const diagnostics: ToolDiagnostic[] = [];
  const oldRoot = projectPathFromFile(oldProjectFilePath);
  const newRoot = projectPathFromFile(newProjectFilePath);
  if (path.resolve(oldRoot) === path.resolve(newRoot)) return diagnostics;
  for (const assetPath of collectProjectAssetPaths(project)) {
    const source = path.resolve(oldRoot, assetPath);
    const destination = path.resolve(newRoot, assetPath);
    const sourceRelative = path.relative(oldRoot, source);
    const destinationRelative = path.relative(newRoot, destination);
    if (sourceRelative.startsWith('..') || path.isAbsolute(sourceRelative) || destinationRelative.startsWith('..') || path.isAbsolute(destinationRelative)) {
      diagnostics.push(assetCopyDiagnostic(`/assets/${assetPath}`, `Skipped unsafe asset path '${assetPath}'.`));
      continue;
    }
    try {
      const sourceStat = await fs.stat(source);
      if (!sourceStat.isFile()) {
        diagnostics.push(assetCopyDiagnostic(`/assets/${assetPath}`, `Skipped asset '${assetPath}' because it is not a file.`));
        continue;
      }
      try {
        const destinationStat = await fs.stat(destination);
        if (destinationStat.isFile() && path.resolve(source) !== path.resolve(destination)) {
          diagnostics.push(assetCopyDiagnostic(`/assets/${assetPath}`, `Preserved existing asset file '${assetPath}' in the destination project folder.`));
          continue;
        }
      } catch {
        // Destination does not exist yet.
      }
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
    } catch (error) {
      diagnostics.push(assetCopyDiagnostic(`/assets/${assetPath}`, error instanceof Error ? error.message : `Failed to copy asset '${assetPath}'.`));
    }
  }
  return diagnostics;
}

async function existingDirectoryEntries(directory: string, projectFilePath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory);
    const projectBasename = path.basename(projectFilePath);
    return entries.filter((entry) => entry !== projectBasename && !entry.startsWith(`.${projectBasename}.`));
  } catch {
    return [];
  }
}

async function confirmNonEmptyDestination(owner: BrowserWindow, projectFilePath: string): Promise<boolean> {
  const directory = path.dirname(projectFilePath);
  const entries = await existingDirectoryEntries(directory, projectFilePath);
  if (entries.length === 0) return true;
  const sample = entries.slice(0, 6).join(', ');
  const suffix = entries.length > 6 ? `, and ${entries.length - 6} more` : '';
  const result = await dialog.showMessageBox(owner, {
    type: 'warning',
    buttons: ['Cancel', 'Save Here'],
    defaultId: 0,
    cancelId: 0,
    title: 'Save project in non-empty folder?',
    message: 'The selected folder is not empty.',
    detail: `NovelTea projects currently store project-owned files next to the project file, such as assets/images and assets/audio. Saving here may create or reuse project folders in:\n\n${directory}\n\nExisting entries include: ${sample}${suffix}`,
  });
  return result.response === 1;
}

export async function saveProject(project: unknown, projectFilePath: string): Promise<SaveProjectResponse> {
  if (!projectFilePath || typeof projectFilePath !== 'string') {
    return { ok: false, success: false, error: 'Project save requires a project file path.' };
  }
  const errors = validationErrors(project);
  if (errors.length > 0) {
    return {
      ok: false,
      success: false,
      error: errors[0]?.message ?? 'Project validation failed.',
      diagnostics: errors,
    };
  }
  try {
    await writeProjectAtomic(project, projectFilePath);
    const absolute = path.resolve(projectFilePath);
    return { ok: true, success: true, projectPath: projectPathFromFile(absolute), projectFilePath: absolute, diagnostics: [] };
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
  currentProjectFilePath: string | null = null,
): Promise<SaveProjectResponse> {
  if (!owner) return { ok: false, success: false, error: 'No editor window is available.' };
  const result = await dialog.showSaveDialog(owner, {
    title: 'Save NovelTea Project',
    defaultPath: defaultPath ?? defaultProjectFileName(project),
    filters: [
      { name: 'NovelTea Project', extensions: ['json', 'game'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, success: false, error: 'Save canceled.' };
  }
  const absolute = path.resolve(result.filePath);
  if (!(await confirmNonEmptyDestination(owner, absolute))) {
    return { ok: false, success: false, error: 'Save canceled.' };
  }
  const diagnostics = currentProjectFilePath
    ? await copyProjectAssets(project, currentProjectFilePath, absolute)
    : [];
  const saveResult = await saveProject(project, absolute);
  return diagnostics.length > 0 ? { ...saveResult, diagnostics } : saveResult;
}
