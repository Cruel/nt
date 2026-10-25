export {
  PROJECT_WORKSPACE_SCHEMA,
  PROJECT_WORKSPACE_SCHEMA_VERSION,
} from '../schema-static-contracts';
export const EDITOR_LOCAL_STATE_SCHEMA = 'noveltea.editor.local-state' as const;

import type { AuthoringProject } from '../project-schema/authoring-project';
import type { EditorProjectState } from '../project-schema/editor-project-state';
import type { ProjectValidationDiagnostic } from '../project-schema/project-diagnostic-projection';
import type { YamlCommentImpact } from './yaml-comment-impact';

export interface ProjectWorkspaceFileRevision {
  readonly contentHash: `sha256:${string}`;
  readonly byteSize: number;
}

export interface ProjectWorkspaceSnapshot {
  readonly snapshotKind: 'loaded' | 'working-copy';
  readonly projectRoot: string | null;
  readonly manifestPath: string | null;
  readonly project: AuthoringProject;
  readonly workspaceRevision: `sha256:${string}`;
  readonly sourceRevision: `sha256:${string}`;
  readonly canonicalSourceFiles: readonly string[];
  readonly fileRevisions: Readonly<Record<string, ProjectWorkspaceFileRevision>>;
  readonly scriptSourcePaths: Readonly<Record<string, string>>;
}

export interface LoadedProjectWorkspaceSnapshot extends ProjectWorkspaceSnapshot {
  readonly snapshotKind: 'loaded';
  readonly projectRoot: string;
  readonly manifestPath: string;
}

export interface ProjectWorkspaceSourceWork {
  readonly authoredFilesReread: number;
  readonly parsedJsonSources: number;
  readonly reusedJsonSources: number;
  readonly readTextSources: number;
  readonly reusedTextSources: number;
  readonly projectedJsonSources: number;
  readonly wholeProjectSchemaParses: number;
  readonly fullProjectTraversals: number;
  readonly fullProjectProjections: number;
  readonly foregroundSerializations: number;
  readonly foregroundSerializedBytes: number;
  readonly localizationCoverageInputsChanged: boolean;
  readonly localizationCoverageDependencyRevision: `sha256:${string}`;
}

export type ProjectWorkspaceOpenResult =
  | {
      readonly ok: true;
      readonly snapshot: LoadedProjectWorkspaceSnapshot;
      readonly diagnostics: readonly ProjectValidationDiagnostic[];
      readonly editorState: EditorProjectState;
      readonly repairs: readonly never[];
      readonly contentProject: unknown;
      readonly savedContentProject: unknown;
      readonly sourceWork: ProjectWorkspaceSourceWork;
    }
  | {
      readonly ok: false;
      readonly projectRoot: string;
      readonly manifestPath: string;
      readonly diagnostics: readonly ProjectValidationDiagnostic[];
    };

export interface ProjectWorkspaceCommentImpact extends YamlCommentImpact {
  readonly file: string;
}

export interface ProjectWorkspaceCommentNotice {
  readonly file: string;
  readonly path: string;
  readonly comment: string;
  readonly oldId: string;
}
