import {
  assembleAuthoringDependencyGraph,
  buildAuthoringStructuralDependencyGraphContributionSet,
  buildAuthoringStructuralDependencyGraph,
  classifyAuthoringGraphInputPath,
  replaceAuthoringDependencyGraphContributions,
} from './authoring-dependency-graph';
import type {
  AuthoringDependencyGraph,
  AuthoringDependencyGraphContribution,
  AuthoringFieldGraphEffect,
} from './authoring-dependency-contracts';
import type { JsonPointer } from './json-pointer';
import { assertAuthoringGraphFieldMetadataComplete } from './project-schema/authoring-graph-field-metadata';
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
  incrementallyReplacedContributionKeys: readonly string[];
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

function canonicalContribution(
  contribution: AuthoringDependencyGraphContribution | undefined,
): string {
  return contribution === undefined ? '' : JSON.stringify(contribution);
}

export function assertGraphInputRegistryComplete(
  fixture: AuthoringProject,
  validMutations: readonly AuthoringGraphRegistryAuditMutation[],
): readonly AuthoringGraphRegistryAuditResult[] {
  assertAuthoringGraphFieldMetadataComplete();
  const beforeContributions = buildAuthoringStructuralDependencyGraphContributionSet(fixture);
  const before = assembleAuthoringDependencyGraph(beforeContributions);
  const beforeCanonical = canonicalGraph(before);
  return Object.freeze(
    validMutations.map((mutation) => {
      const classification = classifyAuthoringGraphInputPath(mutation.path);
      if (!classification) {
        throw new Error(
          `Graph input registry does not classify ${mutation.path} (${mutation.name}).`,
        );
      }
      const effect = classification.effect;
      const current = structuredClone(fixture);
      mutation.mutate(current);
      const afterContributions = buildAuthoringStructuralDependencyGraphContributionSet(current);
      const after = assembleAuthoringDependencyGraph(afterContributions);
      const directAfter = buildAuthoringStructuralDependencyGraph(current);
      const afterCanonical = canonicalGraph(after);
      if (canonicalGraph(directAfter) !== afterCanonical) {
        throw new Error(
          `Full structural graph builder diverged from contribution assembly for ${mutation.name}.`,
        );
      }

      const changedContributionKeys = [
        ...new Set([...beforeContributions.byKey.keys(), ...afterContributions.byKey.keys()]),
      ]
        .filter(
          (key) =>
            canonicalContribution(beforeContributions.byKey.get(key)) !==
            canonicalContribution(afterContributions.byKey.get(key)),
        )
        .sort();
      const replacements = changedContributionKeys
        .map((key) => afterContributions.byKey.get(key))
        .filter(
          (contribution): contribution is AuthoringDependencyGraphContribution =>
            contribution !== undefined,
        );
      const removedKeys = changedContributionKeys.filter(
        (key) => !afterContributions.byKey.has(key),
      );
      const incremental = assembleAuthoringDependencyGraph(
        replaceAuthoringDependencyGraphContributions(
          beforeContributions,
          replacements,
          removedKeys,
        ),
      );
      if (canonicalGraph(incremental) !== afterCanonical) {
        throw new Error(
          `Incremental contribution replacement diverged from the fresh full graph for ${mutation.name} at ${mutation.path}.`,
        );
      }

      const graphChanged = afterCanonical !== beforeCanonical;
      if (graphChanged !== mutation.expectedGraphChange) {
        throw new Error(
          `Graph registry audit mismatch for ${mutation.name} at ${mutation.path}: expected graphChanged=${mutation.expectedGraphChange}, received ${graphChanged}.`,
        );
      }
      if (effect.kind === 'none' && graphChanged) {
        throw new Error(`Graph-stable registry path changed graph output: ${mutation.path}.`);
      }
      return Object.freeze({
        name: mutation.name,
        path: mutation.path,
        effect,
        graphChanged,
        incrementallyReplacedContributionKeys: Object.freeze(changedContributionKeys),
      });
    }),
  );
}
