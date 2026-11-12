import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { MapEditor } from '@/editors/maps/MapEditor';
import { useProjectStore } from '@/project/project-store';
import { projectEdits } from '@/commands/project-editing';
import { usePendingInputStore } from '@/workbench/pending-input-store';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultMapData } from '../../shared/project-schema/authoring-maps';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import {
  admitNativeRendererCommandFixture,
  holdFirstNativeProjectPatch,
} from '../test-support/native-acknowledged-command-fixture';

const tab: WorkbenchTab = {
  id: 'tab:map-detail:maps:atlas',
  title: 'Atlas',
  editorType: 'map-detail',
  resource: {
    kind: 'record',
    stableId: 'record:maps:atlas',
    collection: 'maps',
    entityId: 'atlas',
  },
};

beforeEach(() => useProjectStore.getState().clearProject());

describe('Map editor buffered authoring', () => {
  it('retains incomplete location numbers as owner-scoped recoverable text', async () => {
    const project = createAuthoringProject();
    project.rooms.hall = { id: 'hall', label: 'Hall', data: defaultRoomData('Hall') };
    project.maps.atlas = { id: 'atlas', label: 'Atlas', data: defaultMapData() };
    admitNativeRendererCommandFixture(project);
    render(<MapEditor tab={tab} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Room Location' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Pick order' })).toBeInTheDocument(),
    );
    const pickOrder = screen.getByRole('textbox', { name: 'Pick order' });
    fireEvent.change(pickOrder, { target: { value: '-' } });
    fireEvent.blur(pickOrder);
    expect(pickOrder).toHaveValue('-');
    expect(usePendingInputStore.getState().entriesBySaveUnitId['record:maps:atlas']).toMatchObject({
      '/maps/atlas/data/locations/@location/pickOrder': { value: '-' },
    });
    fireEvent.change(pickOrder, { target: { value: '2' } });
    expect(pickOrder).toHaveValue('2');
    expect(
      usePendingInputStore.getState().entriesBySaveUnitId['record:maps:atlas'],
    ).toBeUndefined();
    await waitFor(() =>
      expect(useProjectStore.getState().document).toMatchObject({
        maps: { atlas: { data: { locations: [{ id: 'location', pickOrder: 2 }] } } },
      }),
    );
  });

  it('keeps a failed metadata draft recoverable without inventing native acknowledgment', async () => {
    const project = createAuthoringProject();
    project.maps.atlas = { id: 'atlas', label: 'Atlas', data: defaultMapData() };
    const native = admitNativeRendererCommandFixture(project);
    native.patch.mockRejectedValueOnce(new Error('Native map patch unavailable'));
    render(<MapEditor tab={tab} />);

    const title = screen.getByText('Title').parentElement!.querySelector('input')!;
    fireEvent.change(title, { target: { value: 'Recoverable Atlas' } });
    expect(title).toHaveValue('Recoverable Atlas');
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Native map patch unavailable'),
    );
    expect(useProjectStore.getState().document).toMatchObject({
      maps: { atlas: { data: { presentation: { title: null } } } },
    });
    expect(native.patch).toHaveBeenCalledTimes(1);
    expect(title).toHaveValue('Recoverable Atlas');
  });

  it('shares pending metadata across two views of the same Map', async () => {
    const project = createAuthoringProject();
    project.maps.atlas = { id: 'atlas', label: 'Atlas', data: defaultMapData() };
    admitNativeRendererCommandFixture(project);
    render(
      <>
        <MapEditor tab={tab} />
        <MapEditor tab={{ ...tab, id: `${tab.id}:other` }} />
      </>,
    );
    const titles = screen
      .getAllByText('Title')
      .map((heading) => heading.parentElement!.querySelector('input')!);
    fireEvent.change(titles[0]!, { target: { value: 'Shared Map Name' } });
    expect(titles[0]).toHaveValue('Shared Map Name');
    expect(titles[1]).toHaveValue('Shared Map Name');
  });

  it('preserves a stable location rename and sibling edits behind native acknowledgment', async () => {
    const project = createAuthoringProject();
    project.rooms.hall = { id: 'hall', label: 'Hall', data: defaultRoomData('Hall') };
    project.maps.atlas = {
      id: 'atlas',
      label: 'Atlas',
      data: {
        ...defaultMapData(),
        locations: [
          {
            id: 'old-location',
            room: { $ref: { collection: 'rooms', id: 'hall' } },
            regions: [
              {
                points: [
                  { x: 0.2, y: 0.2 },
                  { x: 0.8, y: 0.2 },
                  { x: 0.8, y: 0.8 },
                ],
              },
            ],
            label: null,
            icon: null,
            style: null,
            labelAnchor: null,
            connectionAnchor: null,
            visibility: { kind: 'always' },
            pickOrder: 0,
            logicalOrder: 0,
          },
        ],
      },
    };
    const native = admitNativeRendererCommandFixture(project);
    const held = holdFirstNativeProjectPatch();
    render(<MapEditor tab={tab} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Location label' }), {
      target: { value: 'The Hall' },
    });
    await waitFor(() => expect(held.isHeld()).toBe(true));
    const identity = screen.getByRole('textbox', { name: 'Location ID' });
    fireEvent.change(identity, { target: { value: 'new-location' } });
    expect(identity).toHaveValue('new-location');
    fireEvent.blur(identity);
    fireEvent.change(screen.getByRole('textbox', { name: 'Pick order' }), {
      target: { value: '2' },
    });
    expect(screen.getByRole('textbox', { name: 'Pick order' })).toHaveValue('2');
    expect(native.patch).not.toHaveBeenCalled();
    await act(async () => held.release());
    await act(async () => expect(await projectEdits.flush('record:maps:atlas')).toBe(true));
    await waitFor(() => {
      expect(useProjectStore.getState().document).toMatchObject({
        maps: {
          atlas: {
            data: {
              locations: [
                {
                  id: 'new-location',
                  pickOrder: 2,
                  label: { source: { kind: 'inline', text: 'The Hall' } },
                },
              ],
            },
          },
        },
      });
    });
    expect(native.patch.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it.each([500, 1000])(
    'preserves a text edit and a semantic location during a %i ms native hold',
    async (ms) => {
      const project = createAuthoringProject();
      project.maps.atlas = { id: 'atlas', label: 'Atlas', data: defaultMapData() };
      project.rooms.hall = { id: 'hall', label: 'Hall', data: defaultRoomData('Hall') };
      const native = admitNativeRendererCommandFixture(project);
      const held = holdFirstNativeProjectPatch();
      render(<MapEditor tab={tab} />);

      const title = screen.getByText('Title').parentElement!.querySelector('input')!;
      fireEvent.change(title, { target: { value: 'New Atlas' } });
      expect(title).toHaveValue('New Atlas');
      await waitFor(() => expect(held.isHeld()).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, ms));
      expect(title).toHaveValue('New Atlas');
      fireEvent.click(screen.getByRole('button', { name: 'Add Room Location' }));
      expect(screen.getByRole('textbox', { name: 'Location ID' })).toHaveValue('location');
      expect(native.patch).not.toHaveBeenCalled();

      await act(async () => held.release());
      await waitFor(() => {
        expect(useProjectStore.getState().document).toMatchObject({
          maps: {
            atlas: {
              data: {
                presentation: { title: { source: { kind: 'inline', text: 'New Atlas' } } },
                locations: [{ id: 'location', room: { $ref: { id: 'hall' } } }],
              },
            },
          },
        });
      });
      expect(native.patch.mock.calls.length).toBeLessThanOrEqual(2);
    },
  );
});
