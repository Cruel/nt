import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vite-plus/test';
import { TagsEditor } from '@/editors/project/TagsEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import {
  admitNativeRendererCommandFixture,
  holdFirstNativeProjectPatch,
} from '../test-support/native-acknowledged-command-fixture';

const tab: WorkbenchTab = {
  id: 'tab:tags',
  title: 'Tags',
  editorType: 'project-tags',
};

beforeEach(() => {
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
});

it.each([500, 1000])(
  'shows changed Tag color during a %i ms native hold',
  async (delay) => {
    const document = createAuthoringProject();
    document.editor.tags = { records: { hero: { name: 'Hero', color: 'tag-red' } } };
    const native = admitNativeRendererCommandFixture(document);
    const held = holdFirstNativeProjectPatch();
    render(<TagsEditor tab={tab} />);
    const user = userEvent.setup();
    const select = screen.getByRole('combobox');
    expect(select).toHaveTextContent('red');
    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'blue' }));
    expect(select).toHaveTextContent('blue');
    await waitFor(() => expect(held.isHeld()).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, delay));
    expect(select).toHaveTextContent('blue');
    expect(
      (useProjectStore.getState().document as typeof document).editor.tags?.records.hero.color,
    ).toBe('tag-red');
    expect(native.patch).not.toHaveBeenCalled();

    await act(async () => held.release());
    await waitFor(() =>
      expect(
        (useProjectStore.getState().document as typeof document).editor.tags?.records.hero.color,
      ).toBe('tag-blue'),
    );
    expect(select).toHaveTextContent('blue');
  },
  15000,
);
