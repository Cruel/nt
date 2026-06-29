export interface ProjectLoadPayload {
  document: unknown | null;
  projectPath: string | null;
  projectFilePath: string | null;
}

export interface ProjectSaveMetadata {
  projectPath?: string;
  projectFilePath?: string;
}

export interface ProjectHistoryCursorState {
  cursor: number;
  savedCursor: number;
}
