import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RawJsonEditor } from '@/editors/raw-json/RawJsonEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchTab } from '@/workbench/workbench-types';

const tab: WorkbenchTab = {
  id: 'tab:raw-json:record:room:foyer',
  title: 'foyer',
  editorType: 'raw-json',
  resource: {
    kind: 'record',
    stableId: 'record:room:foyer',
    collection: 'room',
    entityId: 'foyer',
  },
};

beforeEach(() => {
  useProjectStore.getState().loadProjectDocument({
    document: { room: { foyer: ['foyer', 'old'] } },
    projectPath: '/mock/project',
    projectFilePath: '/mock/project/game.json',
  });
  useCommandStore.getState().resetCommandHistory();
});

describe('RawJsonEditor', () => {
  it('applies valid JSON through the command bus', async () => {
    const user = userEvent.setup();
    render(<RawJsonEditor tab={tab} />);

    await user.click(screen.getByText('Edit JSON'));
    const editor = screen.getByRole('textbox');
    await user.clear(editor);
    fireEvent.change(editor, { target: { value: '["foyer", "new"]' } });
    await user.click(screen.getByText('Apply'));

    expect(useProjectStore.getState().document).toEqual({ room: { foyer: ['foyer', 'new'] } });
    expect(useCommandStore.getState().history.entries).toHaveLength(1);
  });

  it('keeps project state unchanged for invalid JSON drafts', async () => {
    const user = userEvent.setup();
    render(<RawJsonEditor tab={tab} />);

    await user.click(screen.getByText('Edit JSON'));
    const editor = screen.getByRole('textbox');
    await user.clear(editor);
    fireEvent.change(editor, { target: { value: 'not json' } });
    await user.click(screen.getByText('Apply'));

    expect(screen.getByText(/Expected property name|Unexpected token|JSON/)).toBeInTheDocument();
    expect(useProjectStore.getState().document).toEqual({ room: { foyer: ['foyer', 'old'] } });
    expect(useCommandStore.getState().history.entries).toHaveLength(0);
  });
});
