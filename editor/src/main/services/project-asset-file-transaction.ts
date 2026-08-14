import path from 'node:path';
import {
  NodeProjectWorkspaceFileSystem,
  NodeProjectWorkspaceProcessLiveness,
} from '../../shared/project-workspace/node-project-workspace-file-system';
import {
  PROJECT_WORKSPACE_ABSENT_REVISION,
  ProjectWorkspaceTransactionService,
  type ProjectWorkspaceExpectedRevision,
} from '../../shared/project-workspace/project-workspace-transaction';

function slashPath(value: string): string {
  return value.split(path.sep).join('/');
}

function transactionService(fileSystem: NodeProjectWorkspaceFileSystem) {
  return new ProjectWorkspaceTransactionService(
    fileSystem,
    new NodeProjectWorkspaceProcessLiveness(),
    process.pid,
  );
}

async function revisionAt(
  fileSystem: NodeProjectWorkspaceFileSystem,
  absolutePath: string,
): Promise<ProjectWorkspaceExpectedRevision> {
  try {
    return (await fileSystem.readFileRevision(absolutePath)).contentHash;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return PROJECT_WORKSPACE_ABSENT_REVISION;
    throw error;
  }
}

export async function readProjectAssetFileRevision(
  projectRoot: string,
  projectRelativePath: string,
): Promise<ProjectWorkspaceExpectedRevision> {
  const fileSystem = new NodeProjectWorkspaceFileSystem();
  const relative = slashPath(projectRelativePath);
  return revisionAt(fileSystem, fileSystem.joinPath(projectRoot, relative));
}

export async function writeProjectAssetFileTransaction(
  projectRoot: string,
  projectRelativePath: string,
  bytes: Uint8Array,
  operationLabel: string,
  expectedRevision: ProjectWorkspaceExpectedRevision,
): Promise<void> {
  const fileSystem = new NodeProjectWorkspaceFileSystem();
  const relative = slashPath(projectRelativePath);
  await transactionService(fileSystem).commit(projectRoot, {
    operationLabel,
    targets: [
      {
        path: relative,
        operation: 'write',
        expectedRevision,
        bytes,
      },
    ],
  });
}

export async function moveProjectAssetFileTransaction(
  projectRoot: string,
  sourceRelativePath: string,
  destinationRelativePath: string,
  operationLabel: string,
  destinationExpectedRevision: ProjectWorkspaceExpectedRevision,
): Promise<void> {
  const fileSystem = new NodeProjectWorkspaceFileSystem();
  const source = slashPath(sourceRelativePath);
  const destination = slashPath(destinationRelativePath);
  const sourceAbsolute = fileSystem.joinPath(projectRoot, source);
  const bytes = await fileSystem.readBytes(sourceAbsolute);
  const sourceExpectedRevision = (await fileSystem.readFileRevision(sourceAbsolute)).contentHash;
  await transactionService(fileSystem).commit(projectRoot, {
    operationLabel,
    targets: [
      {
        path: destination,
        operation: 'write',
        expectedRevision: destinationExpectedRevision,
        bytes,
      },
      {
        path: source,
        operation: 'delete',
        expectedRevision: sourceExpectedRevision,
      },
    ],
  });
}
