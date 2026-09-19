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
  contentHash?: `sha256:${string}`;
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
  /** Author-managed physical folders beneath scripts/ and shaders/. */
  folders?: readonly string[];
}

export type ProjectSourceExpectedRevision = `sha256:${string}` | 'absent';

export interface ProjectSourceUsage {
  kind:
    | 'material-shader'
    | 'script-module'
    | 'shader-include'
    | 'layout-script-dependency'
    | 'layout-rml-script';
  owner: string;
  path: string;
  detail: string;
}

export type ProjectSourceStructuralOperation =
  | { kind: 'create-file'; path: string; fileKind: 'lua' | 'shader' }
  | { kind: 'create-folder'; path: string }
  | { kind: 'move'; fromPath: string; toPath: string }
  | { kind: 'delete'; path: string };

export interface ProjectSourceStructuralRequest {
  projectSessionId: string;
  operation: ProjectSourceStructuralOperation;
  expectedRevisions?: Readonly<Record<string, ProjectSourceExpectedRevision>>;
}

export interface ProjectSourceStructuralResponse {
  ok: boolean;
  success: boolean;
  error?: string;
  usages?: readonly ProjectSourceUsage[];
  pathRemap?: Readonly<Record<string, string>>;
  changedPaths?: readonly string[];
}

export interface ProjectSourceWriteRequest {
  projectSessionId: string;
  sourceId: string;
  expectedRevision: ProjectSourceExpectedRevision;
  text: string;
}

export interface ProjectSourceWriteResponse {
  ok: boolean;
  success: boolean;
  sourceId: string;
  contentHash?: `sha256:${string}`;
  error?: string;
}

export interface ProjectSourceUsageRequest {
  projectSessionId: string;
  path: string;
}

export interface ProjectSourceUsageResponse {
  usages: readonly ProjectSourceUsage[];
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
