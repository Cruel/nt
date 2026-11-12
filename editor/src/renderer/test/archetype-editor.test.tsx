import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vite-plus/test';
import { ArchetypeEditor } from '@/editors/archetypes/ArchetypeEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultArchetypeData } from '../../shared/project-schema/authoring-archetypes';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import {
  admitNativeRendererCommandFixture,
  holdFirstNativeProjectPatch,
} from '../test-support/native-acknowledged-command-fixture';

const tab: WorkbenchTab = {
  id: 'tab:archetype:example',
  title: 'Example',
  editorType: 'archetype',
  resource: {
    kind: 'record',
    stableId: 'record:archetypes:example',
    collection: 'archetypes',
    entityId: 'example',
  },
};

beforeEach(() => {
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
});

it.each([500, 1000])(
  'keeps an Archetype kind selection visible throughout a %i ms native acknowledgment',
  async (delay) => {
    const document = createAuthoringProject();
    document.archetypes.example = {
      id: 'example',
      label: 'Example',
      data: defaultArchetypeData('room'),
    };
    admitNativeRendererCommandFixture(document);
    const held = holdFirstNativeProjectPatch();
    render(<ArchetypeEditor tab={tab} />);

    const select = screen.getAllByRole('combobox')[0]!;
    const user = userEvent.setup();
    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'Character' }));
    expect(select).toHaveTextContent('Character');
    await waitFor(() => expect(held.isHeld()).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, delay));
    expect(select).toHaveTextContent('Character');
    expect(
      (useProjectStore.getState().document as typeof document).archetypes.example.data.instanceKind,
    ).toBe('room');

    await act(async () => held.release());
    await waitFor(() =>
      expect(
        (useProjectStore.getState().document as typeof document).archetypes.example.data
          .instanceKind,
      ).toBe('character'),
    );
    expect(select).toHaveTextContent('Character');
  },
  15000,
);
