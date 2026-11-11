import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { ProjectFieldInput } from '@/commands/use-project-field';
import { bufferedRoomFieldCommand } from '@/editors/rooms/room-buffered-fields';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import {
  useDraftDirtyStore,
  runDraftActions,
  selectDraftEntriesForTab,
} from '@/workbench/draft-dirty-store';
import { admitNativeRendererCommandFixture } from '../test-support/native-acknowledged-command-fixture';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData, parseRoomData } from '../../shared/project-schema/authoring-rooms';
import { isAuthoringProjectView } from '../../shared/project-schema/authoring-project-view';

const tabId = 'tab:room-detail:rooms:foyer';

function TestInput() {
  const document = useProjectStore((state) => state.document);
  const value = isAuthoringProjectView(document)
    ? (parseRoomData(document.rooms.foyer?.data)?.displayName ?? '')
    : '';
  return (
    <ProjectFieldInput
      aria-label="Room display name"
      tabId={tabId}
      path="/rooms/foyer/data/displayName"
      saveUnitId="rooms/foyer"
      label="Update room name"
      value={value}
      buildCommand={(next) =>
        bufferedRoomFieldCommand('foyer', 'displayName', next, 'Update room name')
      }
    />
  );
}

beforeEach(() => {
  useProjectStore.getState().clearProject();
  useCommandStore.getState().resetCommandHistory();
  useDraftDirtyStore.getState().resetDraftDirty();
});

function admitRoom() {
  const project = createAuthoringProject();
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('R') };
  return admitNativeRendererCommandFixture(project);
}

describe('Room display name native edit input', () => {
  it('shows rapid input immediately while native acknowledgment is delayed, without losing characters', async () => {
    const native = admitRoom();
    const originalPatch = window.noveltea.nativeProjectPatch;
    let release: (() => void) | undefined;
    vi.spyOn(window.noveltea, 'nativeProjectPatch').mockImplementationOnce(
      (...args) =>
        new Promise((resolve, reject) => {
          release = () => void Promise.resolve(originalPatch(...args)).then(resolve, reject);
        }),
    );
    render(<TestInput />);
    const input = screen.getByRole('textbox', { name: 'Room display name' });
    fireEvent.change(input, { target: { value: 'R1' } });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    for (const text of ['R12', 'R123', 'R1234', 'R12345', 'R123456', 'R1234567']) {
      fireEvent.change(input, { target: { value: text } });
      expect(input).toHaveValue(text);
    }
    await act(async () => release!());
    await waitFor(() => {
      const current = useProjectStore.getState().document;
      expect(isAuthoringProjectView(current)).toBe(true);
      if (isAuthoringProjectView(current))
        expect(parseRoomData(current.rooms.foyer?.data)?.displayName).toBe('R1234567');
    });
    expect(native.patch.mock.calls.length).toBeLessThanOrEqual(3);
    expect(input).toHaveValue('R1234567');
  });

  it('applies the latest draft before Save, and can discard an unapplied draft', async () => {
    const native = admitRoom();
    render(<TestInput />);
    const input = screen.getByRole('textbox', { name: 'Room display name' });
    fireEvent.change(input, { target: { value: 'Changed before Save' } });
    const getDrafts = () =>
      selectDraftEntriesForTab({ entriesByKey: useDraftDirtyStore.getState().entriesByKey }, tabId);
    expect(getDrafts()).toHaveLength(1);
    await act(async () => expect(await runDraftActions(getDrafts(), 'apply')).toBe(true));
    expect(input).toHaveValue('Changed before Save');
    expect(native.patch).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { value: 'Unsaved later change' } });
    await act(async () => expect(await runDraftActions(getDrafts(), 'discard')).toBe(true));
    expect(input).toHaveValue('Changed before Save');
    expect(native.patch).toHaveBeenCalledTimes(1);
  });

  it('retains a pending typed draft across view remount instead of falling back to the saved name', () => {
    const native = admitRoom();
    const view = render(<TestInput />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Room display name' }), {
      target: { value: 'Recovered typing' },
    });
    view.unmount();
    render(<TestInput />);
    expect(screen.getByRole('textbox', { name: 'Room display name' })).toHaveValue(
      'Recovered typing',
    );
    expect(native.patch).not.toHaveBeenCalled();
  });
});
