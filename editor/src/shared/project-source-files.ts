export type ProjectSourceFileKind =
  | 'lua'
  | 'shader'
  | 'asset'
  | 'layout-rml'
  | 'layout-rcss'
  | 'layout-lua';

export interface ProjectSourceFile {
  /** Stable author-facing identity. Shader/Lua files use their normalized project-relative path. */
  id: string;
  /** Path shown in Files/search. Never exposes records/... storage for projected Layout source. */
  displayPath: string;
  /** Physical contained Project path used by the main-owned source authority. */
  projectRelativePath: string;
  kind: ProjectSourceFileKind;
  text: boolean;
  assetIds?: readonly string[];
  layout?: {
    id: string;
    channel: 'rml' | 'rcss' | 'lua';
  };
}

export interface ListProjectSourceFilesRequest {
  projectSessionId: string;
}

export interface ListProjectSourceFilesResponse {
  files: readonly ProjectSourceFile[];
}

export function sourceFileLanguage(
  source: Pick<ProjectSourceFile, 'kind'>,
): 'lua' | 'rml' | 'rcss' | 'shader' | 'text' {
  if (source.kind === 'lua' || source.kind === 'layout-lua') return 'lua';
  if (source.kind === 'layout-rml') return 'rml';
  if (source.kind === 'layout-rcss') return 'rcss';
  if (source.kind === 'shader') return 'shader';
  return 'text';
}

export function projectSourceStableId(sourceId: string): string {
  return `source:${sourceId}`;
}
