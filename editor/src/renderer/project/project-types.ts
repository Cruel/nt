export interface ProjectLoadPayload {
  document: unknown;
  savedDocument?: unknown;
  projectPath: string | null;
  projectFilePath: string | null;
  projectSessionId?: string | null;
  workspaceRevision?: string | null;
  fileRevisions?: Record<string, `sha256:${string}`>;
  scriptSourcePaths?: Record<string, string>;
}

export interface ProjectSaveMetadata {
  projectPath?: string;
  projectFilePath?: string;
  document?: unknown;
  workspaceRevision?: string;
  fileRevisions?: Record<string, `sha256:${string}`>;
  scriptSourcePaths?: Record<string, string>;
}

export interface ProjectHistoryCursorState {
  cursor: number;
  savedCursor: number;
}
