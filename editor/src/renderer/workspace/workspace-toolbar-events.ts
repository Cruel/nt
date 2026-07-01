export const WORKSPACE_TOOLBAR_COMMAND_EVENT = 'noveltea-workspace-toolbar-command';

export type WorkspaceToolbarCommand =
  | 'new-project'
  | 'open-project'
  | 'close-project'
  | 'validate'
  | 'import-assets'
  | 'run-first-test'
  | 'export-package'
  | 'preview-play'
  | 'preview-stop'
  | 'undo'
  | 'redo'
  | 'save'
  | 'save-as'
  | 'toggle-autosave'
  | 'toggle-bottom-panel';

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
