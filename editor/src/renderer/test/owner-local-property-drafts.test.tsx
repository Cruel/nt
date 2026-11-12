import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { RecordPropertyArrayDrafts } from '@/components/properties/RecordPropertyArrayDrafts';
import { useProjectStore } from '@/project/project-store';
import { useCommandStore } from '@/commands/command-store';
import { projectEdits } from '@/commands/project-editing';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { usePendingInputStore } from '@/workbench/pending-input-store';
import {
  createAuthoringProject,
  isAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import {
  admitNativeRendererCommandFixture,
  holdFirstNativeProjectPatch,
} from '../test-support/native-acknowledged-command-fixture';

function Properties({ collection, id }: { collection: 'rooms' | 'characters'; id: string }) {
  const project = useProjectStore((state) => state.document);
  if (!isAuthoringProject(project)) return null;
  const properties = project[collection][id]?.localProperties ?? [];
  return (
    <RecordPropertyArrayDrafts
      collection={collection}
      recordId={id}
      fieldName="localProperties"
      properties={properties}
      tabId={`tab:${id}`}
    >
      {(current, change) => (
        <div>
          <output data-testid={`${id}-properties`}>
            {current.map((item) => JSON.stringify(item.value)).join(',')}
          </output>
          <button
            onClick={() =>
              change([
                ...current.filter((item) => item.id !== 'nickname'),
                { id: 'nickname', type: 'string', nullable: false, value: `${id} alias` },
              ])
            }
          >
            Update {id}
          </button>
        </div>
      )}
    </RecordPropertyArrayDrafts>
  );
}

beforeEach(() => {
  useProjectStore.getState().clearProject();
  useCommandStore.getState().resetCommandHistory();
  useDraftDirtyStore.getState().resetDraftDirty();
  usePendingInputStore.getState().resetPendingInputs();
});

describe('shared owner-local Property Manager draft projection', () => {
  it('paints separate Room and Character Properties instantly, retains Save ownership and flushes both', async () => {
    const project = createAuthoringProject();
    project.rooms.hall = { id: 'hall', label: 'Hall', data: defaultRoomData('Hall') };
    project.characters.ada = { id: 'ada', label: 'Ada', data: defaultCharacterData('Ada') };
    const native = admitNativeRendererCommandFixture(project);
    const held = holdFirstNativeProjectPatch();
    render(
      <>
        <Properties collection="rooms" id="hall" />
        <Properties collection="characters" id="ada" />
      </>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Update hall' }));
    expect(screen.getByTestId('hall-properties')).toHaveTextContent('hall alias');
    await waitFor(() => expect(held.isHeld()).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Update ada' }));
    expect(screen.getByTestId('ada-properties')).toHaveTextContent('ada alias');
    expect(native.patch).not.toHaveBeenCalled();
    expect(useProjectStore.getState().document).toMatchObject({
      rooms: { hall: { label: 'Hall' } },
      characters: { ada: { label: 'Ada' } },
    });
    const drafts = Object.values(useDraftDirtyStore.getState().entriesByKey).filter(
      (entry) => entry.dirty,
    );
    expect(drafts).toHaveLength(2);
    await act(async () => held.release());
    await act(async () => expect(await projectEdits.flush()).toBe(true));
    await waitFor(() => {
      expect(useProjectStore.getState().document).toMatchObject({
        rooms: { hall: { localProperties: [{ id: 'nickname', value: 'hall alias' }] } },
        characters: { ada: { localProperties: [{ id: 'nickname', value: 'ada alias' }] } },
      });
    });
    expect(native.patch).toHaveBeenCalledTimes(2);
    expect(useDraftDirtyStore.getState().entriesByKey).toEqual({});
  });
});
