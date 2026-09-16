import type { PreparedRuntimeArtifact } from './project-schema/prepared-runtime-artifact';
import type { ProjectValidationDiagnostic } from './project-schema/project-validation';
import type { RuntimeBuildCacheObservation } from './runtime-build-cache';

export type EditorRuntimeBuildContext =
  | { kind: 'canonical' }
  | { kind: 'preview-locale'; locale: string }
  | { kind: 'pseudo-preview-locale'; locale: string };

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
