import type { ProjectMutationPathValue } from './editor-tooling';
import type { ProjectValidationDiagnostic } from './project-schema/project-validation';

export type ProjectWorkspaceAuthoringWatchResult =
  | {
      readonly success: true;
      readonly diagnostics: readonly ProjectValidationDiagnostic[];
      readonly affectedPaths: readonly string[];
      readonly externalValueByPath: Readonly<Record<string, ProjectMutationPathValue>>;
      readonly fileRevisions: Readonly<Record<string, `sha256:${string}` | 'absent'>>;
      readonly scriptSourcePaths: Readonly<Record<string, string>>;
    }
  | {
      readonly success: false;
      readonly diagnostics: readonly ProjectValidationDiagnostic[];
    };

export interface ProjectWorkspaceWatchEvent {
  readonly projectSessionId: string;
  readonly changedPaths: readonly string[];
  readonly authoringChangedPaths: readonly string[];
  readonly assetChangedPaths: readonly string[];
  readonly assetFileRevisions?: Readonly<Record<string, `sha256:${string}` | 'absent'>>;
  readonly assetDiagnostics?: readonly ProjectValidationDiagnostic[];
  readonly authoring?: ProjectWorkspaceAuthoringWatchResult;
}

export function shouldReconcileProjectWorkspaceWatchEvent(
  event: ProjectWorkspaceWatchEvent,
): boolean {
  return Boolean(event.authoring?.success && event.authoring.affectedPaths.length > 0);
}
