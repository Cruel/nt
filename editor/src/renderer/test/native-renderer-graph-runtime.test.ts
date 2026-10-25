import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { toJsonValue } from '../project/json-value';
import { useProjectStore } from '../project/project-store';
import { useCommandStore } from '../commands/command-store';
import { startAuthoringDependencyGraphService } from '../project/authoring-dependency-graph-runtime';
import { nativeRendererGraphService } from '../project/native-authoring-graph-runtime';

const session = 'bb974e72-e2dd-43c4-b0ee-3c3b616d7418';
function nativeGraph(revision: number) {
  return {
    projectSessionId: session,
    generation: 2,
    workingRevision: revision,
    complete: true,
    incompleteOwners: [] as string[],
    sourceRevisions: { 'project.yaml': 'sha256:' + 'a'.repeat(64) },
    textSourceRevisions: {},
    nodes: [],
    edges: [],
    occurrences: [],
    diagnostics: [],
  };
}

function openNative() {
  const project = toJsonValue(
    createAuthoringProject({ id: 'native-graph-test', name: 'Native graph' }),
  );
  expect(
    useProjectStore.getState().loadProjectDocument({
      document: project,
      savedDocument: project,
      projectPath: '/tmp/native-graph-test',
      projectFilePath: '/tmp/native-graph-test/project.yaml',
      projectSessionId: session,
      scriptSourcePaths: {},
    }),
  ).toBe(true);
  useCommandStore.getState().resetCommandHistory();
  useCommandStore.getState().enableNativeCommandMode(0);
}

afterEach(() => {
  useProjectStore.getState().clearProject();
  useCommandStore.getState().resetCommandHistory();
  vi.restoreAllMocks();
});

describe('admitted native renderer graph lifecycle', () => {
  it('never builds the TypeScript semantic graph and accepts only the latest working revision', async () => {
    openNative();
    let resolveOlder!: (value: ReturnType<typeof nativeGraph>) => void;
    const older = new Promise<ReturnType<typeof nativeGraph>>((resolve) => {
      resolveOlder = resolve;
    });
    const read = vi.fn((_id: string, revision: number) =>
      revision === 0 ? older : Promise.resolve(nativeGraph(revision)),
    );
    Object.defineProperty(window.noveltea, 'nativeProjectSemanticGraph', {
      configurable: true,
      value: read,
    });
    const stop = startAuthoringDependencyGraphService();
    try {
      const oldQuery = nativeRendererGraphService.refresh();
      // The reply for working revision 0 must not overwrite the current one.
      useCommandStore.setState({ nativeWorkingRevision: 1 });
      const currentQuery = nativeRendererGraphService.refresh();
      await currentQuery;
      resolveOlder(nativeGraph(0));
      await oldQuery;
      expect(nativeRendererGraphService.currentSnapshot()?.nativeGraph.workingRevision).toBe(1);
      expect(read).toHaveBeenCalledWith(session, 1);
      // A refresh that is incomplete must remove the previously usable graph.
      read.mockImplementation(() =>
        Promise.resolve({
          ...nativeGraph(1),
          complete: false,
          incompleteOwners: ['rooms/missing'],
        }),
      );
      await nativeRendererGraphService.refresh();
      expect(nativeRendererGraphService.currentSnapshot()).toBeNull();
      expect(nativeRendererGraphService.error()).toContain('incomplete');
    } finally {
      stop();
    }
  });
});
