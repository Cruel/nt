import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { WorkbenchGroup } from '@/workbench/WorkbenchGroup';
import { WorkbenchTabDndContext } from '@/workbench/WorkbenchTabDndContext';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import type { WorkbenchGroup as WorkbenchGroupModel, WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';

const previewControllers = vi.hoisted(() => ({
  created: 0,
  setPreviewModeCalls: [] as string[],
  loadPreviewDocumentCalls: [] as Array<{ kind: string; recordId: string; revision: string; data: Record<string, unknown> }>,
  nextSetPreviewModePromise: null as Promise<void> | null,
}));

vi.mock('@/hooks/use-engine-preview', () => ({
  useEnginePreview: (options: { onReady?: () => void } = {}) => {
    previewControllers.created += 1;
    queueMicrotask(() => options.onReady?.());
    return {
      iframeRef: { current: null },
      iframeKey: previewControllers.created,
      iframeSrc: `http://127.0.0.1:5000/?sessionToken=test-token-${previewControllers.created}`,
      session: null,
      loadSession: vi.fn().mockResolvedValue({
        url: `http://127.0.0.1:5000/?sessionToken=test-token-${previewControllers.created}`,
        origin: 'http://127.0.0.1:5000',
        sessionToken: `test-token-${previewControllers.created}`,
      }),
      setPreviewWheelRouting: vi.fn().mockResolvedValue(undefined),
      setPreviewMode: vi.fn((mode: string) => {
        previewControllers.setPreviewModeCalls.push(mode);
        const pending = previewControllers.nextSetPreviewModePromise;
        previewControllers.nextSetPreviewModePromise = null;
        return pending ?? Promise.resolve();
      }),
      loadPreviewDocument: vi.fn((document: { kind: string; recordId: string; revision: string; data: Record<string, unknown> }) => {
        previewControllers.loadPreviewDocumentCalls.push(document);
        return Promise.resolve();
      }),
    };
  },
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

const roomATab: WorkbenchTab = {
  id: 'tab:room:a',
  title: 'Room A',
  editorType: 'room-detail',
  resource: { kind: 'record', stableId: 'record:rooms:room-a', collection: 'rooms', entityId: 'room-a' },
};

const roomBTab: WorkbenchTab = {
  id: 'tab:room:b',
  title: 'Room B',
  editorType: 'room-detail',
  resource: { kind: 'record', stableId: 'record:rooms:room-b', collection: 'rooms', entityId: 'room-b' },
};

const nonPreviewTab: WorkbenchTab = {
  id: 'tab:assets',
  title: 'Assets',
  editorType: 'asset-library',
  resource: { kind: 'tool', stableId: 'tool:assets' },
};

function group(activeTabId: string | null, tabIds: string[] = [roomATab.id, roomBTab.id, nonPreviewTab.id]): WorkbenchGroupModel {
  return { id: 'root', activeTabId, tabIds };
}

function renderGroup(model: WorkbenchGroupModel, tabs: WorkbenchTab[] = [roomATab, roomBTab, nonPreviewTab]) {
  return render(
    <WorkbenchTabDndContext>
      <WorkbenchGroup group={model} tabs={tabs} />
    </WorkbenchTabDndContext>,
  );
}

function hostElements(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-preview-host-id]')];
}

function resetPreviewControllerState() {
  previewControllers.created = 0;
  previewControllers.setPreviewModeCalls = [];
  previewControllers.loadPreviewDocumentCalls = [];
  previewControllers.nextSetPreviewModePromise = null;
}

beforeEach(() => {
  resetPreviewControllerState();
  useCommandStore.getState().resetCommandHistory();
  useWorkbenchStore.getState().resetWorkbench();
  useProjectStore.getState().clearProject();
  const project = createAuthoringProject();
  project.rooms['room-a'] = { id: 'room-a', label: 'Room A', data: defaultRoomData('Room A') };
  project.rooms['room-b'] = { id: 'room-b', label: 'Room B', data: defaultRoomData('Room B') };
  useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });
});

describe('RoomEditor pooled room preview', () => {
  it('reuses a warm pooled host when switching Room A to Room B', async () => {
    const view = renderGroup(group(roomATab.id));

    await waitFor(() => expect(hostElements(view.container)).toHaveLength(1));
    await waitFor(() => expect(previewControllers.loadPreviewDocumentCalls.at(-1)?.recordId).toBe('room-a'));
    const firstHostId = hostElements(view.container)[0]?.dataset.previewHostId;

    view.rerender(
      <WorkbenchTabDndContext>
        <WorkbenchGroup group={group(roomBTab.id)} tabs={[roomATab, roomBTab, nonPreviewTab]} />
      </WorkbenchTabDndContext>,
    );

    await waitFor(() => expect(previewControllers.loadPreviewDocumentCalls.at(-1)?.recordId).toBe('room-b'));
    expect(hostElements(view.container)).toHaveLength(1);
    expect(hostElements(view.container)[0]?.dataset.previewHostId).toBe(firstHostId);
  });

  it('sends a complete room preview payload to Room B on claim', async () => {
    const view = renderGroup(group(roomBTab.id));

    await waitFor(() => expect(previewControllers.loadPreviewDocumentCalls.at(-1)?.recordId).toBe('room-b'));

    const payload = previewControllers.loadPreviewDocumentCalls.at(-1);
    expect(payload).toMatchObject({
      kind: 'room-preview',
      recordId: 'room-b',
      data: expect.objectContaining({ schema: 'noveltea.room-preview.v1', roomId: 'room-b' }),
    });
    expect(payload?.revision).toEqual(expect.any(String));
    expect(payload?.revision.length).toBeGreaterThan(0);
    expect(hostElements(view.container)[0]).toHaveAttribute('data-preview-host-pane-id', 'main');
  });

  it('ignores stale Room A sends after Room A releases its lease', async () => {
    const releaseRoomAModeRef: { current: (() => void) | null } = { current: null };
    previewControllers.nextSetPreviewModePromise = new Promise<void>((resolve) => {
      releaseRoomAModeRef.current = resolve;
    });
    const view = renderGroup(group(roomATab.id));

    await waitFor(() => expect(previewControllers.setPreviewModeCalls).toHaveLength(1));
    expect(previewControllers.loadPreviewDocumentCalls).toHaveLength(0);

    view.rerender(
      <WorkbenchTabDndContext>
        <WorkbenchGroup group={group(roomBTab.id)} tabs={[roomATab, roomBTab, nonPreviewTab]} />
      </WorkbenchTabDndContext>,
    );

    await waitFor(() => expect(previewControllers.loadPreviewDocumentCalls.at(-1)?.recordId).toBe('room-b'));
    releaseRoomAModeRef.current?.();

    await Promise.resolve();
    expect(previewControllers.loadPreviewDocumentCalls.map((call) => call.recordId)).toEqual(['room-b']);
  });

  it('hides and releases the room preview host on a non-preview tab without destroying it', async () => {
    const view = renderGroup(group(roomATab.id));
    await waitFor(() => expect(hostElements(view.container)).toHaveLength(1));
    const firstHostId = hostElements(view.container)[0]?.dataset.previewHostId;

    view.rerender(
      <WorkbenchTabDndContext>
        <WorkbenchGroup group={group(nonPreviewTab.id)} tabs={[roomATab, roomBTab, nonPreviewTab]} />
      </WorkbenchTabDndContext>,
    );

    await waitFor(() => expect(hostElements(view.container)[0]).not.toHaveAttribute('data-preview-host-claimed'));
    expect(hostElements(view.container)).toHaveLength(1);
    expect(hostElements(view.container)[0]?.dataset.previewHostId).toBe(firstHostId);
    expect(hostElements(view.container)[0]).toHaveAttribute('aria-hidden', 'true');
  });

  it('destroys the pooled host when the workbench group closes', async () => {
    const view = renderGroup(group(roomATab.id));
    await waitFor(() => expect(hostElements(view.container)).toHaveLength(1));

    view.unmount();

    expect(hostElements(view.container)).toHaveLength(0);
  });
});
