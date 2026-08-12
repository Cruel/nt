import { createAuthoringProject } from '../project-schema/authoring-project';
import { parseEditorProjectState } from '../project-schema/editor-project-state';
import { ensureNovelTeaLocalStateIgnored, repairNovelTeaAgentBootstrap } from './agent-bootstrap';
import type { ProjectWorkspaceFileSystem } from './project-workspace-file-system';
import { projectWorkspaceFiles, type ProjectWorkspaceService } from './project-workspace-service';

export type NovelTeaProjectCreationFailureKind = 'conflict' | 'mutation' | 'internal';

export class NovelTeaProjectCreationError extends Error {
  constructor(
    readonly kind: NovelTeaProjectCreationFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'NovelTeaProjectCreationError';
  }
}

export interface CreateNovelTeaProjectOptions {
  readonly projectName: string;
  readonly projectDirectory: string;
  readonly beforeActivate?: () => Promise<void> | void;
}

export interface CreateNovelTeaProjectResult {
  readonly projectRoot: string;
  readonly projectFilePath: string;
  readonly projectId: string;
}

export function novelTeaProjectId(value: string): string | null {
  const stem = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return stem.length > 0 ? stem : null;
}

let creationSequence = 0;

async function uniqueSibling(
  fileSystem: ProjectWorkspaceFileSystem,
  destination: string,
  label: string,
): Promise<string> {
  const parent = fileSystem.dirname(destination);
  const base = destination.slice(parent.length).replace(/^[/\\]+/, '') || 'project';
  for (;;) {
    creationSequence += 1;
    const candidate = fileSystem.joinPath(
      parent,
      `.${base}.noveltea-${label}-${process.pid}-${creationSequence}`,
    );
    if (await fileSystem.createDirectoryExclusive(candidate)) return candidate;
  }
}

async function rejectSymlinkDestination(
  fileSystem: ProjectWorkspaceFileSystem,
  destination: string,
): Promise<void> {
  if ((await fileSystem.inspect(destination)) === 'missing') return;
  const parent = fileSystem.dirname(destination);
  const expected = fileSystem.joinPath(
    await fileSystem.realpath(parent),
    destination.slice(parent.length).replace(/^[/\\]+/, ''),
  );
  if ((await fileSystem.realpath(destination)) !== expected)
    throw new NovelTeaProjectCreationError(
      'conflict',
      'Project destination must not be a symbolic link.',
    );
}

export async function createNovelTeaProject(
  fileSystem: ProjectWorkspaceFileSystem,
  workspace: ProjectWorkspaceService,
  options: CreateNovelTeaProjectOptions,
): Promise<CreateNovelTeaProjectResult> {
  const projectName = options.projectName.trim();
  const destinationInput = options.projectDirectory.trim();
  if (!projectName) throw new NovelTeaProjectCreationError('mutation', 'Project name is required.');
  if (!destinationInput)
    throw new NovelTeaProjectCreationError('mutation', 'Project directory is required.');
  const projectId = novelTeaProjectId(projectName);
  if (!projectId)
    throw new NovelTeaProjectCreationError(
      'mutation',
      'Project name must contain at least one letter or number.',
    );

  const destination = fileSystem.resolvePath(destinationInput);
  await rejectSymlinkDestination(fileSystem, destination);
  const destinationKind = await fileSystem.inspect(destination);
  if (destinationKind !== 'missing')
    throw new NovelTeaProjectCreationError(
      'conflict',
      'Project destination already exists. Choose a new folder.',
    );

  await fileSystem.createDirectory(fileSystem.dirname(destination));
  const staging = await uniqueSibling(fileSystem, destination, 'staging');
  try {
    const project = createAuthoringProject({ id: projectId, name: projectName });
    const editor = parseEditorProjectState(project.editor);
    for (const [relativePath, text] of Object.entries(projectWorkspaceFiles(project, editor)))
      await fileSystem.writeTextAtomic(fileSystem.joinPath(staging, relativePath), text);
    for (const directory of ['records', 'scripts', 'assets'])
      await fileSystem.createDirectory(fileSystem.joinPath(staging, directory));
    await ensureNovelTeaLocalStateIgnored(fileSystem, staging);
    await repairNovelTeaAgentBootstrap(fileSystem, staging);

    const opened = await workspace.open(staging);
    if (!opened.ok)
      throw new NovelTeaProjectCreationError(
        'internal',
        opened.diagnostics[0]?.message ?? 'Generated initial project failed validation.',
      );

    await options.beforeActivate?.();
    if ((await fileSystem.inspect(destination)) !== 'missing')
      throw new NovelTeaProjectCreationError(
        'conflict',
        'Project destination was created while the project was being prepared.',
      );
    await fileSystem.movePathAtomic(staging, destination);
    return {
      projectRoot: destination,
      projectFilePath: fileSystem.joinPath(destination, 'project.json'),
      projectId,
    };
  } catch (error) {
    if (error instanceof NovelTeaProjectCreationError) throw error;
    throw new NovelTeaProjectCreationError(
      'mutation',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if ((await fileSystem.inspect(staging)) !== 'missing')
      await fileSystem.removeDirectory(staging);
  }
}
