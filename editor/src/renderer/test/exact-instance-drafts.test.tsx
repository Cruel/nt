import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { ExactInstanceDrafts } from '@/components/properties/ExactInstanceDrafts';
import { useProjectField } from '@/commands/use-project-field';
import { projectEdits } from '@/commands/project-editing';
import { nativeFieldDraftKey, useNativeFieldDraftStore } from '@/commands/native-field-drafts';
import { serializeDraftDirtyState } from '@/workbench/draft-dirty-store';
import {
  resolveExactInstanceFieldIdentity,
  fieldSaveUnitForPath,
} from '@/commands/project-field-identity';
import { useProjectStore } from '@/project/project-store';
import { toJsonValue } from '@/project/json-value';
import { useCommandStore } from '@/commands/command-store';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { usePendingInputStore } from '@/workbench/pending-input-store';
import {
  createAuthoringProject,
  isAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { projectInventoryRef } from '../../shared/project-schema/authoring-inventories';
import {
  admitNativeRendererCommandFixture,
  holdFirstNativeProjectPatch,
} from '../test-support/native-acknowledged-command-fixture';

function makeProject() {
  const project = createAuthoringProject();
  project.interactables.door = {
    id: 'door',
    label: 'Door',
    traits: [],
    data: defaultInteractableData('Door'),
  };
  project.interactableInstances['door-1'] = defaultInteractableInstanceData('door-1', 'door');
  return project;
}

function Fields() {
  const document = useProjectStore((state) => state.document);
  if (!isAuthoringProject(document)) return null;
  const instance = document.interactableInstances['door-1']!;
  return (
    <ExactInstanceDrafts
      instance={instance}
      instanceId="door-1"
      tabId="tab:door"
      owner={{ collection: 'interactables', id: 'door' }}
      onAtomicRename={() => {
        throw new Error('The test must not use whole-Instance replacement.');
      }}
    >
      {(current, update) => (
        <>
          <output data-testid="property-count">{current.localProperties.length}</output>
          <output data-testid="material-kind">
            {current.materialApplication.material?.$ref.id ?? 'inherited'}
          </output>
          <button
            onClick={() =>
              update({
                ...current,
                localProperties: [
                  ...current.localProperties,
                  { id: 'clue', type: 'string', nullable: false, value: 'found' },
                ],
              })
            }
          >
            Add local Property
          </button>
          <button
            onClick={() =>
              update({
                ...current,
                materialApplication: {
                  ...current.materialApplication,
                  material: { $ref: { collection: 'materials', id: 'panel' } },
                },
              })
            }
          >
            Set Material
          </button>
        </>
      )}
    </ExactInstanceDrafts>
  );
}

const sharedPropertyPath = '/interactableInstances/door-1/localProperties';
function SharedInstanceField({
  owner,
  tabId,
}: {
  owner: 'record:rooms:hall' | 'record:interactables:door';
  tabId: string;
}) {
  const document = useProjectStore((state) => state.document);
  if (!isAuthoringProject(document)) return null;
  return (
    <SharedInstanceControl
      owner={owner}
      tabId={tabId}
      properties={document.interactableInstances['door-1']!.localProperties}
    />
  );
}

function SharedInstanceControl({
  owner,
  tabId,
  properties,
}: {
  owner: 'record:rooms:hall' | 'record:interactables:door';
  tabId: string;
  properties: ReturnType<typeof makeProject>['interactableInstances'][string]['localProperties'];
}) {
  const field = useProjectField({
    tabId,
    saveUnitId: owner,
    path: sharedPropertyPath,
    label: `Update exact Instance from ${owner}`,
    value: toJsonValue(properties),
    scope: 'exact-instance',
  });
  const items = field.value as typeof properties;
  return (
    <div>
      <output data-testid={tabId}>{JSON.stringify(items[0]?.value ?? 'none')}</output>
      <button
        onClick={() =>
          field.change([{ id: 'clue', type: 'string', nullable: false, value: tabId }])
        }
      >
        Update {tabId}
      </button>
    </div>
  );
}

function projectWithRoomInstance() {
  const project = makeProject();
  const room = defaultRoomData('Hall');
  room.interactables = [
    {
      id: 'door-occurrence',
      interactable: { $ref: { registry: 'interactableInstances', id: 'door-1' } },
      condition: { kind: 'always' },
      placementId: 'door-placement',
      visible: true,
      order: 0,
    },
  ];
  project.rooms.hall = { id: 'hall', label: 'Hall', data: room };
  return project;
}

beforeEach(() => {
  useProjectStore.getState().clearProject();
  useCommandStore.getState().resetCommandHistory();
  useDraftDirtyStore.getState().resetDraftDirty();
  usePendingInputStore.getState().resetPendingInputs();
});

describe('exact Interactable Instance owner-scoped drafts', () => {
  it('transfers same-path pending ownership without losing the latest edit across two visible owners', async () => {
    const native = admitNativeRendererCommandFixture(projectWithRoomInstance());
    const held = holdFirstNativeProjectPatch();
    render(
      <>
        <SharedInstanceField owner="record:interactables:door" tabId="definition" />
        <SharedInstanceField owner="record:rooms:hall" tabId="room" />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Update definition' }));
    await waitFor(() => expect(held.isHeld()).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Update room' }));
    expect(screen.getByTestId('definition')).toHaveTextContent('room');
    expect(screen.getByTestId('room')).toHaveTextContent('room');
    const drafts = useDraftDirtyStore.getState().entriesByKey;
    expect(drafts[nativeFieldDraftKey('record:rooms:hall', sharedPropertyPath)]?.dirty).toBe(true);
    expect(
      drafts[nativeFieldDraftKey('record:interactables:door', sharedPropertyPath)],
    ).toBeUndefined();

    await act(async () => held.release());
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    expect(useProjectStore.getState().document).toMatchObject({
      interactableInstances: { 'door-1': { localProperties: [{ id: 'clue', value: 'room' }] } },
    });
    expect(native.patch).toHaveBeenCalledTimes(2);
    expect(
      useCommandStore.getState().history.entries.map((entry) => entry.originSaveUnitId),
    ).toEqual(['record:interactables:door', 'record:rooms:hall']);
  });

  it('replans queued native input under its latest exact Instance Save owner', async () => {
    const native = admitNativeRendererCommandFixture(projectWithRoomInstance());
    const held = holdFirstNativeProjectPatch();
    render(
      <>
        <SharedInstanceField owner="record:interactables:door" tabId="definition" />
        <SharedInstanceField owner="record:rooms:hall" tabId="room" />
      </>,
    );
    const preceding = projectEdits.execute({
      type: 'project.replaceAtPath',
      label: 'Hold unrelated native command',
      payload: { path: '/project/name', value: 'Changed' },
      originSaveUnitId: 'project:settings',
      persistencePolicy: 'manual-save',
    });
    await waitFor(() => expect(held.isHeld()).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Update definition' }));
    const first = projectEdits.flushField(sharedPropertyPath);
    fireEvent.click(screen.getByRole('button', { name: 'Update room' }));
    expect(screen.getByTestId('room')).toHaveTextContent('room');
    await act(async () => held.release());
    await act(async () => expect((await preceding).ok).toBe(true));
    await act(async () => expect(await first).toBe(true));
    expect(useProjectStore.getState().document).toMatchObject({
      interactableInstances: { 'door-1': { localProperties: [{ id: 'clue', value: 'room' }] } },
    });
    expect(native.patch).toHaveBeenCalledTimes(2);
    expect(
      useCommandStore.getState().history.entries.map((entry) => entry.originSaveUnitId),
    ).toEqual(['project:settings', 'record:rooms:hall']);
    expect(Object.keys(useNativeFieldDraftStore.getState().entries)).toHaveLength(0);
  });

  it('preserves the latest Room owner when the Definition view closes during a dispatched native Instance edit', async () => {
    const native = admitNativeRendererCommandFixture(projectWithRoomInstance());
    const held = holdFirstNativeProjectPatch();
    const view = render(
      <>
        <SharedInstanceField owner="record:interactables:door" tabId="definition" />
        <SharedInstanceField owner="record:rooms:hall" tabId="room" />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Update definition' }));
    await waitFor(() => expect(held.isHeld()).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Update room' }));
    expect(screen.getByTestId('room')).toHaveTextContent('room');
    expect(
      useDraftDirtyStore.getState().entriesByKey[
        nativeFieldDraftKey('record:rooms:hall', sharedPropertyPath)
      ]?.dirty,
    ).toBe(true);

    // Closing only the stale Definition tab must not revoke the live Room's
    // owner-specific draft, even though Definition's older patch is dispatched.
    view.rerender(<SharedInstanceField owner="record:rooms:hall" tabId="room" />);
    await act(async () => held.release());
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    expect(screen.getByTestId('room')).toHaveTextContent('room');
    expect(native.patch).toHaveBeenCalledTimes(2);
    expect(
      useCommandStore.getState().history.entries.map((entry) => entry.originSaveUnitId),
    ).toEqual(['record:interactables:door', 'record:rooms:hall']);
    expect(useProjectStore.getState().document).toMatchObject({
      interactableInstances: { 'door-1': { localProperties: [{ id: 'clue', value: 'room' }] } },
    });
    expect(Object.keys(useNativeFieldDraftStore.getState().entries)).toHaveLength(0);
  });

  it('retains a failed native exact-Instance field through Project restart and replay', async () => {
    admitNativeRendererCommandFixture(projectWithRoomInstance());
    const view = render(
      <SharedInstanceField owner="record:interactables:door" tabId="definition" />,
    );
    vi.spyOn(window.noveltea, 'nativeProjectPatch').mockRejectedValueOnce(
      new Error('Native worker unavailable'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Update definition' }));
    await waitFor(() =>
      expect(Object.values(useNativeFieldDraftStore.getState().entries)[0]?.error).toContain(
        'Native worker unavailable',
      ),
    );
    const serialized = serializeDraftDirtyState(useDraftDirtyStore.getState());
    const key = nativeFieldDraftKey('record:interactables:door', sharedPropertyPath);
    expect(serialized[key]?.payload).toMatchObject({
      value: [{ id: 'clue', value: 'definition' }],
    });
    view.unmount();
    useProjectStore.getState().clearProject();
    useCommandStore.getState().resetCommandHistory();
    useDraftDirtyStore.getState().resetDraftDirty();
    const native = admitNativeRendererCommandFixture(projectWithRoomInstance());
    useDraftDirtyStore.getState().restoreSerializedDrafts(serialized);
    render(<SharedInstanceField owner="record:interactables:door" tabId="definition" />);
    await waitFor(() => expect(screen.getByTestId('definition')).toHaveTextContent('definition'));
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    expect(native.patch).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().document).toMatchObject({
      interactableInstances: { 'door-1': { localProperties: [{ value: 'definition' }] } },
    });
  });

  it('rejects overlapping external exact-Instance updates without discarding a recoverable edit', async () => {
    const native = admitNativeRendererCommandFixture(projectWithRoomInstance());
    render(<SharedInstanceField owner="record:rooms:hall" tabId="room" />);
    fireEvent.click(screen.getByRole('button', { name: 'Update room' }));
    const state = useProjectStore.getState();
    const external = structuredClone(state.document);
    if (!isAuthoringProject(external)) throw new Error('Invalid fixture');
    external.interactableInstances['door-1']!.localProperties = [
      { id: 'clue', type: 'string', nullable: false, value: 'external' },
    ];
    act(() =>
      useProjectStore.setState({ document: external, projectRevision: state.projectRevision + 1 }),
    );
    expect(screen.getByTestId('room')).toHaveTextContent('room');
    await act(async () => expect(await projectEdits.flush()).toBe(false));
    expect(native.patch).not.toHaveBeenCalled();
    expect(Object.values(useNativeFieldDraftStore.getState().entries)[0]?.conflict).toBe(true);
    expect(useProjectStore.getState().document).toMatchObject({
      interactableInstances: { 'door-1': { localProperties: [{ value: 'external' }] } },
    });
    expect(
      useDraftDirtyStore.getState().entriesByKey[
        nativeFieldDraftKey('record:rooms:hall', sharedPropertyPath)
      ]?.dirty,
    ).toBe(true);
  });

  it('merges a disjoint native Project change across restart and requires explicit Keep mine for an overlap', async () => {
    admitNativeRendererCommandFixture(projectWithRoomInstance());
    const view = render(<SharedInstanceField owner="record:rooms:hall" tabId="room" />);
    fireEvent.click(screen.getByRole('button', { name: 'Update room' }));
    const serialized = serializeDraftDirtyState(useDraftDirtyStore.getState());
    view.unmount();
    useProjectStore.getState().clearProject();
    useCommandStore.getState().resetCommandHistory();
    useDraftDirtyStore.getState().resetDraftDirty();
    const disjoint = projectWithRoomInstance();
    disjoint.project.author = 'Outside author';
    const native = admitNativeRendererCommandFixture(disjoint);
    useDraftDirtyStore.getState().restoreSerializedDrafts(serialized);
    const recovered = render(<SharedInstanceField owner="record:rooms:hall" tabId="room" />);
    await waitFor(() => expect(screen.getByTestId('room')).toHaveTextContent('room'));
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    expect(native.patch).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().document).toMatchObject({
      project: { author: 'Outside author' },
      interactableInstances: { 'door-1': { localProperties: [{ value: 'room' }] } },
    });

    recovered.unmount();
    useProjectStore.getState().clearProject();
    useCommandStore.getState().resetCommandHistory();
    useDraftDirtyStore.getState().resetDraftDirty();
    admitNativeRendererCommandFixture(projectWithRoomInstance());
    const pending = render(<SharedInstanceField owner="record:rooms:hall" tabId="room" />);
    fireEvent.click(screen.getByRole('button', { name: 'Update room' }));
    const overlappingDraft = serializeDraftDirtyState(useDraftDirtyStore.getState());
    pending.unmount();
    useProjectStore.getState().clearProject();
    useCommandStore.getState().resetCommandHistory();
    useDraftDirtyStore.getState().resetDraftDirty();
    const overlapping = projectWithRoomInstance();
    overlapping.interactableInstances['door-1']!.localProperties = [
      { id: 'clue', type: 'string', nullable: false, value: 'external' },
    ];
    const nativeOverlap = admitNativeRendererCommandFixture(overlapping);
    useDraftDirtyStore.getState().restoreSerializedDrafts(overlappingDraft);
    render(<SharedInstanceField owner="record:rooms:hall" tabId="room" />);
    await waitFor(() =>
      expect(Object.values(useNativeFieldDraftStore.getState().entries)[0]?.conflict).toBe(true),
    );
    await act(async () => expect(await projectEdits.flush()).toBe(false));
    expect(nativeOverlap.patch).not.toHaveBeenCalled();
    await act(async () => expect(await projectEdits.keepMineField(sharedPropertyPath)).toBe(true));
    expect(nativeOverlap.patch).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().document).toMatchObject({
      interactableInstances: { 'door-1': { localProperties: [{ value: 'room' }] } },
    });
  });
  it('rejects ordinary field ownership and unrelated Save origins', () => {
    const projectData = makeProject();
    const room = defaultRoomData('Hall');
    room.interactables = [
      {
        id: 'door-occurrence',
        interactable: { $ref: { registry: 'interactableInstances', id: 'door-1' } },
        condition: { kind: 'always' },
        placementId: 'door-placement',
        visible: true,
        order: 0,
      },
    ];
    projectData.rooms.hall = { id: 'hall', label: 'Hall', data: room };
    const project = toJsonValue(projectData);
    const path = '/interactableInstances/door-1/localProperties';
    const input = {
      projectSessionId: 'session',
      projectInstanceId: 'instance',
      saveUnitId: 'record:interactables:door',
      path,
    };
    expect(fieldSaveUnitForPath(path)).toBeNull();
    expect(resolveExactInstanceFieldIdentity(input, project)).toEqual(input);
    expect(
      resolveExactInstanceFieldIdentity({ ...input, saveUnitId: 'record:rooms:hall' }, project)
        .saveUnitId,
    ).toBe('record:rooms:hall');
    expect(() =>
      resolveExactInstanceFieldIdentity(
        { ...input, saveUnitId: 'record:rooms:unrelated' },
        project,
      ),
    ).toThrow('not editable');
    expect(() =>
      resolveExactInstanceFieldIdentity(
        { ...input, path: '/interactableInstances/door-1' },
        project,
      ),
    ).toThrow('Invalid exact');
    expect(() =>
      resolveExactInstanceFieldIdentity(
        { ...input, path: '/interactableInstances/door-1/localProperties/0/value' },
        project,
      ),
    ).toThrow('Invalid exact');
    const inventoried = makeProject();
    inventoried.interactableInstances['door-1']!.location = {
      kind: 'inventory',
      inventory: projectInventoryRef(),
    };
    const inventoryDocument = toJsonValue(inventoried);
    expect(
      resolveExactInstanceFieldIdentity(
        {
          ...input,
          saveUnitId: 'project:settings',
          path: '/interactableInstances/door-1/quantity',
        },
        inventoryDocument,
      ).saveUnitId,
    ).toBe('project:settings');
    expect(() =>
      resolveExactInstanceFieldIdentity(
        { ...input, saveUnitId: 'project:settings' },
        inventoryDocument,
      ),
    ).toThrow('not editable');
  });

  it('stages two independent fields immediately while native patch acknowledgment is held', async () => {
    const project = makeProject();
    const native = admitNativeRendererCommandFixture(project);
    const held = holdFirstNativeProjectPatch();
    render(<Fields />);

    fireEvent.click(screen.getByRole('button', { name: 'Add local Property' }));
    expect(screen.getByTestId('property-count')).toHaveTextContent('1');
    await waitFor(() => expect(held.isHeld()).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Set Material' }));
    expect(screen.getByTestId('material-kind')).toHaveTextContent('panel');
    expect(native.patch).not.toHaveBeenCalled();
    expect(useProjectStore.getState().document).toMatchObject({
      interactableInstances: {
        'door-1': { localProperties: [], materialApplication: { material: null } },
      },
    });
    expect(
      Object.values(useDraftDirtyStore.getState().entriesByKey).filter((entry) => entry.dirty),
    ).toHaveLength(2);

    await act(async () => held.release());
    await waitFor(() => {
      expect(useProjectStore.getState().document).toMatchObject({
        interactableInstances: {
          'door-1': {
            localProperties: [{ id: 'clue', value: 'found' }],
            materialApplication: { material: { $ref: { collection: 'materials', id: 'panel' } } },
          },
        },
      });
    });
    expect(native.patch).toHaveBeenCalledTimes(2);
  });
});
