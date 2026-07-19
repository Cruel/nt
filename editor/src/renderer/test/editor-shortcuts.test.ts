import { describe, expect, it } from 'vite-plus/test';
import {
  resolveEditorShortcutCommand,
  type EditorShortcutInput,
} from '../../shared/editor-shortcuts';

function input(overrides: Partial<EditorShortcutInput>): EditorShortcutInput {
  return {
    type: 'keyDown',
    key: '',
    control: true,
    meta: false,
    alt: false,
    shift: false,
    isComposing: false,
    ...overrides,
  };
}

describe('editor shortcuts', () => {
  it.each([
    ['n', false, 'new'],
    ['o', false, 'open-project'],
    ['s', false, 'save'],
    ['s', true, 'save-as'],
    ['w', false, 'close-active-tab'],
    ['t', true, 'reopen-closed-tab'],
    ['p', false, 'command-palette'],
    ['p', true, 'command-palette'],
    ['j', false, 'toggle-bottom-panel'],
    ['b', false, 'toggle-sidebar'],
  ] as const)('maps Ctrl+%s (shift=%s) to %s', (key, shift, command) => {
    expect(resolveEditorShortcutCommand(input({ key, shift }))).toBe(command);
  });

  it('supports Command shortcuts on macOS', () => {
    expect(
      resolveEditorShortcutCommand(
        input({
          key: 's',
          control: false,
          meta: true,
        }),
      ),
    ).toBe('save');
  });

  it.each([
    input({ key: 's', type: 'keyUp' }),
    input({ key: 's', control: false }),
    input({ key: 's', alt: true }),
    input({ key: 's', isComposing: true }),
    input({ key: 'o', shift: true }),
    input({ key: 't', shift: false }),
    input({ key: 'z' }),
  ])('does not claim non-global or invalid input: %o', (event) => {
    expect(resolveEditorShortcutCommand(event)).toBeNull();
  });
});
