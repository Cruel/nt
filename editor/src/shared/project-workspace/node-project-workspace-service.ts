import {
  NodeProjectWorkspaceFileSystem,
  NodeProjectWorkspaceProcessLiveness,
} from './node-project-workspace-file-system';
import { ProjectWorkspaceService } from './project-workspace-service';
import { ProjectWorkspaceTransactionService } from './project-workspace-transaction';

export function createNodeProjectWorkspaceService(): ProjectWorkspaceService {
  const fileSystem = new NodeProjectWorkspaceFileSystem();
  return new ProjectWorkspaceService(
    fileSystem,
    new ProjectWorkspaceTransactionService(
      fileSystem,
      new NodeProjectWorkspaceProcessLiveness(),
      process.pid,
    ),
  );
}
