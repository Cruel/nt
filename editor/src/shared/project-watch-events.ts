import type { ProjectMutationPathValue } from './editor-tooling';
import type { ProjectValidationDiagnostic } from './project-schema/project-diagnostic-projection';
import type { ProjectSourceExpectedRevision } from './project-source-files';

/** Renderer-facing event contract. This carries a native-authoritative event
 * projection; it does not own Project observation, parsing or reconciliation. */
export type ProjectWorkspaceAuthoringWatchResult =
  | {
      readonly success: true;
      readonly diagnostics: readonly ProjectValidationDiagnostic[];
      readonly affectedPaths: readonly string[];
      readonly externalValueByPath: Readonly<Record<string, ProjectMutationPathValue>>;
      readonly fileRevisions: Readonly<Record<string, ProjectSourceExpectedRevision>>;
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
  readonly sourceChangedPaths?: readonly string[];
  readonly sourceDiagnostics?: readonly ProjectValidationDiagnostic[];
  readonly assetFileRevisions?: Readonly<Record<string, ProjectSourceExpectedRevision>>;
  readonly assetDiagnostics?: readonly ProjectValidationDiagnostic[];
  readonly authoring?: ProjectWorkspaceAuthoringWatchResult;
}

export function shouldReconcileProjectWorkspaceWatchEvent(
  event: ProjectWorkspaceWatchEvent,
): boolean {
  return Boolean(event.authoring?.success && event.authoring.affectedPaths.length > 0);
}
