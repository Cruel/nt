import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { render, waitFor } from '@testing-library/react';
import { WorkbenchGroup } from '@/workbench/WorkbenchGroup';
import { WorkbenchTabDndContext } from '@/workbench/WorkbenchTabDndContext';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { authoringDependencyGraphService } from '@/project/authoring-dependency-graph-runtime';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import type {
  WorkbenchGroup as WorkbenchGroupModel,
  WorkbenchTab,
} from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import type { PreviewToEditorMessage } from '../../shared/preview-protocol';

const previewControllers = vi.hoisted(() => ({
  created: 0,
  setPreviewModeCalls: [] as string[],
  loadPreviewDocumentCalls: [] as Array<{
    kind: string;
    recordId: string;
    revision: string;
    data: Record<string, unknown>;
  }>,
  applyFocusedDocumentCalls: [] as Array<{
    kind: string;
    recordId: string;
    revision: string;
    data: Record<string, unknown>;
  }>,
  nextApplyFocusedPromise: null as Promise<void> | null,
}));

vi.mock('@/hooks/use-engine-preview', () => ({
  useEnginePreview: (
    options: {
      onReady?: () => void;
      onMessage?: (message: PreviewToEditorMessage) => void;
    } = {},
  ) => {
    previewControllers.created += 1;
    queueMicrotask(() => {
      options.onReady?.();
      options.onMessage?.({
        version: 1,
        type: 'ready',
        capabilities: [],
        hostGeneration: 1,
        transportGeneration: 1,
        activeShaderVariant: 'glsl-120',
      });
    });
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
      setEngineSettings: vi.fn().mockResolvedValue(undefined),
      setPreviewMode: vi.fn((mode: string) => {
        previewControllers.setPreviewModeCalls.push(mode);
        return Promise.resolve();
      }),
      loadPreviewDocument: vi.fn(
        (document: {
          kind: string;
          recordId: string;
          revision: string;
          data: Record<string, unknown>;
        }) => {
          previewControllers.loadPreviewDocumentCalls.push(document);
          return Promise.resolve();
        },
      ),
      applyFocusedEditorDocument: vi.fn(
        (document: {
          kind: string;
          recordId: string;
          revision: string;
          data: Record<string, unknown>;
        }) => {
          previewControllers.applyFocusedDocumentCalls.push(document);
          const pending = previewControllers.nextApplyFocusedPromise;
          previewControllers.nextApplyFocusedPromise = null;
          return pending ?? Promise.resolve();
        },
      ),
    };
  },
}));

vi.mock('@/components/engine-preview-host', () => ({
  EnginePreviewHost: ({ iframeSrc }: { iframeSrc: string | null }) => (
    <iframe title="NovelTea engine preview" src={iframeSrc ?? undefined} />
  ),
}));

vi.mock('@/components/source/SourceEditor', () => ({
  SourceEditor: ({
    value,
    onChange,
    className,
  }: {
    value: string;
    onChange?: (value: string) => void;
    className?: string;
  }) => (
    <textarea
      className={className}
      value={value}
      onChange={(event) => onChange?.(event.currentTarget.value)}
    />
  ),
}));

const roomATab: WorkbenchTab = {
  id: 'tab:room:a',
  title: 'Room A',
  editorType: 'room-detail',
  resource: {
    kind: 'record',
    stableId: 'record:rooms:room-a',
    collection: 'rooms',
    entityId: 'room-a',
  },
};

const roomBTab: WorkbenchTab = {
  id: 'tab:room:b',
  title: 'Room B',
  editorType: 'room-detail',
  resource: {
    kind: 'record',
    stableId: 'record:rooms:room-b',
    collection: 'rooms',
    entityId: 'room-b',
  },
};

const nonPreviewTab: WorkbenchTab = {
  id: 'tab:assets',
  title: 'Assets',
  editorType: 'asset-library',
  resource: { kind: 'tool', stableId: 'tool:assets' },
};

function group(
  activeTabId: string | null,
  tabIds: string[] = [roomATab.id, roomBTab.id, nonPreviewTab.id],
): WorkbenchGroupModel {
  return { id: 'root', activeTabId, tabIds };
}

function renderGroup(
  model: WorkbenchGroupModel,
  tabs: WorkbenchTab[] = [roomATab, roomBTab, nonPreviewTab],
) {
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
  previewControllers.applyFocusedDocumentCalls = [];
  previewControllers.nextApplyFocusedPromise = null;
}

beforeEach(async () => {
  resetPreviewControllerState();
  useCommandStore.getState().resetCommandHistory();
  useWorkbenchStore.getState().resetWorkbench();
  useProjectStore.getState().clearProject();
  const project = createAuthoringProject();
  project.rooms['room-a'] = { id: 'room-a', label: 'Room A', data: defaultRoomData('Room A') };
  project.rooms['room-b'] = { id: 'room-b', label: 'Room B', data: defaultRoomData('Room B') };
  useProjectStore.getState().loadProjectDocument({
    document: project,
    projectPath: '/mock',
    projectFilePath: '/mock/project.json',
    projectSessionId: '11111111-1111-4111-8111-111111111111',
  });
  await authoringDependencyGraphService.publish(
    useProjectStore.getState().lastMutationPublication!,
  );
});

