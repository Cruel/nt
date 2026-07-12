import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoomEditor } from '@/editors/rooms/RoomEditor';
import { PreviewHostPoolProvider } from '@/preview/preview-host-pool';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import {
  captureWorkbenchTabState,
  clearWorkbenchTabStates,
  setWorkbenchTabState,
  useWorkbenchTabStateStore,
} from '@/workbench/workbench-tab-state';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';

vi.mock('@/hooks/use-engine-preview', () => ({
  useEnginePreview: () => ({
    iframeRef: { current: null },
    iframeKey: 0,
    iframeSrc: 'http://127.0.0.1:5000/?sessionToken=test-token',
    session: null,
    loadSession: vi.fn().mockResolvedValue({
      url: 'http://127.0.0.1:5000/?sessionToken=test-token',
      origin: 'http://127.0.0.1:5000',
      sessionToken: 'test-token',
    }),
    setPreviewWheelRouting: vi.fn().mockResolvedValue(undefined),
    setPreviewMode: vi.fn().mockResolvedValue(undefined),
    loadPreviewDocument: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/components/engine-preview-host', () => ({
  EnginePreviewHost: ({ iframeSrc }: { iframeSrc: string | null }) => (
    <iframe title="NovelTea engine preview" src={iframeSrc ?? undefined} />
  ),
}));

vi.mock('@/components/source/SourceEditor', () => ({
  SourceEditor: ({ value, onChange, className }: { value: string; onChange?: (value: string) => void; className?: string }) => (
    <textarea className={className} value={value} onChange={(event) => onChange?.(event.currentTarget.value)} />
  ),
}));

const tab: WorkbenchTab = {
  id: 'tab:room-detail:rooms:foyer',
  title: 'Foyer',
  editorType: 'room-detail',
  resource: {
    kind: 'record',
    stableId: 'record:rooms:foyer',
    collection: 'rooms',
    entityId: 'foyer',
  },
};

function renderRoomEditor() {
  return render(
    <div style={{ position: 'relative', width: 800, height: 600 }}>
      <PreviewHostPoolProvider groupId="test-group" activeTabId={tab.id}>
        <RoomEditor tab={tab} />
      </PreviewHostPoolProvider>
    </div>,
  );
}

beforeEach(() => {
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
  clearWorkbenchTabStates();
});

describe('RoomEditor', () => {
  it('renders typed room defaults and room preview', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    renderRoomEditor();

    expect(screen.getByText('Foyer')).toBeInTheDocument();
    expect(screen.getByText('Navigation paths')).toBeInTheDocument();
    expect(screen.getByText('Hotspots')).toBeInTheDocument();
    expect(screen.getByTitle('NovelTea engine preview')).toBeInTheDocument();
    expect(document.querySelector('[data-preview-pane-policy="pooled-per-tab-group"]')).toBeInTheDocument();
    expect(document.querySelector('[data-preview-pane-persistence="derived"]')).toBeInTheDocument();
    expect(document.querySelector('[data-preview-pane-mode="room"]')).toBeInTheDocument();
  });

  it('dispatches command-backed display name and hotspot updates', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    renderRoomEditor();

    fireEvent.change(screen.getByDisplayValue('Foyer'), { target: { value: 'Foyer East' } });
    await waitFor(() => {
      expect(useProjectStore.getState().document).toMatchObject({
        rooms: { foyer: { data: { displayName: 'Foyer East' } } },
      });
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('room.replaceData');

    fireEvent.click(screen.getByText('Add Hotspot'));
    await waitFor(() => {
      expect(useProjectStore.getState().document).toMatchObject({
        rooms: { foyer: { data: { hotspots: [expect.objectContaining({ id: 'hotspot' })] } } },
      });
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('room.replaceData');
  });

  it('chooses and clears a background image through the selector', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    project.assets.logo = {
      id: 'logo',
      label: 'Logo',
            data: { kind: 'image', source: { type: 'project-file', path: 'assets/images/logo.png' }, aliases: [], extension: '.png' },
    };
    project.assets.theme = {
      id: 'theme',
      label: 'Theme',
            data: { kind: 'audio', source: { type: 'project-file', path: 'assets/audio/theme.ogg' }, aliases: [], extension: '.ogg' },
    };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    renderRoomEditor();

    fireEvent.click(screen.getByText('No image'));
    expect(await screen.findByText('Choose a background image')).toBeInTheDocument();
    expect(screen.getByText('Logo')).toBeInTheDocument();
    expect(screen.queryByText('Theme')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Logo'));
    await waitFor(() => expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { data: { background: { asset: { $ref: { collection: 'assets', id: 'logo' } } } } } },
    }));
    await waitFor(() => expect(screen.queryByText('Choose a background image')).not.toBeInTheDocument());
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('room.replaceData');

    fireEvent.click(screen.getByText('Clear'));
    await waitFor(() => expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { data: { background: { asset: null } } } },
    }));
  });

  it('captures and restores tab state for scroll without persisting transient selector state', async () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    const view = renderRoomEditor();
    const scrollContainer = view.container.querySelector<HTMLElement>('[data-room-editor-scroll]')!;
    scrollContainer.scrollTop = 96;

    fireEvent.click(screen.getByText('No image'));
    expect(await screen.findByText('Choose a background image')).toBeInTheDocument();

    captureWorkbenchTabState(tab.id);

    expect(useWorkbenchTabStateStore.getState().tabStatesById[tab.id]).toMatchObject({
      schema: 'noveltea.editor.tab-state.room',
      payload: {
        scroll: { scrollTop: 96, scrollLeft: 0 },
      },
    });
    expect(useWorkbenchTabStateStore.getState().tabStatesById[tab.id]?.payload).not.toHaveProperty('backgroundSelectorOpen');

    view.unmount();
    setWorkbenchTabState(tab.id, {
      schema: 'noveltea.editor.tab-state.room',
      schemaVersion: 1,
      payload: {
        scroll: { scrollTop: 48, scrollLeft: 0 },
        backgroundSelectorOpen: true,
      },
    });

    const restoredView = renderRoomEditor();

    await waitFor(() => expect(screen.queryByText('Choose a background image')).not.toBeInTheDocument());
    await waitFor(() => expect(restoredView.container.querySelector<HTMLElement>('[data-room-editor-scroll]')?.scrollTop).toBe(48));
  });
});
