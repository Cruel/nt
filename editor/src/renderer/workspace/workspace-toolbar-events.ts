export const WORKSPACE_TOOLBAR_COMMAND_EVENT = 'noveltea-workspace-toolbar-command';

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
  | 'save-as'
  | 'toggle-bottom-panel'
  | 'command-palette';

export type WorkspaceToolbarCommandDetail =
  | WorkspaceToolbarCommand
  | {
      command: WorkspaceToolbarCommand;
      projectPath?: string;
    };

export function dispatchWorkspaceToolbarCommand(detail: WorkspaceToolbarCommandDetail) {
  window.dispatchEvent(
    new CustomEvent<WorkspaceToolbarCommandDetail>(WORKSPACE_TOOLBAR_COMMAND_EVENT, {
      detail,
    }),
  );
}
