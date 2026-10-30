import { vi } from 'vite-plus/test';
import type { NativeSemanticGraph } from '../../main/services/native-authoring-worker-contract';
import { authoringCollectionKeys } from '../../shared/project-schema/authoring-collections';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { projectNativeGraphForRenderer } from '../project/native-authoring-graph-projection';
import { useCommandStore } from '../commands/command-store';
import { nativeRendererGraphService } from '../project/native-authoring-graph-runtime';
import { useProjectStore } from '../project/project-store';

/** Tests of view/host lifecycle receive the native graph *transport DTO* as
 * an admitted fixture, never a synthesized semantic analyzer. Native semantic
 * edge discovery is covered by native C++/editor integration tests. */
export async function publishNativeViewGraphFixture(
  overrides: Partial<NativeSemanticGraph> = {},
): Promise<void> {
  const project = useProjectStore.getState();
  if (!project.document || !project.projectSessionId) throw new Error('Missing test Project.');
  if (useCommandStore.getState().nativeWorkingRevision === null)
    useCommandStore.getState().enableNativeCommandMode(0);
  const source = project.document as Record<string, unknown>;
  const nodes: NativeSemanticGraph['nodes'] = authoringCollectionKeys.flatMap((collection) =>
    Object.keys((source[collection] as Record<string, unknown> | undefined) ?? {}).map((id) => ({
      key: { kind: 'record' as const, collection, id },
      keyText: JSON.stringify(['record', collection, id]),
      owningPath: `/${collection}/${id}`,
      label: id,
    })),
  );
  const graph: NativeSemanticGraph = {
    projectSessionId: project.projectSessionId,
    generation: 1,
    workingRevision: useCommandStore.getState().nativeWorkingRevision ?? 0,
    complete: true,
    incompleteOwners: [],
    sourceRevisions: { 'project.yaml': `sha256:${'a'.repeat(64)}` },
    textSourceRevisions: {},
    nodes,
    edges: [],
    occurrences: [],
    diagnostics: [],
    ...overrides,
  };
  Object.defineProperty(window.noveltea, 'nativeProjectSemanticGraph', {
    configurable: true,
    value: vi.fn(async () => graph),
  });
  await nativeRendererGraphService.refresh();
}

/** A typed backend transport fixture for isolated preview projection tests.
 * Includes record identity only: no TypeScript reference or source analysis. */
export function nativeViewRecordGraphFixture(project: AuthoringProject) {
  return nativeViewRecordGraphSnapshotFixture(project).graph;
}

/** Complete, revision-bound transport snapshot for isolated command preflight. */
export function nativeViewRecordGraphSnapshotFixture(
  project: AuthoringProject,
  extra: { nodes?: NativeSemanticGraph['nodes']; edges?: NativeSemanticGraph['edges'] } = {},
) {
  const nodes: NativeSemanticGraph['nodes'] = authoringCollectionKeys.flatMap((collection) =>
    Object.keys(project[collection]).map((id) => ({
      key: { kind: 'record' as const, collection, id },
      keyText: JSON.stringify(['record', collection, id]),
      owningPath: `/${collection}/${id}`,
      label: id,
    })),
  );
  return projectNativeGraphForRenderer(
    {
      projectSessionId: '11111111-1111-4111-8111-111111111111',
      generation: 1,
      workingRevision: 1,
      complete: true,
      incompleteOwners: [],
      sourceRevisions: { 'project.yaml': `sha256:${'a'.repeat(64)}` },
      textSourceRevisions: {},
      nodes: [...nodes, ...(extra.nodes ?? [])],
      edges: extra.edges ?? [],
      occurrences: [],
      diagnostics: [],
    },
    'project-instance',
    1,
  );
}
