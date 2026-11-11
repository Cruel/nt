import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { NativeBufferedInput } from '@/commands/use-native-field-draft';
import { flushNativeFields, useNativeFieldDraftStore } from '@/commands/native-field-drafts';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { PROJECT_SETTINGS_SAVE_UNIT_ID } from '@/project/save-unit-registry';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { RoomDisplayNameField, rebasedRoomDataCommand } from '@/editors/rooms/room-buffered-fields';
import { defaultRoomData, parseRoomData } from '../../shared/project-schema/authoring-rooms';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { isAuthoringProjectView } from '../../shared/project-schema/authoring-project-view';
import { admitNativeRendererCommandFixture } from '../test-support/native-acknowledged-command-fixture';

function NameField({ tabId = 'project:1' }: { tabId?: string }) {
  const document = useProjectStore((state) => state.document);
  return (
    <NativeBufferedInput
      aria-label={`Project title ${tabId}`}
      tabId={tabId}
      path="/project/name"
      saveUnitId={PROJECT_SETTINGS_SAVE_UNIT_ID}
      label="Edit Project title"
      value={isAuthoringProjectView(document) ? document.project.name : ''}
    />
  );
}

function AuthorField() {
  const document = useProjectStore((state) => state.document);
  return (
    <NativeBufferedInput
      aria-label="Project author"
      tabId="project:1"
      path="/project/author"
      saveUnitId={PROJECT_SETTINGS_SAVE_UNIT_ID}
      label="Edit Project author"
      value={isAuthoringProjectView(document) ? document.project.author : ''}
    />
  );
}

function admitProject(name = 'Original') {
  const project = createAuthoringProject();
  project.project.name = name;
  return admitNativeRendererCommandFixture(project);
}

beforeEach(() => {
  useProjectStore.getState().clearProject();
  useCommandStore.getState().resetCommandHistory();
  useDraftDirtyStore.getState().resetDraftDirty();
});

