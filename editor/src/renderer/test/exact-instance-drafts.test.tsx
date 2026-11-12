import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { ExactInstanceDrafts } from '@/components/properties/ExactInstanceDrafts';
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

beforeEach(() => {
  useProjectStore.getState().clearProject();
  useCommandStore.getState().resetCommandHistory();
  useDraftDirtyStore.getState().resetDraftDirty();
  usePendingInputStore.getState().resetPendingInputs();
});

describe('exact Interactable Instance owner-scoped drafts', () => {
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
