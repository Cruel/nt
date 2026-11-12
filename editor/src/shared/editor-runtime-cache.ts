import type { PreparedRuntimeArtifact } from './project-schema/prepared-runtime-artifact';
import type { ProjectValidationDiagnostic } from './project-schema/project-diagnostic-projection';
import type { RuntimeBuildCacheObservation } from './runtime-build-cache';
import type { ShaderVariant } from './shader-variants';

export type EditorRuntimeBuildContext =
  | { kind: 'canonical'; shaderVariant: ShaderVariant }
  | { kind: 'preview-locale'; locale: string; shaderVariant: ShaderVariant }
  | { kind: 'pseudo-preview-locale'; locale: string; shaderVariant: ShaderVariant };

export type EditorRuntimePreparationResult =
  | {
      status: 'prepared';
      artifact: PreparedRuntimeArtifact;
      buildContext: EditorRuntimeBuildContext;
      cache: {
        scope: 'persistent-canonical' | 'persistent-preview' | 'session-local';
        status: 'hit' | 'prepared';
        observation?: RuntimeBuildCacheObservation;
      };
    }
  | {
      status: 'blocked';
      diagnostics: ProjectValidationDiagnostic[];
      buildContext: EditorRuntimeBuildContext;
      cache: {
        scope: 'persistent-canonical' | 'persistent-preview' | 'session-local';
        status: 'prepared';
        observation?: RuntimeBuildCacheObservation;
      };
    }
  | {
      status: 'session-local';
      buildContext: EditorRuntimeBuildContext;
      reason: 'project-content-dirty' | 'pending-compilation-input';
    };

/** Main's preview-server registration projects physical package sources into
 * opaque, project-relative fetch identities before returning them to Play. */
export type EditorPreviewRuntimePreparationResult =
  | (Extract<EditorRuntimePreparationResult, { status: 'prepared' }> & {
      previewAssets: Array<{ sourcePath: string; runtimePath: string }>;
    })
  | Exclude<EditorRuntimePreparationResult, { status: 'prepared' }>;