describe('shared buffered native field intents', () => {
  it('keeps independent fields and newest typing visible across a blocked native acknowledgment', async () => {
    const native = admitProject();
    const realPatch = window.noveltea.nativeProjectPatch;
    let release: (() => void) | undefined;
    let first = true;
    Object.defineProperty(window.noveltea, 'nativeProjectPatch', {
      configurable: true,
      value: vi.fn((...args: Parameters<typeof realPatch>) => {
        if (!first) return realPatch(...args);
        first = false;
        return new Promise<Awaited<ReturnType<typeof realPatch>>>((resolve, reject) => {
          release = () => void Promise.resolve(realPatch(...args)).then(resolve, reject);
        });
      }),
    });
    render(
      <>
        <NameField />
        <AuthorField />
      </>,
    );
    const title = screen.getByRole('textbox', { name: 'Project title project:1' });
    const author = screen.getByRole('textbox', { name: 'Project author' });
    fireEvent.change(title, { target: { value: 'One' } });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    for (const input of ['Two', 'Three', 'Four']) {
      fireEvent.change(title, { target: { value: input } });
      expect(title).toHaveValue(input);
    }
    fireEvent.change(author, { target: { value: 'Another author' } });
    expect(author).toHaveValue('Another author');
    expect(useProjectStore.getState().document).toMatchObject({ project: { name: 'Original' } });
    await act(async () => release!());
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        project: { name: 'Four', author: 'Another author' },
      }),
    );
    expect(title).toHaveValue('Four');
    expect(native.patch.mock.calls.map(([, , patches]) => patches[0])).toEqual([
      { op: 'replace', path: '/project/name', value: 'One' },
      { op: 'replace', path: '/project/name', value: 'Four' },
      { op: 'replace', path: '/project/author', value: 'Another author' },
    ]);
  });

  it('shares one overlay between two live views of the same field', async () => {
    const native = admitProject();
    render(
      <>
        <NameField tabId="first-view" />
        <NameField tabId="second-view" />
      </>,
    );
    const first = screen.getByRole('textbox', { name: 'Project title first-view' });
    const second = screen.getByRole('textbox', { name: 'Project title second-view' });
    fireEvent.change(first, { target: { value: 'From first view' } });
    expect(second).toHaveValue('From first view');
    fireEvent.change(second, { target: { value: 'Final shared value' } });
    expect(first).toHaveValue('Final shared value');
    await act(async () =>
      expect(await flushNativeFields(PROJECT_SETTINGS_SAVE_UNIT_ID)).toBe(true),
    );
    expect(native.patch.mock.calls[0]?.[2][0]?.path).toBe('/project/name');
    expect(useProjectStore.getState().document).toMatchObject({
      project: { name: 'Final shared value' },
    });
    expect(Object.keys(useNativeFieldDraftStore.getState().entries)).toHaveLength(0);
  });

  it('preserves an actionable draft on native failure instead of pretending Save succeeded', async () => {
    admitProject();
    vi.spyOn(window.noveltea, 'nativeProjectPatch').mockRejectedValueOnce(new Error('Worker lost'));
    const view = render(<NameField />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Project title project:1' }), {
      target: { value: 'Unacknowledged work' },
    });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Worker lost'));
    expect(screen.getByRole('textbox', { name: 'Project title project:1' })).toHaveValue(
      'Unacknowledged work',
    );
    expect(await flushNativeFields()).toBe(false);
    expect(useProjectStore.getState().document).toMatchObject({ project: { name: 'Original' } });
    view.unmount();
    render(<NameField />);
    expect(screen.getByRole('textbox', { name: 'Project title project:1' })).toHaveValue(
      'Unacknowledged work',
    );
  });

  it('flushes pending fields before dependent commands are constructed', async () => {
    const native = admitProject();
    render(<NameField />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Project title project:1' }), {
      target: { value: 'Typed before structural command' },
    });
    await act(async () => {
      const result = await useCommandStore.getState().executeCommandAsync({
        type: 'project.setEntrypoint',
        label: 'Select entrypoint',
        payload: { target: null },
        originSaveUnitId: PROJECT_SETTINGS_SAVE_UNIT_ID,
        persistencePolicy: 'manual-save',
      });
      expect(result.ok).toBe(true);
    });
    expect(native.patch.mock.calls[0]?.[2][0]?.path).toBe('/project/name');
    expect(useProjectStore.getState().document).toMatchObject({
      project: { name: 'Typed before structural command' },
    });
  });

  it('rebases a whole-Room control onto the latest buffered Room field', async () => {
    const project = createAuthoringProject();
    const baseline = defaultRoomData('Original Room');
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: baseline };
    admitNativeRendererCommandFixture(project);
    const originalPatch = window.noveltea.nativeProjectPatch;
    let release: (() => void) | undefined;
    let first = true;
    Object.defineProperty(window.noveltea, 'nativeProjectPatch', {
      configurable: true,
      value: vi.fn((...args: Parameters<typeof originalPatch>) => {
        if (!first) return originalPatch(...args);
        first = false;
        return new Promise<Awaited<ReturnType<typeof originalPatch>>>((resolve, reject) => {
          release = () => void Promise.resolve(originalPatch(...args)).then(resolve, reject);
        });
      }),
    });
    render(<RoomDisplayNameField roomId="foyer" tabId="room:foyer" value={baseline.displayName} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Room display name' }), {
      target: { value: 'New buffered name' },
    });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    const update = rebasedRoomDataCommand(
      'foyer',
      baseline,
      {
        ...baseline,
        description: {
          ...baseline.description,
          source: { kind: 'inline', text: 'New description' },
        },
      },
      'Update room description via whole-Room control',
    );
    expect(update).not.toBeNull();
    const pending = useCommandStore.getState().executeCommandAsync(update!);
    await act(async () => release!());
    await act(async () => expect((await pending).ok).toBe(true));
    const document = useProjectStore.getState().document;
    expect(isAuthoringProjectView(document)).toBe(true);
    if (isAuthoringProjectView(document)) {
      expect(parseRoomData(document.rooms.foyer?.data)).toMatchObject({
        displayName: 'New buffered name',
        description: { source: { kind: 'inline', text: 'New description' } },
      });
    }
  });
});
