export interface ProjectLoadPayload {
  document: unknown;
  nativeSession?: boolean;
  savedDocument?: unknown;
  projectPath: string | null;
  projectFilePath: string | null;
  projectSessionId?: string | null;
  scriptSourcePaths?: Record<string, string>;
}

export interface ProjectSaveMetadata {
  projectPath?: string;
  projectFilePath?: string;
  document?: unknown;
  scriptSourcePaths?: Record<string, string>;
}

export interface ProjectHistoryCursorState {
  cursor: number;
  savedCursor: number;
}
