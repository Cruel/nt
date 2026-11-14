export const WORKSPACE_TOOLBAR_COMMAND_EVENT = 'noveltea-workspace-toolbar-command';

// A new user-initiated Open supersedes a pending candidate Save/auto-open,
// even while the new Project is still loading and the active Project identity
// has not yet changed.
let projectOpenRequestGeneration = 0;

export function currentProjectOpenRequestGeneration(): number {
  return projectOpenRequestGeneration;
}

export function beginProjectOpenRequest(): void {
  projectOpenRequestGeneration++;
}

export type WorkspaceToolbarCommand =
  | 'new-project'
  | 'new-entity'
  | 'open-project'
  | 'close-project'
  | 'validate'
  | 'project-settings'
  | 'import-assets'
  | 'run-first-test'
  | 'export-package'
  | 'play-game'
  | 'preview-play'
  | 'preview-stop'
  | 'undo'
  | 'redo'
  | 'save'
  | 'save-all'
  | 'save-as'
  | 'close-active-tab'
  | 'reopen-closed-tab'
  | 'toggle-bottom-panel'
  | 'command-palette';

export type WorkspaceToolbarCommandDetail =
  | WorkspaceToolbarCommand
  | {
      command: WorkspaceToolbarCommand;
      projectPath?: string;
      repairCandidateId?: string;
      readyRevision?: string;
    };

export function dispatchWorkspaceToolbarCommand(detail: WorkspaceToolbarCommandDetail) {
  window.dispatchEvent(
    new CustomEvent<WorkspaceToolbarCommandDetail>(WORKSPACE_TOOLBAR_COMMAND_EVENT, {
      detail,
    }),
  );
}
