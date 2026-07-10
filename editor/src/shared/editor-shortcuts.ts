export type EditorShortcutCommand =
  | 'new'
  | 'open-project'
  | 'save'
  | 'save-as'
  | 'close-active-tab'
  | 'reopen-closed-tab'
  | 'command-palette'
  | 'toggle-bottom-panel'
  | 'toggle-sidebar';

export interface EditorShortcutInput {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  isComposing?: boolean;
}

export function resolveEditorShortcutCommand(input: EditorShortcutInput): EditorShortcutCommand | null {
  if (
    input.type !== 'keyDown'
    || input.alt
    || input.isComposing
    || !(input.control || input.meta)
  ) {
    return null;
  }

  switch (input.key.toLowerCase()) {
    case 'n':
      return 'new';
    case 'o':
      return input.shift ? null : 'open-project';
    case 's':
      return input.shift ? 'save-as' : 'save';
    case 'w':
      return 'close-active-tab';
    case 't':
      return input.shift ? 'reopen-closed-tab' : null;
    case 'p':
      return 'command-palette';
    case 'j':
      return 'toggle-bottom-panel';
    case 'b':
      return 'toggle-sidebar';
    default:
      return null;
  }
}
