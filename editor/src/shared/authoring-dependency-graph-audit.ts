import {
  AUTHORING_INTRINSIC_GRAPH_INPUTS,
  buildAuthoringStructuralDependencyGraph,
} from './authoring-dependency-graph';
import type {
  AuthoringDependencyGraph,
  AuthoringFieldGraphEffect,
} from './authoring-dependency-contracts';
import { jsonPointerSegmentsOverlap, type JsonPointer } from './json-pointer';
import type { AuthoringProject } from './project-schema/authoring-project';

export interface AuthoringGraphRegistryAuditMutation {
  name: string;
  path: JsonPointer;
  mutate(project: AuthoringProject): void;
  expectedGraphChange: boolean;
}

export interface AuthoringGraphRegistryAuditResult {
  name: string;
  path: JsonPointer;
  effect: AuthoringFieldGraphEffect;
  graphChanged: boolean;
}

function canonicalGraph(graph: AuthoringDependencyGraph): string {
  return JSON.stringify({
    nodes: [...graph.nodesByKey],
    edges: [...graph.edgesById],
    outgoing: [...graph.outgoingEdgeIdsByNodeKey],
    incoming: [...graph.incomingEdgeIdsByNodeKey],
    owned: [...graph.sourceNodeKeysByOwnedPath],
    diagnostics: graph.diagnostics,
  });
}

function classifyRegisteredPath(path: JsonPointer): AuthoringFieldGraphEffect | undefined {
  const matches = AUTHORING_INTRINSIC_GRAPH_INPUTS.filter((item) =>
    jsonPointerSegmentsOverlap(item.path, path),
  ).sort((left, right) => right.path.length - left.path.length);
  return matches[0]?.effect;
}

export function assertGraphInputRegistryComplete(
  fixture: AuthoringProject,
  validMutations: readonly AuthoringGraphRegistryAuditMutation[],
): readonly AuthoringGraphRegistryAuditResult[] {
  const before = buildAuthoringStructuralDependencyGraph(fixture);
  const beforeCanonical = canonicalGraph(before);
  return Object.freeze(
    validMutations.map((mutation) => {
      const effect = classifyRegisteredPath(mutation.path);
      if (!effect) {
        throw new Error(
          `Graph input registry does not classify ${mutation.path} (${mutation.name}).`,
        );
      }
      const current = structuredClone(fixture);
      mutation.mutate(current);
      const graphChanged =
        canonicalGraph(buildAuthoringStructuralDependencyGraph(current)) !== beforeCanonical;
      if (graphChanged !== mutation.expectedGraphChange) {
        throw new Error(
          `Graph registry audit mismatch for ${mutation.name} at ${mutation.path}: expected graphChanged=${mutation.expectedGraphChange}, received ${graphChanged}.`,
        );
      }
      if (effect.kind === 'none' && graphChanged) {
        throw new Error(`Graph-stable registry path changed graph output: ${mutation.path}.`);
      }
      return Object.freeze({ name: mutation.name, path: mutation.path, effect, graphChanged });
    }),
  );
}
