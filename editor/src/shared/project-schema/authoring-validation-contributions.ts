import { authoringCollectionKeys } from './authoring-collections';
import type { AuthoringProject } from './authoring-project';
import {
  classifyProjectValidationDiagnostics,
  type ProjectValidationDiagnostic,
  type ProjectValidationDiagnosticLike,
} from './project-validation';
import { escapeJsonPointerSegment } from '../json-pointer';

export interface AuthoringValidationContribution {
  readonly key: string;
  readonly inputPaths: readonly string[];
  readonly sourceRevisions: readonly Readonly<{ path: string; contentHash: string }>[];
  readonly diagnostics: readonly ProjectValidationDiagnostic[];
}

export interface AuthoringValidationReuse {
  readonly contributions: readonly AuthoringValidationContribution[];
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
  const previous = new Map(reuse?.contributions.map((entry) => [entry.key, entry]));
  const contributions: AuthoringValidationContribution[] = [];
  const work: AuthoringValidationWork = { executed: 0, reused: 0 };
  const run = (
    key: string,
    project: AuthoringProject,
    validate: (project: AuthoringProject, diagnostics: ProjectValidationDiagnosticLike[]) => void,
    derivedInputs: readonly string[] = [],
  ): readonly ProjectValidationDiagnostic[] => {
    key = `${scope}:${key}`;
    const prior = previous.get(key);
    if (prior && reuse) {
      if (
        reuse.changedSourcePaths &&
        prior.sourceRevisions.every((revision) => !reuse.changedSourcePaths!.has(revision.path))
      ) {
        contributions.push(prior);
        work.reused++;
        return prior.diagnostics;
      }
      const current = reuse.resolveInputs(prior.inputPaths);
      if (current && JSON.stringify(current) === JSON.stringify(prior.sourceRevisions)) {
        contributions.push(prior);
        work.reused++;
        return prior.diagnostics;
      }
    }
    work.executed++;
    const inputPaths = new Set(derivedInputs);
    const diagnostics: ProjectValidationDiagnosticLike[] = [];
    validate(reuse ? trackInputs(project, inputPaths) : project, diagnostics);
    const classified = classifyProjectValidationDiagnostics(diagnostics, { producer: 'authoring' });
    const paths = [...inputPaths].sort();
    const sourceRevisions = reuse?.resolveInputs(paths);
    if (sourceRevisions)
      contributions.push({ key, inputPaths: paths, sourceRevisions, diagnostics: classified });
    return classified;
  };
  return { run, contributions, work };
}
