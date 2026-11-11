import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  ProjectFieldInput,
  ProjectFieldNumber,
  ProjectFieldSwitch,
  ProjectFieldTextarea,
} from '@/commands/use-project-field';
import { projectEdits } from '@/commands/project-editing';
import { flushNativeFields, useNativeFieldDraftStore } from '@/commands/native-field-drafts';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { PROJECT_SETTINGS_SAVE_UNIT_ID } from '@/project/save-unit-registry';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { usePendingInputStore } from '@/workbench/pending-input-store';
import {
  bufferedRoomFieldCommand,
  rebasedRoomDataCommand,
} from '@/editors/rooms/room-buffered-fields';
import { defaultRoomData, parseRoomData } from '../../shared/project-schema/authoring-rooms';
import { inlineTextContent } from '../../shared/project-schema/authoring-flow';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { isAuthoringProjectView } from '../../shared/project-schema/authoring-project-view';
import { admitNativeRendererCommandFixture } from '../test-support/native-acknowledged-command-fixture';

function NameField({ tabId = 'project:1' }: { tabId?: string }) {
  const document = useProjectStore((state) => state.document);
  return (
    <ProjectFieldInput
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
    <ProjectFieldInput
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
  usePendingInputStore.getState().resetPendingInputs();
});

describe('shared buffered native field intents', () => {
  it('adds an optional nested Project setting against the current native Project', async () => {
    const native = admitProject();
    render(
      <ProjectFieldInput
        aria-label="Apple bundle ID"
        tabId="project:1"
        path="/settings/app/desktop/appleBundleId"
        saveUnitId={PROJECT_SETTINGS_SAVE_UNIT_ID}
        label="Update Apple bundle ID"
        value=""
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Apple bundle ID' }), {
      target: { value: 'com.example.game' },
    });
    await act(async () =>
      expect(await projectEdits.flush(PROJECT_SETTINGS_SAVE_UNIT_ID)).toBe(true),
    );
    expect(native.patch.mock.calls.at(-1)?.[2]).toContainEqual({
      op: 'add',
      path: '/settings/app/desktop/appleBundleId',
      value: 'com.example.game',
    });
    expect(useProjectStore.getState().document).toMatchObject({
      settings: { app: { desktop: { appleBundleId: 'com.example.game' } } },
    });
  });

  it('keeps raw textarea input responsive and stages exact final text', async () => {
    const native = admitProject();
    render(
      <ProjectFieldTextarea
        aria-label="Project description"
        tabId="project:1"
        path="/project/description"
        saveUnitId={PROJECT_SETTINGS_SAVE_UNIT_ID}
        label="Update project description"
        value=""
      />,
    );
    const textarea = screen.getByRole('textbox', { name: 'Project description' });
    fireEvent.change(textarea, { target: { value: 'Line one\nLine two' } });
    expect(textarea).toHaveValue('Line one\nLine two');
    expect(native.patch).not.toHaveBeenCalled();
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    expect(useProjectStore.getState().document).toMatchObject({
      project: { description: 'Line one\nLine two' },
    });
  });

  it('preserves incomplete numeric text and commits only completed values', async () => {
    const native = admitProject();
    render(
      <ProjectFieldNumber
        aria-label="Build number"
        type="number"
        min={1}
        tabId="project:1"
        path="/settings/app/buildNumber"
        saveUnitId={PROJECT_SETTINGS_SAVE_UNIT_ID}
        label="Update build number"
        value={null}
        optional
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Build number' });
    expect(input).toHaveAttribute('type', 'text');
    fireEvent.change(input, { target: { value: '-' } });
    expect(input).toHaveValue('-');
    expect(
      usePendingInputStore.getState().entriesBySaveUnitId[PROJECT_SETTINGS_SAVE_UNIT_ID],
    ).toHaveProperty('/settings/app/buildNumber');
    expect(native.patch).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '0' } });
    expect(input).toHaveValue('0');
    expect(native.patch).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '12' } });
    expect(input).toHaveValue('12');
    expect(
      usePendingInputStore.getState().entriesBySaveUnitId[PROJECT_SETTINGS_SAVE_UNIT_ID],
    ).toBeUndefined();
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    expect(useProjectStore.getState().document).toMatchObject({
      settings: { app: { buildNumber: 12 } },
    });
  });

  it('uses semantic Project commands to create a missing title screen container', async () => {
    const native = admitProject();
    render(
      <ProjectFieldSwitch
        aria-label="Show author name"
        tabId="project:1"
        path="/settings/titleScreen/showAuthor"
        saveUnitId={PROJECT_SETTINGS_SAVE_UNIT_ID}
        label="Show author name"
        value={false}
        buildCommand={(next) => ({
          type: 'project.setTitleScreen',
          payload: { showAuthor: next },
          label: 'Show author name',
          originSaveUnitId: PROJECT_SETTINGS_SAVE_UNIT_ID,
          persistencePolicy: 'manual-save',
        })}
      />,
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Show author name' }));
    expect(screen.getByRole('switch', { name: 'Show author name' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    expect(native.patch).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().document).toMatchObject({
      settings: { titleScreen: { showAuthor: true } },
    });
  });

  it('rebases a legacy whole-Room command after an earlier buffered field edit', async () => {
    const project = createAuthoringProject();
    const initial = defaultRoomData('Foyer');
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: initial };
    admitNativeRendererCommandFixture(project);

    expect(
      projectEdits.field({
        tabId: 'room:foyer',
        path: '/rooms/foyer/data/displayName',
        saveUnitId: 'record:rooms:foyer',
        value: 'Latest display name',
        label: 'Change Room display name',
      }),
    ).toBe(true);

    const result = await projectEdits.execute({
      type: 'room.replaceData',
      label: 'Update Room description',
      payload: {
        roomId: 'foyer',
        data: { ...initial, description: inlineTextContent('An updated room') },
      },
      originSaveUnitId: 'record:rooms:foyer',
      persistencePolicy: 'manual-save',
    });

    expect(result.ok).toBe(true);
    const acknowledged = useProjectStore.getState().document;
    expect(isAuthoringProjectView(acknowledged)).toBe(true);
    if (isAuthoringProjectView(acknowledged)) {
      const current = parseRoomData(acknowledged.rooms.foyer?.data);
      expect(current).toMatchObject({
        displayName: 'Latest display name',
        description: { source: { kind: 'inline', text: 'An updated room' } },
      });
    }
  });
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
    render(
      <ProjectFieldInput
        aria-label="Room display name"
        tabId="room:foyer"
        path="/rooms/foyer/data/displayName"
        saveUnitId="rooms/foyer"
        label="Update room name"
        value={baseline.displayName}
        buildCommand={(next) =>
          bufferedRoomFieldCommand('foyer', 'displayName', next, 'Update room name')
        }
      />,
    );
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