describe('RoomEditor persistent room preview', () => {
  it('keeps one iframe per open Room tab while the editor subtree remounts', async () => {
    const view = renderGroup(group(roomATab.id));

    await waitFor(() => expect(hostElements(view.container)).toHaveLength(1));
    await waitFor(() =>
      expect(previewControllers.applyFocusedDocumentCalls.at(-1)?.recordId).toBe('room-a'),
    );
    const roomAHost = hostElements(view.container)[0]!;
    const roomAHostId = roomAHost.dataset.previewHostId;
    const roomAIframe = roomAHost.querySelector('iframe');

    view.rerender(
      <WorkbenchTabDndContext>
        <WorkbenchGroup group={group(roomBTab.id)} tabs={[roomATab, roomBTab, nonPreviewTab]} />
      </WorkbenchTabDndContext>,
    );

    await waitFor(() =>
      expect(previewControllers.applyFocusedDocumentCalls.at(-1)?.recordId).toBe('room-b'),
    );
    expect(hostElements(view.container)).toHaveLength(2);
    expect(roomAHost).not.toHaveAttribute('data-preview-host-claimed');
    expect(roomAHost).toHaveAttribute('aria-hidden', 'true');
    const roomBHost = hostElements(view.container).find(
      (host) => host.dataset.previewHostOwnerTabId === roomBTab.id,
    );
    expect(roomBHost).toHaveAttribute('data-preview-host-claimed', 'true');

    view.rerender(
      <WorkbenchTabDndContext>
        <WorkbenchGroup group={group(roomATab.id)} tabs={[roomATab, roomBTab, nonPreviewTab]} />
      </WorkbenchTabDndContext>,
    );

    await waitFor(() => expect(roomAHost).toHaveAttribute('data-preview-host-claimed', 'true'));
    expect(hostElements(view.container)).toHaveLength(2);
    expect(roomAHost.dataset.previewHostId).toBe(roomAHostId);
    expect(roomAHost.querySelector('iframe')).toBe(roomAIframe);
    expect(roomAHost).toHaveAttribute('data-preview-host-visible', 'true');
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    expect(previewControllers.applyFocusedDocumentCalls.map((call) => call.recordId)).toEqual([
      'room-a',
      'room-b',
    ]);
  });

  it('sends a complete room preview payload to Room B on claim', async () => {
    const view = renderGroup(group(roomBTab.id));

    await waitFor(() =>
      expect(previewControllers.applyFocusedDocumentCalls.at(-1)?.recordId).toBe('room-b'),
    );

    const payload = previewControllers.applyFocusedDocumentCalls.at(-1);
    expect(payload).toMatchObject({
      kind: 'room-preview',
      recordId: 'room-b',
      data: expect.objectContaining({ schema: 'noveltea.room-preview' }),
    });
    expect(payload?.revision).toEqual(expect.any(String));
    expect(payload?.revision.length).toBeGreaterThan(0);
    expect(hostElements(view.container)[0]).toHaveAttribute('data-preview-host-pane-id', 'main');
  });

  it('ignores stale Room A sends after Room A releases its lease', async () => {
    const releaseRoomAApplyRef: { current: (() => void) | null } = { current: null };
    previewControllers.nextApplyFocusedPromise = new Promise<void>((resolve) => {
      releaseRoomAApplyRef.current = resolve;
    });
    const view = renderGroup(group(roomATab.id));

    await waitFor(() => expect(previewControllers.applyFocusedDocumentCalls).toHaveLength(1));

    view.rerender(
      <WorkbenchTabDndContext>
        <WorkbenchGroup group={group(roomBTab.id)} tabs={[roomATab, roomBTab, nonPreviewTab]} />
      </WorkbenchTabDndContext>,
    );

    await waitFor(() =>
      expect(previewControllers.applyFocusedDocumentCalls.at(-1)?.recordId).toBe('room-b'),
    );
    releaseRoomAApplyRef.current?.();

    await Promise.resolve();
    expect(previewControllers.applyFocusedDocumentCalls.map((call) => call.recordId)).toEqual([
      'room-a',
      'room-b',
    ]);
  });

  it('hides and releases the room preview host on a non-preview tab without destroying it', async () => {
    const view = renderGroup(group(roomATab.id));
    await waitFor(() => expect(hostElements(view.container)).toHaveLength(1));
    const firstHostId = hostElements(view.container)[0]?.dataset.previewHostId;

    view.rerender(
      <WorkbenchTabDndContext>
        <WorkbenchGroup
          group={group(nonPreviewTab.id)}
          tabs={[roomATab, roomBTab, nonPreviewTab]}
        />
      </WorkbenchTabDndContext>,
    );

    await waitFor(() =>
      expect(hostElements(view.container)[0]).not.toHaveAttribute('data-preview-host-claimed'),
    );
    expect(hostElements(view.container)).toHaveLength(1);
    expect(hostElements(view.container)[0]?.dataset.previewHostId).toBe(firstHostId);
    expect(hostElements(view.container)[0]).toHaveAttribute('aria-hidden', 'true');
  });

  it('destroys the persistent host when the workbench group closes', async () => {
    const view = renderGroup(group(roomATab.id));
    await waitFor(() => expect(hostElements(view.container)).toHaveLength(1));

    view.unmount();

    expect(hostElements(view.container)).toHaveLength(0);
  });
});
