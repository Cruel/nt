import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import type {
  CreateProjectRequest,
  SaveProjectEditorMetadataResponse,
  SaveProjectResponse,
  ToolDiagnostic,
} from '../../shared/editor-tooling';
import {
  isSafeProjectAssetPath,
  parseAssetData,
} from '../../shared/project-schema/authoring-assets';
import {
  createAuthoringProject,
  isAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import {
  editorProjectStateSchema,
  parseEditorProjectState,
  stripEditorProjectState,
  type EditorProjectState,
} from '../../shared/project-schema/editor-project-state';
import { createProjectValidationDiagnostic } from '../../shared/project-schema/project-validation';
import { projectContentFingerprint } from './project-content-fingerprint';

export { projectContentFingerprint } from './project-content-fingerprint';

function jsonText(project: unknown): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}

async function writeProjectAtomic(project: unknown, projectFilePath: string): Promise<void> {
  const absolute = path.resolve(projectFilePath);
  const directory = path.dirname(absolute);
  const temporary = path.join(
    directory,
    `.${path.basename(absolute)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(temporary, jsonText(project), 'utf8');
  await fs.rename(temporary, absolute);
}

function projectWithCurrentEditorFingerprint(project: unknown): {
  project: unknown;
  contentFingerprint: string;
} {
  const content = stripEditorProjectState(project);
  const contentFingerprint = projectContentFingerprint(content);
  if (!isRecord(content)) return { project, contentFingerprint };
  const rawEditor = isRecord(project) ? project.editor : undefined;
  const editor = parseEditorProjectState(rawEditor, contentFingerprint);
  return { project: { ...content, editor }, contentFingerprint };
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

export function safeProjectSlug(value: string): string | null {
  return safeFileStem(value);
}

function hasSpacePathSegment(value: string): boolean {
  return path
    .resolve(value)
    .split(path.sep)
    .some((segment) => /\s/.test(segment));
}

async function directoryEntries(directory: string): Promise<string[]> {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw error;
  }
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

async function copyProjectAssets(
  project: unknown,
  oldProjectFilePath: string,
  newProjectFilePath: string,
  additionalProjectAssetPaths: readonly string[] = [],
): Promise<ToolDiagnostic[]> {
  const diagnostics: ToolDiagnostic[] = [];
  const oldRoot = projectPathFromFile(oldProjectFilePath);
  const newRoot = projectPathFromFile(newProjectFilePath);
  if (path.resolve(oldRoot) === path.resolve(newRoot)) return diagnostics;
  const assetPaths = [
    ...new Set([...collectProjectAssetPaths(project), ...additionalProjectAssetPaths]),
  ]
    .filter(
      (assetPath): assetPath is string => typeof assetPath === 'string' && assetPath.length > 0,
    )
    .sort();
  for (const assetPath of assetPaths) {
    if (!isSafeProjectAssetPath(assetPath)) {
      diagnostics.push(
        assetCopyDiagnostic(`/assets/${assetPath}`, `Skipped unsafe asset path '${assetPath}'.`),
      );
      continue;
    }
    const source = path.resolve(oldRoot, assetPath);
    const destination = path.resolve(newRoot, assetPath);
    const sourceRelative = path.relative(oldRoot, source);
    const destinationRelative = path.relative(newRoot, destination);
    if (
      sourceRelative.startsWith('..') ||
      path.isAbsolute(sourceRelative) ||
      destinationRelative.startsWith('..') ||
      path.isAbsolute(destinationRelative)
    ) {
      diagnostics.push(
        assetCopyDiagnostic(`/assets/${assetPath}`, `Skipped unsafe asset path '${assetPath}'.`),
      );
      continue;
    }
    try {
      const sourceStat = await fs.stat(source);
      if (!sourceStat.isFile()) {
        diagnostics.push(
          assetCopyDiagnostic(
            `/assets/${assetPath}`,
            `Skipped asset '${assetPath}' because it is not a file.`,
          ),
        );
        continue;
      }
      try {
        const destinationStat = await fs.stat(destination);
        if (destinationStat.isFile() && path.resolve(source) !== path.resolve(destination)) {
          diagnostics.push(
            assetCopyDiagnostic(
              `/assets/${assetPath}`,
              `Preserved existing asset file '${assetPath}' in the destination project folder.`,
            ),
          );
          continue;
        }
      } catch {
        // Destination does not exist yet.
      }
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
    } catch (error) {
      diagnostics.push(
        assetCopyDiagnostic(
          `/assets/${assetPath}`,
          error instanceof Error ? error.message : `Failed to copy asset '${assetPath}'.`,
        ),
      );
    }
  }
  return diagnostics;
}

async function existingDirectoryEntries(
  directory: string,
  projectFilePath: string,
): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory);
    const projectBasename = path.basename(projectFilePath);
    return entries.filter(
      (entry) => entry !== projectBasename && !entry.startsWith(`.${projectBasename}.`),
    );
  } catch {
    return [];
  }
}

async function confirmNonEmptyDestination(
  owner: BrowserWindow,
  projectFilePath: string,
): Promise<boolean> {
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

export async function saveProject(
  project: unknown,
  projectFilePath: string,
): Promise<SaveProjectResponse> {
  if (!projectFilePath || typeof projectFilePath !== 'string') {
    return { ok: false, success: false, error: 'Project save requires a project file path.' };
  }
  const normalized = projectWithCurrentEditorFingerprint(project);
  const errors = validationErrors(normalized.project);
  if (errors.length > 0) {
    return {
      ok: false,
      success: false,
      error: errors[0]?.message ?? 'Project validation failed.',
      diagnostics: errors,
    };
  }
  try {
    await writeProjectAtomic(normalized.project, projectFilePath);
    const absolute = path.resolve(projectFilePath);
    return {
      ok: true,
      success: true,
      projectPath: projectPathFromFile(absolute),
      projectFilePath: absolute,
      contentFingerprint: normalized.contentFingerprint,
      diagnostics: [],
    };
  } catch (error) {
    return {
      ok: false,
      success: false,
      error: error instanceof Error ? error.message : 'Project save failed.',
    };
  }
}

export async function saveProjectEditorMetadata(
  projectFilePath: string,
  expectedContentFingerprint: string,
  editorState: EditorProjectState,
): Promise<SaveProjectEditorMetadataResponse> {
  if (!projectFilePath || typeof projectFilePath !== 'string') {
    return {
      ok: false,
      success: false,
      diagnostics: [],
      error: 'Editor metadata save requires a project file path.',
    };
  }
  try {
    const source = await fs.readFile(path.resolve(projectFilePath), 'utf8');
    const parsed = JSON.parse(source) as unknown;
    if (!isRecord(parsed)) throw new Error('Project root must be an object.');
    const content = stripEditorProjectState(parsed);
    const actualContentFingerprint = projectContentFingerprint(content);
    if (actualContentFingerprint !== expectedContentFingerprint) {
      const diagnostic = createProjectValidationDiagnostic({
        code: 'editor.metadata.content-conflict',
        severity: 'error',
        category: 'Project recovery',
        path: '/editor',
        message:
          'Project content changed outside the editor. Recovery metadata was not written so the external changes remain untouched.',
        boundaries: ['authoring'],
        ownerPaths: ['/editor'],
      });
      return {
        ok: false,
        success: false,
        diagnostics: [diagnostic],
        contentFingerprint: actualContentFingerprint,
        error: diagnostic.message,
      };
    }
    const normalizedEditor = editorProjectStateSchema.safeParse({
      ...editorState,
      contentFingerprint: actualContentFingerprint,
    });
    if (!normalizedEditor.success) {
      const diagnostic = createProjectValidationDiagnostic({
        code: 'editor.metadata.invalid',
        severity: 'error',
        category: 'Project recovery',
        path: '/editor',
        message: 'Editor recovery metadata is invalid and was not written.',
        boundaries: ['authoring'],
        ownerPaths: ['/editor'],
      });
      return {
        ok: false,
        success: false,
        diagnostics: [diagnostic],
        error: diagnostic.message,
      };
    }
    await writeProjectAtomic({ ...content, editor: normalizedEditor.data }, projectFilePath);
    return {
      ok: true,
      success: true,
      diagnostics: [],
      contentFingerprint: actualContentFingerprint,
    };
  } catch (error) {
    return {
      ok: false,
      success: false,
      diagnostics: [],
      error: error instanceof Error ? error.message : 'Editor metadata save failed.',
    };
  }
}

export async function saveProjectContent(
  projectFilePath: string,
  expectedContentFingerprint: string,
  contentProject: unknown,
  editorState: EditorProjectState,
): Promise<SaveProjectResponse> {
  if (!projectFilePath || typeof projectFilePath !== 'string') {
    return {
      ok: false,
      success: false,
      error: 'Project content save requires a project file path.',
    };
  }
  try {
    const absolute = path.resolve(projectFilePath);
    const source = await fs.readFile(absolute, 'utf8');
    const parsed = JSON.parse(source) as unknown;
    if (!isRecord(parsed)) throw new Error('Project root must be an object.');
    const diskContent = stripEditorProjectState(parsed);
    const actualContentFingerprint = projectContentFingerprint(diskContent);
    if (actualContentFingerprint !== expectedContentFingerprint) {
      const diagnostic = createProjectValidationDiagnostic({
        code: 'editor.content-save.content-conflict',
        severity: 'error',
        category: 'Project save',
        path: '/',
        message:
          'Project content changed outside the editor. The selected save units were not written so the external changes remain untouched.',
        boundaries: ['authoring'],
        ownerPaths: ['/'],
      });
      return {
        ok: false,
        success: false,
        error: diagnostic.message,
        diagnostics: [diagnostic],
        contentFingerprint: actualContentFingerprint,
      };
    }

    const content = stripEditorProjectState(contentProject);
    if (!isRecord(content)) throw new Error('Project content root must be an object.');
    const contentFingerprint = projectContentFingerprint(content);
    const normalizedEditor = editorProjectStateSchema.safeParse({
      ...editorState,
      contentFingerprint,
    });
    if (!normalizedEditor.success) {
      const diagnostic = createProjectValidationDiagnostic({
        code: 'editor.content-save.metadata-invalid',
        severity: 'error',
        category: 'Project save',
        path: '/editor',
        message: 'Rebased editor recovery metadata is invalid and the project was not written.',
        boundaries: ['authoring'],
        ownerPaths: ['/editor'],
      });
      return {
        ok: false,
        success: false,
        error: diagnostic.message,
        diagnostics: [diagnostic],
      };
    }

    await writeProjectAtomic({ ...content, editor: normalizedEditor.data }, absolute);
    return {
      ok: true,
      success: true,
      projectPath: projectPathFromFile(absolute),
      projectFilePath: absolute,
      contentFingerprint,
      diagnostics: [],
    };
  } catch (error) {
    return {
      ok: false,
      success: false,
      error: error instanceof Error ? error.message : 'Project content save failed.',
    };
  }
}

export async function saveProjectCopyAs(
  owner: BrowserWindow | null,
  project: unknown,
  defaultPath: string | null = null,
  currentProjectFilePath: string | null = null,
  workingProjectAssetPaths: readonly string[] = [],
): Promise<SaveProjectResponse> {
  if (!owner) return { ok: false, success: false, error: 'No editor window is available.' };
  const result = await dialog.showSaveDialog(owner, {
    title: 'Save NovelTea Project Copy',
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
    ? await copyProjectAssets(project, currentProjectFilePath, absolute, workingProjectAssetPaths)
    : [];
  try {
    const normalized = projectWithCurrentEditorFingerprint(project);
    await writeProjectAtomic(normalized.project, absolute);
    return {
      ok: true,
      success: true,
      projectPath: projectPathFromFile(absolute),
      projectFilePath: absolute,
      contentFingerprint: normalized.contentFingerprint,
      diagnostics,
    };
  } catch (error) {
    return {
      ok: false,
      success: false,
      error: error instanceof Error ? error.message : 'Project copy save failed.',
      diagnostics,
    };
  }
}

export async function createProject(request: CreateProjectRequest): Promise<SaveProjectResponse> {
  const projectName = typeof request.projectName === 'string' ? request.projectName.trim() : '';
  const projectDirectory =
    typeof request.projectDirectory === 'string' ? request.projectDirectory.trim() : '';
  if (!projectName) return { ok: false, success: false, error: 'Project name is required.' };
  if (!projectDirectory)
    return { ok: false, success: false, error: 'Project directory is required.' };
  const projectId = safeProjectSlug(projectName);
  if (!projectId) {
    return {
      ok: false,
      success: false,
      error: 'Project name must contain at least one letter or number.',
    };
  }
  const absoluteDirectory = path.resolve(projectDirectory);
  const projectFilePath = path.join(absoluteDirectory, 'project.json');
  if (hasSpacePathSegment(absoluteDirectory) || hasSpacePathSegment(projectFilePath)) {
    return { ok: false, success: false, error: 'Project paths must not contain spaces.' };
  }
  try {
    const entries = await directoryEntries(absoluteDirectory);
    if (entries.length > 0) {
      return {
        ok: false,
        success: false,
        error: 'Project directory already exists and is not empty.',
      };
    }
    const project = createAuthoringProject({ id: projectId, name: projectName });
    return await saveProject(project, projectFilePath);
  } catch (error) {
    return {
      ok: false,
      success: false,
      error: error instanceof Error ? error.message : 'Project creation failed.',
    };
  }
}
