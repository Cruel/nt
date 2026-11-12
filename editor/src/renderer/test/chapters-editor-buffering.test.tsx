import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it } from 'vite-plus/test';
import { ChaptersEditor } from '@/editors/project/ChaptersEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import {
  admitNativeRendererCommandFixture,
  holdFirstNativeProjectPatch,
} from '../test-support/native-acknowledged-command-fixture';

const tab: WorkbenchTab = {
  id: 'tab:chapters',
  title: 'Chapters',
  editorType: 'project-chapters',
};

beforeEach(() => {
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
});

it.each([500, 1000])(
  'preserves independent Chapter label and color under a %i ms native hold',
  async (delay) => {
    const document = createAuthoringProject();
    document.editor.chapters = {
      records: { introduction: { id: 'introduction', label: 'Introduction', color: '#ff0000' } },
      assignments: {},
    };
    const native = admitNativeRendererCommandFixture(document);
    const held = holdFirstNativeProjectPatch();
    render(<ChaptersEditor tab={tab} />);
    const name = screen.getByRole('textbox', { name: 'Chapter introduction label' });
    const color = screen.getByRole('textbox', { name: 'Chapter introduction color' });
    fireEvent.change(name, { target: { value: 'Prologue' } });
    expect(name).toHaveValue('Prologue');
    await waitFor(() => expect(held.isHeld()).toBe(true));
    fireEvent.change(color, { target: { value: '#00ff00' } });
    expect(color).toHaveValue('#00ff00');
    await new Promise((resolve) => setTimeout(resolve, delay));
    expect(name).toHaveValue('Prologue');
    expect(color).toHaveValue('#00ff00');
    expect(
      (useProjectStore.getState().document as typeof document).editor.chapters?.records.introduction
        .label,
    ).toBe('Introduction');
    expect(native.patch).not.toHaveBeenCalled();

    await act(async () => held.release());
    await waitFor(() =>
      expect(
        (useProjectStore.getState().document as typeof document).editor.chapters?.records
          .introduction,
      ).toMatchObject({ label: 'Prologue', color: '#00ff00' }),
    );
    expect(native.patch.mock.calls.length).toBeLessThanOrEqual(2);
  },
  15000,
);
