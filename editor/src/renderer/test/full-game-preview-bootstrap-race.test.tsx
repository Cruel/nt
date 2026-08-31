import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, render, waitFor } from '@testing-library/react';
import { FullGamePreviewEditor } from '@/editors/preview/FullGamePreviewEditor';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { usePendingInputStore } from '@/workbench/pending-input-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';

const bootstrapMocks = vi.hoisted(() => ({
  loadCompiledProject: vi.fn(),
  setEngineSettings: vi.fn().mockResolvedValue(undefined),
  requestRuntimeDebugSnapshot: vi.fn().mockResolvedValue(undefined),
  resolveLoad: null as (() => void) | null,
}));

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
}));

vi.mock('@/components/engine-preview', async () => {
  const React = await import('react');

  function EnginePreview({
    onPreviewMessage,
    onControlsContextChange,
    renderControls,
  }: {
    onPreviewMessage?: (message: unknown) => void;
    onControlsContextChange?: (context: unknown) => void;
    renderControls?: (context: unknown) => React.ReactNode;
  }) {
    const readySentRef = React.useRef(false);
    const context = React.useMemo(
      () => ({
        connectionState: 'ready',
        fpsCap: 0,
        setFpsCap: vi.fn(),
        reload: vi.fn(),
        sendRuntimeCommand: vi.fn(),
        controller: {
          loadCompiledProject: bootstrapMocks.loadCompiledProject,
          setEngineSettings: bootstrapMocks.setEngineSettings,
          requestRuntimeDebugSnapshot: bootstrapMocks.requestRuntimeDebugSnapshot,
        },
      }),
      [],
    );

    React.useLayoutEffect(() => {
      if (readySentRef.current) return;
      readySentRef.current = true;
      onPreviewMessage?.({
        version: 1,
        type: 'ready',
        capabilities: [],
        hostGeneration: 1,
        transportGeneration: 1,
        activeShaderVariant: 'glsl-120',
      });
    }, [onPreviewMessage]);

    React.useEffect(() => {
      onControlsContextChange?.(context);
      return () => onControlsContextChange?.(null);
    }, [context, onControlsContextChange]);

    return <div>{renderControls?.(context)}</div>;
  }

  return { EnginePreview };
});

beforeEach(() => {
  bootstrapMocks.resolveLoad = null;
  bootstrapMocks.loadCompiledProject.mockReset().mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        bootstrapMocks.resolveLoad = resolve;
      }),
  );
  bootstrapMocks.requestRuntimeDebugSnapshot.mockReset().mockResolvedValue(undefined);
  bootstrapMocks.setEngineSettings.mockReset().mockResolvedValue(undefined);

  usePreviewManagerStore.getState().resetPreviewManager();
  useWorkspaceStore.setState({
    previewConnectionState: 'disconnected',
    selectedRuntimeObjectId: null,
    lastPreviewEvent: null,
    statusMessage: 'Preview disconnected',
  });
  usePendingInputStore.getState().resetPendingInputs();
  useProjectStore.getState().clearProject();

  const project = createAuthoringProject();
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
  project.entrypoint = { kind: 'room', id: 'foyer' };
  useProjectStore.getState().loadUnsavedProjectDocument(project);
});

describe('FullGamePreviewEditor bootstrap ordering', () => {
  it('queues ready until controls exist and requests a snapshot only after project load', async () => {
    render(<FullGamePreviewEditor />);

    await waitFor(() => expect(bootstrapMocks.loadCompiledProject).toHaveBeenCalledTimes(1));
    expect(bootstrapMocks.requestRuntimeDebugSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      bootstrapMocks.resolveLoad?.();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(bootstrapMocks.requestRuntimeDebugSnapshot).toHaveBeenCalledTimes(1),
    );
    expect(bootstrapMocks.loadCompiledProject.mock.invocationCallOrder[0]).toBeLessThan(
      bootstrapMocks.requestRuntimeDebugSnapshot.mock.invocationCallOrder[0]!,
    );
  });
});
