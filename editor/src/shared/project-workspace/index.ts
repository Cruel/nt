export {
  createNodeProjectWorkspaceFileSystem,
  NodeProjectWorkspaceFileSystem,
  NodeProjectWorkspaceProcessLiveness,
} from './node-project-workspace-file-system';
export {
  assertProjectWorkspacePathContained,
  type ProjectWorkspaceFileSystem,
  type ProjectWorkspaceProcessLiveness,
} from './project-workspace-file-system';
export {
  PROJECT_WORKSPACE_ABSENT_REVISION,
  PROJECT_WORKSPACE_TRANSACTION_SCHEMA,
  PROJECT_WORKSPACE_TRANSACTION_SCHEMA_VERSION,
  ProjectWorkspaceMutationError,
  ProjectWorkspaceTransactionService,
  utf8WorkspaceTransactionTarget,
  type ProjectWorkspaceExpectedRevision,
  type ProjectWorkspaceTransactionRequest,
  type ProjectWorkspaceTransactionTargetInput,
} from './project-workspace-transaction';
export { InMemoryProjectWorkspaceFileSystem } from './testing';
export { createNodeProjectWorkspaceService } from './node-project-workspace-service';
export {
  discoverProjectRoot,
  validateExplicitProjectRoot,
  type ProjectWorkspaceDiscoveryCode,
  type ProjectWorkspaceDiscoveryResult,
} from './project-workspace-discovery';
export { searchProjectWorkspaceSnapshot } from './project-workspace-search';
export {
  analyzeProjectWorkspaceSources,
  buildProjectWorkspaceSearchIndex,
  collectProjectWorkspaceLuaSources,
  compareProjectWorkspaceUnicodeCodePoints,
  createProjectWorkspaceSnapshot,
  projectWorkspaceFiles,
  projectWorkspaceLocalStateFile,
  PROJECT_WORKSPACE_SCHEMA,
  PROJECT_WORKSPACE_SCHEMA_VERSION,
  EDITOR_LOCAL_STATE_SCHEMA,
  EDITOR_LOCAL_STATE_SCHEMA_VERSION,
  publishProjectWorkspaceSnapshot,
  ProjectWorkspaceService,
  type ProjectWorkspaceFileRevision,
  type LoadedProjectWorkspaceSnapshot,
  type ProjectWorkspaceOpenResult,
  type ProjectWorkspaceOpenOptions,
  type ProjectWorkspaceSaveUnitFileOwnership,
  type ProjectWorkspaceSnapshot,
  type ProjectWorkspaceWriteOptions,
} from './project-workspace-service';
