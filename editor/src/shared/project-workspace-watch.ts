import type { EditorProjectState } from './project-schema/editor-project-state';
import type { ProjectValidationDiagnostic } from './project-schema/project-validation';

export interface ProjectWorkspaceWatchCandidate {
  readonly success: boolean;
  readonly diagnostics: readonly ProjectValidationDiagnostic[];
  readonly contentProject?: unknown;
  readonly savedContentProject?: unknown;
  readonly editorState?: EditorProjectState;
  readonly workspaceRevision?: string;
  readonly fileRevisions?: Readonly<Record<string, `sha256:${string}`>>;
  readonly scriptSourcePaths?: Readonly<Record<string, string>>;
}

export interface ProjectWorkspaceWatchEvent {
  readonly projectRoot: string;
  readonly manifestPath: string;
  readonly changedPaths: readonly string[];
  readonly assetAuditChanged: boolean;
  readonly candidate: ProjectWorkspaceWatchCandidate;
}
