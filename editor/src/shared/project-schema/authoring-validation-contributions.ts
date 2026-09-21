import { authoringCollectionKeys } from './authoring-collections';
import type { AuthoringProject } from './authoring-project';
import {
  classifyProjectValidationDiagnostics,
  type ProjectValidationDiagnostic,
  type ProjectValidationDiagnosticLike,
} from './project-validation';
import { escapeJsonPointerSegment } from '../json-pointer';
import { overlayReadonlyArray } from '../bounded-structural-sharing';

export interface AuthoringValidationContribution {
  readonly key: string;
  readonly inputPaths: readonly string[];
  readonly sourceRevisions: readonly Readonly<{ path: string; contentHash: string }>[];
  readonly diagnostics: readonly ProjectValidationDiagnostic[];
  /** Input paths could not be reduced to exact physical source revisions for reuse. */
  readonly unresolvedInputs?: true;
}

export interface AuthoringValidationReuse {
  readonly contributions: readonly AuthoringValidationContribution[];
  /** Resident-only key index so an incremental generation need not remap every prior check. */
  readonly contributionsByKey?: ReadonlyMap<string, AuthoringValidationContribution>;
  /** Exact check keys invalidated by the changed physical sources, including the scope prefix. */
  readonly changedContributionKeys?: ReadonlySet<string>;
  /** Stable prior-array positions for copy-on-write contribution replacement. */
  readonly contributionIndexes?: ReadonlyMap<string, number>;
  /** Aggregate diagnostics for the coherent base generation. */
  readonly baseDiagnostics?: readonly ProjectValidationDiagnostic[];
  /**
   * When a resident generation knows the exact physical files that changed, contributions whose
   * admitted source revisions do not intersect that set are reusable without re-resolving their
   * logical input paths. Structural inventory changes must omit this hint and use the conservative
   * path-resolution proof.
   */
  readonly changedSourcePaths?: ReadonlySet<string>;
  readonly resolveInputs: (
    paths: readonly string[],
  ) => AuthoringValidationContribution['sourceRevisions'] | null;
}

export interface AuthoringValidationWork {
  executed: number;
  reused: number;
}

function validationDiagnosticKey(diagnostic: ProjectValidationDiagnostic): string {
  return JSON.stringify(diagnostic);
}

const registries = new Set<string>([...authoringCollectionKeys, 'traits', 'interactableInstances']);

// Track complete records, not leaves: validators may pass records to parsers and derived models.
// Enumeration consumes the whole registry, including the absence of future/missing targets.
function trackInputs(project: AuthoringProject, inputs: Set<string>): AuthoringProject {
  const registryViews = new Map<string, object>();
  return new Proxy(project, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof key !== 'string') {
        inputs.add('/');
        return value;
      }
      const path = `/${escapeJsonPointerSegment(key)}`;
      if (!registries.has(key) || !value || typeof value !== 'object') {
        inputs.add(path);
        return value;
      }
      let view = registryViews.get(key);
      if (!view) {
        view = new Proxy(value, {
          get(records, id, recordReceiver) {
            inputs.add(typeof id === 'string' ? `${path}/${escapeJsonPointerSegment(id)}` : path);
            return Reflect.get(records, id, recordReceiver);
          },
          has(records, id) {
            inputs.add(typeof id === 'string' ? `${path}/${escapeJsonPointerSegment(id)}` : path);
            return Reflect.has(records, id);
          },
          ownKeys(records) {
            inputs.add(path);
            return Reflect.ownKeys(records);
          },
          getOwnPropertyDescriptor(records, id) {
            inputs.add(typeof id === 'string' ? `${path}/${escapeJsonPointerSegment(id)}` : path);
            return Reflect.getOwnPropertyDescriptor(records, id);
          },
        });
        registryViews.set(key, view);
      }
      return view;
    },
    has(target, key) {
      inputs.add(typeof key === 'string' ? `/${escapeJsonPointerSegment(key)}` : '/');
      return Reflect.has(target, key);
    },
    ownKeys(target) {
      inputs.add('/');
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      inputs.add(typeof key === 'string' ? `/${escapeJsonPointerSegment(key)}` : '/');
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
}

