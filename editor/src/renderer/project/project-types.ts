export interface ProjectLoadPayload {
  document: unknown;
  savedDocument?: unknown;
  projectPath: string | null;
  projectFilePath: string | null;
  projectReadSessionId?: string | null;
}

export interface ProjectSaveMetadata {
  projectPath?: string;
  projectFilePath?: string;
  document?: unknown;
}

export interface ProjectHistoryCursorState {
  cursor: number;
  savedCursor: number;
}
