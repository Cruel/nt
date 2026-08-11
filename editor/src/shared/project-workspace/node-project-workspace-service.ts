import { randomUUID } from 'node:crypto';
import {
  NodeProjectWorkspaceFileSystem,
  NodeProjectWorkspaceProcessLiveness,
} from './node-project-workspace-file-system';
import type { ProjectWorkspaceFileSystem } from './project-workspace-file-system';
import { ProjectWorkspaceService } from './project-workspace-service';
import { ProjectWorkspaceTransactionService } from './project-workspace-transaction';

export function createHostProjectWorkspaceService(
  fileSystem: ProjectWorkspaceFileSystem,
): ProjectWorkspaceService {
  return new ProjectWorkspaceService(
    fileSystem,
    new ProjectWorkspaceTransactionService(
      fileSystem,
      new NodeProjectWorkspaceProcessLiveness(),
      process.pid,
      randomUUID,
    ),
  );
}

export function createNodeProjectWorkspaceService(): ProjectWorkspaceService {
  return createHostProjectWorkspaceService(new NodeProjectWorkspaceFileSystem());
}