export function authoringValidationChecks(reuse?: AuthoringValidationReuse, scope = 'workspace') {
  const previous =
    reuse?.contributionsByKey ?? new Map(reuse?.contributions.map((entry) => [entry.key, entry]));
  const contributions = new Map<string, AuthoringValidationContribution>();
  const visited = new Set<string>();
  const work: AuthoringValidationWork = { executed: 0, reused: 0 };
  const incremental = Boolean(
    reuse?.changedContributionKeys && reuse.contributionIndexes && reuse.baseDiagnostics,
  );
  const scopedKey = (key: string) => `${scope}:${key}`;
  const priorIsUnchanged = (prior: AuthoringValidationContribution): boolean => {
    if (!reuse) return false;
    if (prior.unresolvedInputs) return false;
    if (
      reuse.changedSourcePaths &&
      prior.sourceRevisions.every((revision) => !reuse.changedSourcePaths!.has(revision.path))
    )
      return true;
    const current = reuse.resolveInputs(prior.inputPaths);
    return current !== null && JSON.stringify(current) === JSON.stringify(prior.sourceRevisions);
  };
  const pendingKeys = (): ReadonlySet<string> | null => {
    if (incremental) {
      const prefix = `${scope}:`;
      return new Set(
        [...reuse!.changedContributionKeys!]
          .filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length)),
      );
    }
    if (!reuse?.changedSourcePaths) return null;
    const prefix = `${scope}:`;
    return new Set(
      [...previous.values()]
        .filter((prior) => !priorIsUnchanged(prior) && prior.key.startsWith(prefix))
        .map((prior) => prior.key.slice(prefix.length)),
    );
  };
  const run = (
    key: string,
    project: AuthoringProject | (() => AuthoringProject),
    validate: (project: AuthoringProject, diagnostics: ProjectValidationDiagnosticLike[]) => void,
    derivedInputs: readonly string[] = [],
  ): readonly ProjectValidationDiagnostic[] => {
    key = scopedKey(key);
    visited.add(key);
    const prior = previous.get(key);
    if (incremental && prior && !reuse!.changedContributionKeys!.has(key)) return [];
    if (prior && priorIsUnchanged(prior)) {
      if (!incremental) {
        contributions.set(key, prior);
        work.reused++;
        return prior.diagnostics;
      }
      contributions.set(key, prior);
      return prior.diagnostics;
    }
    work.executed++;
    const inputPaths = new Set(derivedInputs);
    const diagnostics: ProjectValidationDiagnosticLike[] = [];
    const resolvedProject = typeof project === 'function' ? project() : project;
    validate(reuse ? trackInputs(resolvedProject, inputPaths) : resolvedProject, diagnostics);
    const classified = classifyProjectValidationDiagnostics(diagnostics, { producer: 'authoring' });
    const paths = [...inputPaths].sort();
    const sourceRevisions = reuse?.resolveInputs(paths);
    if (reuse)
      contributions.set(key, {
        key,
        inputPaths: paths,
        sourceRevisions: sourceRevisions ?? [],
        diagnostics: classified,
        ...(sourceRevisions ? {} : { unresolvedInputs: true as const }),
      });
    return classified;
  };
  const complete = () => {
    const diagnostics: ProjectValidationDiagnostic[] = [];
    if (incremental) {
      const changes = new Map<number, AuthoringValidationContribution>();
      for (const [key, contribution] of contributions) {
        const index = reuse!.contributionIndexes!.get(key);
        if (index === undefined)
          throw new Error(`Incremental validation contribution '${key}' has no stable index.`);
        changes.set(index, contribution);
      }
      const removeCounts = new Map<string, number>();
      for (const key of reuse!.changedContributionKeys!) {
        const prior = previous.get(key);
        if (!prior) continue;
        for (const diagnostic of prior.diagnostics) {
          const diagnosticKey = validationDiagnosticKey(diagnostic);
          removeCounts.set(diagnosticKey, (removeCounts.get(diagnosticKey) ?? 0) + 1);
        }
      }
      for (const diagnostic of reuse!.baseDiagnostics!) {
        const diagnosticKey = validationDiagnosticKey(diagnostic);
        const count = removeCounts.get(diagnosticKey) ?? 0;
        if (count === 0) diagnostics.push(diagnostic);
        else removeCounts.set(diagnosticKey, count - 1);
      }
      work.reused = Math.max(0, previous.size - work.executed);
      return {
        diagnostics,
        contributions: overlayReadonlyArray(reuse!.contributions, changes),
      };
    }
    // A full validation visits every live check; unvisited checks then belong to removed owners.
    if (reuse?.changedSourcePaths) {
      for (const prior of previous.values()) {
        if (visited.has(prior.key) || contributions.has(prior.key)) continue;
        contributions.set(prior.key, prior);
        work.reused++;
        diagnostics.push(...prior.diagnostics);
      }
    }
    return {
      diagnostics,
      contributions: [...contributions.values()].sort((left, right) =>
        left.key.localeCompare(right.key),
      ),
    };
  };
  return { run, pendingKeys, complete, work };
}
