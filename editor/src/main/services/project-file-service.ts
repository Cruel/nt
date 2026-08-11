import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import type {
  CreateProjectRequest,
  SaveProjectEditorMetadataResponse,
  SaveProjectResponse,
  ProjectWorkspaceCommitOptions,
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
import { createNodeProjectWorkspaceFileSystem } from '../../shared/project-workspace/node-project-workspace-file-system';
import { createNodeProjectWorkspaceService } from '../../shared/project-workspace/node-project-workspace-service';
import { assertProjectWorkspacePathContained } from '../../shared/project-workspace/project-workspace-file-system';
import {
  ensureNovelTeaLocalStateIgnored,
  NOVELTEA_PROJECT_AGENTS_BOOTSTRAP,
} from '../../shared/project-workspace/agent-bootstrap';
import {
  createProjectWorkspaceSnapshot,
  projectWorkspaceFiles,
  projectWorkspaceLocalStateFile,
  type LoadedProjectWorkspaceSnapshot,
} from '../../shared/project-workspace/project-workspace-service';
import {
  PROJECT_WORKSPACE_ABSENT_REVISION,
  ProjectWorkspaceMutationError,
  type ProjectWorkspaceExpectedRevision,
  type ProjectWorkspaceTransactionTargetInput,
} from '../../shared/project-workspace/project-workspace-transaction';

function mutationFailureDiagnostic(error: ProjectWorkspaceMutationError): ToolDiagnostic {
  return {
    code: error.code,
    severity: 'error',
    category: 'Project workspace',
    path: '/.noveltea/transactions',
    message: error.message,
  };
}

function isSafeGeneratedAssetTrashPath(value: string): boolean {
  return (
    value.startsWith('.noveltea/trash/assets/') &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !/^[A-Za-z]:/.test(value) &&
    value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

function workspaceService() {
  return createNodeProjectWorkspaceService();
}

function snapshotFileRevisions(snapshot: LoadedProjectWorkspaceSnapshot) {
  return Object.fromEntries(
    Object.entries(snapshot.fileRevisions).map(([file, revision]) => [file, revision.contentHash]),
  ) as Record<string, `sha256:${string}`>;
}

function filesForSaveUnits(
  before: LoadedProjectWorkspaceSnapshot,
  project: Parameters<typeof createProjectWorkspaceSnapshot>[0],
  scriptSourcePaths: Readonly<Record<string, string>>,
  saveUnitIds: readonly string[],
): string[] {
  const after = createProjectWorkspaceSnapshot(project, scriptSourcePaths);
  const files = new Set<string>();
  for (const saveUnitId of saveUnitIds) {
    for (const file of before.saveUnitFileOwnership[saveUnitId]?.files ?? []) files.add(file);
    for (const file of after.saveUnitFileOwnership[saveUnitId]?.files ?? []) files.add(file);
  }
  return [...files].sort();
}

function pointerSegments(pointer: string): string[] {
  return pointer
    .slice(1)
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function valueAtPointer(root: unknown, pointer: string): { present: boolean; value?: unknown } {
  let current = root;
  for (const segment of pointerSegments(pointer)) {
    if (!isRecord(current) || !(segment in current)) return { present: false };
    current = current[segment];
  }
  return { present: true, value: current };
}

function replaceAtPointer(root: Record<string, unknown>, pointer: string, source: unknown) {
  const segments = pointerSegments(pointer);
  if (segments.length === 0) return;
  const selected = valueAtPointer(source, pointer);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const nested = current[segment];
    if (!isRecord(nested)) {
      if (!selected.present) return;
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  const key = segments.at(-1)!;
  if (selected.present) current[key] = structuredClone(selected.value);
  else delete current[key];
}

function scopedCandidate(
  before: LoadedProjectWorkspaceSnapshot,
  candidate: Parameters<typeof createProjectWorkspaceSnapshot>[0],
  scriptSourcePaths: Readonly<Record<string, string>>,
  saveUnitIds: readonly string[],
) {
  const after = createProjectWorkspaceSnapshot(candidate, scriptSourcePaths);
  const merged = structuredClone(before.project) as unknown as Record<string, unknown>;
  for (const saveUnitId of saveUnitIds) {
    const paths = new Set([
      ...(before.saveUnitFileOwnership[saveUnitId]?.paths ?? []),
      ...(after.saveUnitFileOwnership[saveUnitId]?.paths ?? []),
    ]);
    for (const pointer of paths) replaceAtPointer(merged, pointer, candidate);
  }
  return authoringProjectSchema.parse(merged);
}

function candidateAtPaths(
  before: LoadedProjectWorkspaceSnapshot,
  candidate: Parameters<typeof createProjectWorkspaceSnapshot>[0],
  paths: readonly string[],
) {
  const merged = structuredClone(before.project) as unknown as Record<string, unknown>;
  for (const pointer of paths) replaceAtPointer(merged, pointer, candidate);
  return authoringProjectSchema.parse(merged);
}

function changedProjectionFiles(
  baseline: Parameters<typeof createProjectWorkspaceSnapshot>[0],
  candidate: Parameters<typeof createProjectWorkspaceSnapshot>[0],
  baselineSourcePaths: Readonly<Record<string, string>>,
  candidateSourcePaths: Readonly<Record<string, string>>,
) {
  const beforeFiles = projectWorkspaceFiles(baseline, baseline.editor, baselineSourcePaths);
  const afterFiles = projectWorkspaceFiles(candidate, candidate.editor, candidateSourcePaths);
  return [...new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)])]
    .filter((file) => beforeFiles[file] !== afterFiles[file])
    .sort();
}

function scopedExpectedRevisions(
  opened: LoadedProjectWorkspaceSnapshot,
  commitOptions: ProjectWorkspaceCommitOptions | undefined,
) {
  const expected: Record<string, ProjectWorkspaceExpectedRevision> = {
    ...(commitOptions?.expectedFileRevisions ?? snapshotFileRevisions(opened)),
  };
  if (!commitOptions || !commitOptions.baselineProject) return expected;
  const baseline = authoringProjectSchema.safeParse(commitOptions.baselineProject);
  if (!baseline.success) return expected;
  if (commitOptions.structural) return expected;
  const exactChangedPaths = commitOptions.affectedPaths ?? [];
  if (exactChangedPaths.length > 0) {
    const exactPathsAreUnchanged = exactChangedPaths.every((pointer) => {
      const disk = valueAtPointer(opened.project, pointer);
      const base = valueAtPointer(baseline.data, pointer);
      return (
        disk.present === base.present && JSON.stringify(disk.value) === JSON.stringify(base.value)
      );
    });
    if (!exactPathsAreUnchanged)
      throw new ProjectWorkspaceMutationError(
        'WORKSPACE_REVISION_CONFLICT',
        'A selected save path changed outside the editor.',
      );
  }
  for (const saveUnitId of commitOptions.saveUnitIds ?? []) {
    const ownership = opened.saveUnitFileOwnership[saveUnitId];
    if (!ownership) continue;
    if (exactChangedPaths.length === 0) {
      const selectedPathsAreUnchanged = ownership.paths.every((pointer) => {
        const disk = valueAtPointer(opened.project, pointer);
        const base = valueAtPointer(baseline.data, pointer);
        return (
          disk.present === base.present && JSON.stringify(disk.value) === JSON.stringify(base.value)
        );
      });
      if (!selectedPathsAreUnchanged)
        throw new ProjectWorkspaceMutationError(
          'WORKSPACE_REVISION_CONFLICT',
          `Save unit '${saveUnitId}' changed outside the editor.`,
        );
    }
    for (const file of ownership.files)
      expected[file] = opened.fileRevisions[file]?.contentHash ?? PROJECT_WORKSPACE_ABSENT_REVISION;
  }
  return expected;
}

async function writeWorkspaceProject(
  projectRoot: string,
  project: unknown,
  editorState: EditorProjectState,
  expectedWorkspaceRevision: string,
  scriptSourcePaths: Readonly<Record<string, string>> = {},
  commitOptions?: ProjectWorkspaceCommitOptions,
): Promise<{
  workspaceRevision: string;
  fileRevisions: Record<string, `sha256:${string}`>;
  contentProject: unknown;
  editorState: EditorProjectState;
  scriptSourcePaths: Record<string, string>;
  assetTrashMoves: import('../../shared/project-asset-audit').ProjectAssetTrashMove[];
}> {
  const workspace = workspaceService();
  const opened = await workspace.open(projectRoot);
  if (!opened.ok)
    throw new Error(opened.diagnostics[0]?.message ?? 'Project workspace is invalid.');
  if (!commitOptions && opened.snapshot.workspaceRevision !== expectedWorkspaceRevision)
    throw new Error('Project content changed outside the editor.');
  const content = stripEditorProjectState(project);
  if (!isRecord(content)) throw new Error('Project content root must be an object.');
  const candidate = authoringProjectSchema.safeParse({ ...content, editor: editorState });
  if (!candidate.success) throw new Error('Project content is invalid.');
  const sourcePaths = { ...opened.snapshot.scriptSourcePaths, ...scriptSourcePaths };
  const baseline = commitOptions?.baselineProject
    ? authoringProjectSchema.safeParse(commitOptions.baselineProject)
    : null;
  const projectForWrite =
    commitOptions?.structural && commitOptions.affectedPaths
      ? candidateAtPaths(opened.snapshot, candidate.data, commitOptions.affectedPaths)
      : commitOptions && !commitOptions.structural && commitOptions.affectedPaths?.length
        ? candidateAtPaths(opened.snapshot, candidate.data, commitOptions.affectedPaths)
        : commitOptions && !commitOptions.structural
          ? scopedCandidate(
              opened.snapshot,
              candidate.data,
              sourcePaths,
              commitOptions.saveUnitIds ?? [],
            )
          : candidate.data;
  const editorStateForWrite: EditorProjectState = {
    ...editorState,
    chapters: projectForWrite.editor.chapters,
    tags: projectForWrite.editor.tags,
    recordMetadata: projectForWrite.editor.recordMetadata,
  };
  const transactionId = randomUUID();
  const extraTargets: ProjectWorkspaceTransactionTargetInput[] = [];
  const assetTrashMoves: import('../../shared/project-asset-audit').ProjectAssetTrashMove[] = [];
  if (commitOptions?.assetTransition?.kind === 'trash') {
    for (const assetPath of [...commitOptions.assetTransition.projectRelativePaths].sort()) {
      if (!isSafeProjectAssetPath(assetPath))
        throw new ProjectWorkspaceMutationError(
          'WORKSPACE_PATH_INVALID',
          `Asset transaction path '${assetPath}' is invalid.`,
        );
      const source = path.join(projectRoot, assetPath);
      await assertContained(projectRoot, source);
      const bytes = await createNodeProjectWorkspaceFileSystem().readBytes(source);
      const trashRelativePath = `.noveltea/trash/assets/${transactionId}/${assetPath}`;
      extraTargets.push({
        path: trashRelativePath,
        operation: 'write',
        expectedRevision: PROJECT_WORKSPACE_ABSENT_REVISION,
        bytes,
      });
      extraTargets.push({
        path: assetPath,
        operation: 'delete',
        expectedRevision:
          commitOptions.expectedFileRevisions[assetPath] ??
          opened.snapshot.fileRevisions[assetPath]?.contentHash ??
          PROJECT_WORKSPACE_ABSENT_REVISION,
      });
      assetTrashMoves.push({ projectRelativePath: assetPath, trashRelativePath });
    }
  } else if (commitOptions?.assetTransition?.kind === 'restore') {
    for (const move of [...commitOptions.assetTransition.moves].sort((a, b) =>
      a.projectRelativePath.localeCompare(b.projectRelativePath),
    )) {
      if (
        !isSafeProjectAssetPath(move.projectRelativePath) ||
        !isSafeGeneratedAssetTrashPath(move.trashRelativePath)
      )
        throw new ProjectWorkspaceMutationError(
          'WORKSPACE_PATH_INVALID',
          'Asset restore transaction contains an invalid source or trash path.',
        );
      const trashPath = path.join(projectRoot, move.trashRelativePath);
      await assertContained(projectRoot, trashPath);
      const bytes = await createNodeProjectWorkspaceFileSystem().readBytes(trashPath);
      const trashRevision = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
      extraTargets.push({
        path: move.projectRelativePath,
        operation: 'write',
        expectedRevision: PROJECT_WORKSPACE_ABSENT_REVISION,
        bytes,
      });
      extraTargets.push({
        path: move.trashRelativePath,
        operation: 'delete',
        expectedRevision: trashRevision,
      });
    }
  }
  const targetFiles = !commitOptions
    ? undefined
    : commitOptions.structural && baseline?.success
      ? changedProjectionFiles(
          baseline.data,
          projectForWrite,
          opened.snapshot.scriptSourcePaths,
          sourcePaths,
        )
      : commitOptions.structural
        ? undefined
        : filesForSaveUnits(
            opened.snapshot,
            projectForWrite,
            sourcePaths,
            commitOptions.saveUnitIds ?? [],
          );
  const expectedFileRevisions = scopedExpectedRevisions(opened.snapshot, commitOptions);
  const structuralPathsAreUnchanged =
    commitOptions?.structural &&
    baseline?.success &&
    commitOptions.affectedPaths?.every((pointer) => {
      const disk = valueAtPointer(opened.snapshot.project, pointer);
      const base = valueAtPointer(baseline.data, pointer);
      return (
        disk.present === base.present && JSON.stringify(disk.value) === JSON.stringify(base.value)
      );
    });
  if (structuralPathsAreUnchanged)
    for (const file of targetFiles ?? []) {
      expectedFileRevisions[file] =
        opened.snapshot.fileRevisions[file]?.contentHash ?? PROJECT_WORKSPACE_ABSENT_REVISION;
    }
  else if (commitOptions?.structural && baseline?.success && commitOptions.affectedPaths)
    throw new ProjectWorkspaceMutationError(
      'WORKSPACE_REVISION_CONFLICT',
      'A structural command target changed outside the editor.',
    );
  const written = await workspace.write(
    projectRoot,
    expectedWorkspaceRevision,
    projectForWrite,
    editorStateForWrite,
    scriptSourcePaths,
    {
      transactionId,
      expectedFileRevisions,
      targetFiles,
      operationLabel: commitOptions?.operationLabel ?? 'project save',
      extraTargets,
    },
  );
  const refreshed = await workspace.open(projectRoot);
  if (!refreshed.ok) throw new Error('Saved workspace could not be reopened.');
  return {
    workspaceRevision: written.workspaceRevision,
    fileRevisions: snapshotFileRevisions(refreshed.snapshot),
    contentProject: refreshed.contentProject,
    editorState: refreshed.editorState,
    scriptSourcePaths: { ...refreshed.snapshot.scriptSourcePaths },
    assetTrashMoves,
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

function projectWithCurrentEditorState(project: unknown): unknown {
  const content = stripEditorProjectState(project);
  if (!isRecord(content)) return project;
  const rawEditor = isRecord(project) ? project.editor : undefined;
  const editor = parseEditorProjectState(rawEditor);
  return { ...content, editor };
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
  const normalized = projectWithCurrentEditorState(project);
  const errors = validationErrors(normalized);
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
    const editor = parseEditorProjectState((normalized as Record<string, unknown>).editor);
    const opened = await workspaceService().open(root);
    if (!opened.ok)
      throw new Error(opened.diagnostics[0]?.message ?? 'Project workspace is invalid.');
    await writeWorkspaceProject(root, normalized, editor, opened.snapshot.workspaceRevision);
    const absolute = path.resolve(projectFilePath);
    return {
      ok: true,
      success: true,
      projectPath: projectPathFromFile(absolute),
      projectFilePath: absolute,
      diagnostics: [],
    };
  } catch (error) {
    return {
      ok: false,
      success: false,
      error: error instanceof Error ? error.message : 'Project save failed.',
      diagnostics:
        error instanceof ProjectWorkspaceMutationError
          ? [mutationFailureDiagnostic(error)]
          : undefined,
    };
  }
}

export async function saveProjectEditorMetadata(
  projectFilePath: string,
  expectedWorkspaceRevision: string,
  editorState: EditorProjectState,
  expectedFileRevisions: Record<string, `sha256:${string}`> = {},
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
    const workspace = workspaceService();
    const opened = await workspace.open(root);
    if (!opened.ok)
      throw new Error(opened.diagnostics[0]?.message ?? 'Project workspace is invalid.');
    const normalizedEditor = editorProjectStateSchema.safeParse(editorState);
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
    // Local recovery/session metadata is outside canonical workspace content. Persist it against the
    // renderer's known baseline without adopting any tracked-file revisions that may have changed on
    // disk before the workspace watcher has reconciled them.
    await workspace.writeEditorLocalState(root, expectedWorkspaceRevision, normalizedEditor.data);
    return {
      ok: true,
      success: true,
      diagnostics: [],
      workspaceRevision: expectedWorkspaceRevision,
      fileRevisions: { ...expectedFileRevisions },
    };
  } catch (error) {
    return {
      ok: false,
      success: false,
      diagnostics:
        error instanceof ProjectWorkspaceMutationError ? [mutationFailureDiagnostic(error)] : [],
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
  commitOptions?: ProjectWorkspaceCommitOptions,
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
    if (!commitOptions && opened.snapshot.workspaceRevision !== expectedWorkspaceRevision) {
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
      };
    }

    const content = stripEditorProjectState(contentProject);
    if (!isRecord(content)) throw new Error('Project content root must be an object.');
    const normalizedEditor = editorProjectStateSchema.safeParse(editorState);
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
      commitOptions,
    );
    return {
      ok: true,
      success: true,
      projectPath: projectPathFromFile(absolute),
      projectFilePath: absolute,
      workspaceRevision: written.workspaceRevision,
      fileRevisions: written.fileRevisions,
      contentProject: written.contentProject,
      editorState: written.editorState,
      scriptSourcePaths: written.scriptSourcePaths,
      assetTrashMoves: written.assetTrashMoves,
      diagnostics: [],
    };
  } catch (error) {
    return {
      ok: false,
      success: false,
      error: error instanceof Error ? error.message : 'Project content save failed.',
      diagnostics:
        error instanceof ProjectWorkspaceMutationError
          ? [mutationFailureDiagnostic(error)]
          : undefined,
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
    const normalized = projectWithCurrentEditorState(project);
    const editor = parseEditorProjectState((normalized as Record<string, unknown>).editor);
    const sourcePaths = currentProjectFilePath
      ? await workspaceService().open(projectPathFromFile(currentProjectFilePath))
      : null;
    for (const [relativePath, text] of Object.entries(
      projectWorkspaceFiles(
        normalized as Parameters<typeof projectWorkspaceFiles>[0],
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
    const fsPort = createNodeProjectWorkspaceFileSystem();
    await ensureNovelTeaLocalStateIgnored(fsPort, root);
    if (currentProjectFilePath) {
      const sourceAgents = path.join(projectPathFromFile(currentProjectFilePath), 'AGENTS.md');
      if ((await fsPort.inspect(sourceAgents)) === 'file')
        await writeContainedText(
          root,
          path.join(root, 'AGENTS.md'),
          await fsPort.readText(sourceAgents),
        );
    }
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
      workspaceRevision: openedCopy.snapshot.workspaceRevision,
      fileRevisions: snapshotFileRevisions(openedCopy.snapshot),
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
    await ensureNovelTeaLocalStateIgnored(fsPort, absoluteDirectory);
    await fsPort.writeTextAtomic(
      path.join(absoluteDirectory, 'AGENTS.md'),
      NOVELTEA_PROJECT_AGENTS_BOOTSTRAP,
    );
    return {
      ok: true,
      success: true,
      projectPath: absoluteDirectory,
      projectFilePath,
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
