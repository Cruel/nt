export interface ProjectLoadPayload {
  document: unknown;
  savedDocument?: unknown;
  projectPath: string | null;
  projectFilePath: string | null;
  projectReadSessionId?: string | null;
  workspaceRevision?: string | null;
  scriptSourcePaths?: Record<string, string>;
}

export interface ProjectSaveMetadata {
  projectPath?: string;
  projectFilePath?: string;
  document?: unknown;
  workspaceRevision?: string;
  scriptSourcePaths?: Record<string, string>;
}

export interface ProjectHistoryCursorState {
  cursor: number;
  savedCursor: number;
}
