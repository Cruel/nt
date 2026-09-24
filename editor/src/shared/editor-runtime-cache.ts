import type { PreparedRuntimeArtifact } from './project-schema/prepared-runtime-artifact';
import type { ProjectValidationDiagnostic } from './project-schema/project-validation';
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
        scope: 'persistent-canonical' | 'persistent-preview';
        status: 'hit' | 'prepared';
        observation?: RuntimeBuildCacheObservation;
      };
    }
  | {
      status: 'blocked';
      diagnostics: ProjectValidationDiagnostic[];
      buildContext: EditorRuntimeBuildContext;
      cache: {
        scope: 'persistent-canonical' | 'persistent-preview';
        status: 'prepared';
        observation?: RuntimeBuildCacheObservation;
      };
    }
  | {
      status: 'session-local';
      buildContext: EditorRuntimeBuildContext;
      reason: 'project-content-dirty' | 'pending-compilation-input';
    };
