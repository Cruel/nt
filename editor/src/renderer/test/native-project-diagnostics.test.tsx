import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { toJsonValue } from '../project/json-value';
import { useProjectStore } from '../project/project-store';
import { useCommandStore } from '../commands/command-store';
import {
  currentNativeProjectDiagnostics,
  nativeProjectDiagnosticsReady,
  refreshNativeProjectDiagnostics,
  useNativeProjectDiagnostics,
} from '../project/native-project-diagnostics';

const session = '72ed9703-dfa9-4cb1-a68b-f7fdc13ae938';

afterEach(() => {
  useProjectStore.getState().clearProject();
  useCommandStore.getState().resetCommandHistory();
  vi.restoreAllMocks();
});

describe('native validation findings during edits', () => {
  it('keeps the previous findings visible until the next revision completes', async () => {
    const project = toJsonValue(createAuthoringProject());
    expect(
      useProjectStore.getState().loadProjectDocument({
        document: project,
        savedDocument: project,
        projectPath: '/tmp/diagnostic-flicker',
        projectFilePath: '/tmp/diagnostic-flicker/project.yaml',
        projectSessionId: session,
        scriptSourcePaths: {},
      }),
    ).toBe(true);
    useCommandStore.getState().resetCommandHistory();
    useCommandStore.getState().enableNativeCommandMode(0);

    const previous = {
      code: 'room.description.empty',
      severity: 'warning' as const,
      path: '/rooms/room/data/description',
      category: 'Room validation',
      message: 'Room description is empty.',
    };
    let finishNext!: (reply: { diagnostics: (typeof previous)[] }) => void;
    const validate = vi.fn((_session: string, revision: number) =>
      revision === 0
        ? Promise.resolve({ diagnostics: [previous] })
        : new Promise<{ diagnostics: (typeof previous)[] }>((resolve) => {
            finishNext = resolve;
          }),
    );
    Object.defineProperty(window.noveltea, 'nativeProjectValidate', {
      configurable: true,
      value: validate,
    });
    const { unmount } = renderHook(() => useNativeProjectDiagnostics());
    try {
      await act(async () => {
        await refreshNativeProjectDiagnostics();
      });
      expect(nativeProjectDiagnosticsReady()).toBe(true);
      expect(currentNativeProjectDiagnostics()).toEqual([previous]);

      act(() => useCommandStore.setState({ nativeMutationPending: true }));
      expect(currentNativeProjectDiagnostics()).toEqual([previous]);

      act(() =>
        useCommandStore.setState({ nativeMutationPending: false, nativeWorkingRevision: 1 }),
      );
      await waitFor(() => expect(validate).toHaveBeenCalledWith(session, 1));
      expect(nativeProjectDiagnosticsReady()).toBe(false);
      expect(currentNativeProjectDiagnostics()).toEqual([previous]);

      await act(async () => finishNext({ diagnostics: [] }));
      await waitFor(() => expect(nativeProjectDiagnosticsReady()).toBe(true));
      expect(currentNativeProjectDiagnostics()).toEqual([]);
    } finally {
      unmount();
    }
  });
});
