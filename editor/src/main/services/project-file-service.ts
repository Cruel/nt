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
  authoringProjectSchema,
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
import { createNodeProjectWorkspaceFileSystem } from '../../shared/project-workspace/node-project-workspace-file-system';
import { assertProjectWorkspacePathContained } from '../../shared/project-workspace/project-workspace-file-system';
import {
  ProjectWorkspaceService,
  projectWorkspaceFiles,
  projectWorkspaceLocalStateFile,
} from '../../shared/project-workspace/project-workspace-service';

export { projectContentFingerprint } from './project-content-fingerprint';

function workspaceService() {
  return new ProjectWorkspaceService(createNodeProjectWorkspaceFileSystem());
}

async function writeWorkspaceProject(
  projectRoot: string,
  project: unknown,
  editorState: EditorProjectState,
  expectedWorkspaceRevision: string,
  scriptSourcePaths: Readonly<Record<string, string>> = {},
): Promise<{ contentFingerprint: string; workspaceRevision: string }> {
  const workspace = workspaceService();
  const opened = await workspace.open(projectRoot);
  if (!opened.ok)
    throw new Error(opened.diagnostics[0]?.message ?? 'Project workspace is invalid.');
  if (opened.snapshot.workspaceRevision !== expectedWorkspaceRevision)
    throw new Error('Project content changed outside the editor.');
  const content = stripEditorProjectState(project);
  if (!isRecord(content)) throw new Error('Project content root must be an object.');
  const candidate = authoringProjectSchema.safeParse({ ...content, editor: editorState });
  if (!candidate.success) throw new Error('Project content is invalid.');
  const written = await workspace.write(
    projectRoot,
    expectedWorkspaceRevision,
    candidate.data,
    editorState,
    scriptSourcePaths,
  );
  return {
    contentFingerprint: projectContentFingerprint(content),
    workspaceRevision: written.workspaceRevision,
  };
}

async function assertContained(root: string, candidate: string): Promise<void> {
  await assertProjectWorkspacePathContained(
    createNodeProjectWorkspaceFileSystem(),
    root,
    candidate,
  );
}

async function writeContainedText(root: string, file: string, text: string): Promise<void> {
  await assertContained(root, file);
  await createNodeProjectWorkspaceFileSystem().writeTextAtomic(file, text);
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
    try {
      await assertContained(oldRoot, source);
      await assertContained(newRoot, destination);
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
      await assertContained(newRoot, path.dirname(destination));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await assertContained(newRoot, destination);
      await fs.copyFile(source, destination);
    } catch (error) {
      if (error instanceof Error && error.message.includes('escapes the project root')) throw error;
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

async function copyProjectWorkflows(oldProjectFilePath: string, newProjectFilePath: string) {
  const sourceRoot = projectPathFromFile(oldProjectFilePath);
  const destinationRoot = projectPathFromFile(newProjectFilePath);
  const copyDirectory = async (source: string, destination: string): Promise<void> => {
    await assertContained(sourceRoot, source);
    await assertContained(destinationRoot, destination);
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
      const childSource = path.join(source, entry.name);
      const childDestination = path.join(destination, entry.name);
      await assertContained(sourceRoot, childSource);
      await assertContained(destinationRoot, childDestination);
      if (entry.isDirectory()) {
        await fs.mkdir(childDestination, { recursive: true });
        await copyDirectory(childSource, childDestination);
      } else if (entry.isFile()) {
        await fs.mkdir(path.dirname(childDestination), { recursive: true });
        await assertContained(destinationRoot, childDestination);
        await fs
          .copyFile(childSource, childDestination, fs.constants.COPYFILE_EXCL)
          .catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          });
      } else {
        throw new Error(`Workflow '${entry.name}' is not a regular file or directory.`);
      }
    }
  };
  const source = path.join(sourceRoot, 'workflows');
  const destination = path.join(destinationRoot, 'workflows');
  try {
    await assertContained(sourceRoot, source);
    await assertContained(destinationRoot, destination);
    const stat = await fs.stat(source);
    if (stat.isDirectory() && path.resolve(source) !== path.resolve(destination))
      await copyDirectory(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function confirmNonEmptyDestination(
  owner: BrowserWindow,
  projectRoot: string,
): Promise<boolean> {
  const directory = path.resolve(projectRoot);
  const entries = await directoryEntries(directory);
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
    detail: `NovelTea projects store their source tree in the selected folder. Saving here may create or reuse project files in:\n\n${directory}\n\nExisting entries include: ${sample}${suffix}`,
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
    const root = projectPathFromFile(projectFilePath);
    const editor = parseEditorProjectState((normalized.project as Record<string, unknown>).editor);
    const opened = await workspaceService().open(root);
    if (!opened.ok)
      throw new Error(opened.diagnostics[0]?.message ?? 'Project workspace is invalid.');
    await writeWorkspaceProject(
      root,
      normalized.project,
      editor,
      opened.snapshot.workspaceRevision,
    );
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
  expectedWorkspaceRevision: string,
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
    const root = projectPathFromFile(projectFilePath);
    const opened = await workspaceService().open(root);
    if (!opened.ok)
      throw new Error(opened.diagnostics[0]?.message ?? 'Project workspace is invalid.');
    const content = opened.contentProject;
    const actualContentFingerprint = opened.contentFingerprint;
    if (opened.snapshot.workspaceRevision !== expectedWorkspaceRevision) {
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
    const written = await writeWorkspaceProject(
      root,
      content,
      normalizedEditor.data,
      expectedWorkspaceRevision,
    );
    return {
      ok: true,
      success: true,
      diagnostics: [],
      contentFingerprint: written.contentFingerprint,
      workspaceRevision: written.workspaceRevision,
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
  expectedWorkspaceRevision: string,
  contentProject: unknown,
  editorState: EditorProjectState,
  scriptSourcePaths: Readonly<Record<string, string>> = {},
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
    const root = projectPathFromFile(absolute);
    const opened = await workspaceService().open(root);
    if (!opened.ok)
      throw new Error(opened.diagnostics[0]?.message ?? 'Project workspace is invalid.');
    const actualContentFingerprint = opened.contentFingerprint;
    if (opened.snapshot.workspaceRevision !== expectedWorkspaceRevision) {
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

    const written = await writeWorkspaceProject(
      root,
      content,
      normalizedEditor.data,
      expectedWorkspaceRevision,
      scriptSourcePaths,
    );
    return {
      ok: true,
      success: true,
      projectPath: projectPathFromFile(absolute),
      projectFilePath: absolute,
      contentFingerprint: written.contentFingerprint,
      workspaceRevision: written.workspaceRevision,
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
  scriptSourcePaths: Readonly<Record<string, string>> = {},
): Promise<SaveProjectResponse> {
  if (!owner) return { ok: false, success: false, error: 'No editor window is available.' };
  const result = await dialog.showOpenDialog(owner, {
    title: 'Save NovelTea Project Copy',
    defaultPath: defaultPath ? projectPathFromFile(defaultPath) : undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  const selectedRoot = result.filePaths[0];
  if (result.canceled || !selectedRoot) {
    return { ok: false, success: false, error: 'Save canceled.' };
  }
  const root = path.resolve(selectedRoot);
  if (!(await confirmNonEmptyDestination(owner, root))) {
    return { ok: false, success: false, error: 'Save canceled.' };
  }
  let diagnostics: ToolDiagnostic[] = [];
  try {
    diagnostics = currentProjectFilePath
      ? await copyProjectAssets(
          project,
          currentProjectFilePath,
          path.join(root, 'project.json'),
          workingProjectAssetPaths,
        )
      : [];
    const manifestPath = path.join(root, 'project.json');
    if (currentProjectFilePath) await copyProjectWorkflows(currentProjectFilePath, manifestPath);
    const normalized = projectWithCurrentEditorFingerprint(project);
    const editor = parseEditorProjectState((normalized.project as Record<string, unknown>).editor);
    const sourcePaths = currentProjectFilePath
      ? await workspaceService().open(projectPathFromFile(currentProjectFilePath))
      : null;
    for (const [relativePath, text] of Object.entries(
      projectWorkspaceFiles(
        normalized.project as Parameters<typeof projectWorkspaceFiles>[0],
        editor,
        sourcePaths?.ok
          ? { ...sourcePaths.snapshot.scriptSourcePaths, ...scriptSourcePaths }
          : scriptSourcePaths,
      ),
    ))
      await writeContainedText(root, path.join(root, relativePath), text);
    const openedCopy = await workspaceService().open(root);
    if (!openedCopy.ok)
      throw new Error(openedCopy.diagnostics[0]?.message ?? 'Saved project copy is invalid.');
    await writeContainedText(
      root,
      path.join(root, '.noveltea/editor/state.json'),
      projectWorkspaceLocalStateFile(editor, openedCopy.snapshot.workspaceRevision),
    );
    await writeContainedText(root, path.join(root, '.gitignore'), '/.noveltea/\n');
    for (const directory of ['records', 'scripts', 'assets']) {
      const target = path.join(root, directory);
      await assertContained(root, target);
      await fs.mkdir(target, { recursive: true });
    }
    return {
      ok: true,
      success: true,
      projectPath: root,
      projectFilePath: manifestPath,
      contentFingerprint: normalized.contentFingerprint,
      workspaceRevision: openedCopy.snapshot.workspaceRevision,
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
    const fsPort = createNodeProjectWorkspaceFileSystem();
    const editor = parseEditorProjectState(project.editor);
    for (const [relativePath, text] of Object.entries(projectWorkspaceFiles(project, editor)))
      await fsPort.writeTextAtomic(path.join(absoluteDirectory, relativePath), text);
    await fs.mkdir(path.join(absoluteDirectory, 'records'), { recursive: true });
    await fs.mkdir(path.join(absoluteDirectory, 'scripts'), { recursive: true });
    await fs.mkdir(path.join(absoluteDirectory, 'assets'), { recursive: true });
    await fsPort.writeTextAtomic(path.join(absoluteDirectory, '.gitignore'), '/.noveltea/\n');
    return {
      ok: true,
      success: true,
      projectPath: absoluteDirectory,
      projectFilePath,
      contentFingerprint: projectContentFingerprint(project),
      diagnostics: [],
    };
  } catch (error) {
    return {
      ok: false,
      success: false,
      error: error instanceof Error ? error.message : 'Project creation failed.',
    };
  }
}
