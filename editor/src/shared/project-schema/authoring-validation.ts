import type { ToolDiagnostic, ToolSeverity } from '../editor-tooling';
import { authoringCollectionKeys, isAuthoringCollectionKey, type AuthoringCollectionKey } from './authoring-collections';
import {
  authoringProjectSchema,
  isValidEntityId,
  type AuthoringProject,
  type ReferenceTarget,
} from './authoring-project';

function diagnostic(severity: ToolSeverity, path: string, message: string, category = 'authoring-schema'): ToolDiagnostic {
  return { severity, path, message, category };
}

function escapePathSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function targetExists(project: AuthoringProject, target: ReferenceTarget): boolean {
  return isAuthoringCollectionKey(target.collection) && !!project[target.collection][target.id];
}

function validateTarget(
  project: AuthoringProject,
  target: ReferenceTarget | null | undefined,
  path: string,
  diagnostics: ToolDiagnostic[],
) {
  if (!target) return;
  if (!isAuthoringCollectionKey(target.collection)) {
    diagnostics.push(diagnostic('error', `${path}/collection`, `Unknown collection '${String(target.collection)}'.`));
    return;
  }
  if (!targetExists(project, target)) {
    diagnostics.push(diagnostic('error', path, `Missing target '${target.collection}:${target.id}'.`));
  }
}

function detectCycles(
  project: AuthoringProject,
  collection: AuthoringCollectionKey,
  field: 'parent' | 'inherits',
  diagnostics: ToolDiagnostic[],
) {
  const records = project[collection];
  for (const id of Object.keys(records)) {
    const seen = new Set<string>();
    let current: string | null = id;
    while (current) {
      if (seen.has(current)) {
        diagnostics.push(diagnostic('error', `/${collection}/${escapePathSegment(id)}/${field}`, `${field} chain contains a cycle.`));
        break;
      }
      seen.add(current);
      const nextTarget: ReferenceTarget | null | undefined = records[current]?.[field];
      current = nextTarget?.collection === collection ? nextTarget.id : null;
    }
  }
}

export function validateAuthoringProject(value: unknown): ToolDiagnostic[] {
  const diagnostics: ToolDiagnostic[] = [];
  const parsed = authoringProjectSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      diagnostics.push(diagnostic('error', `/${issue.path.map(String).map(escapePathSegment).join('/')}`, issue.message));
    }
    return diagnostics;
  }

  const project = parsed.data;

  if (!project.entrypoint) {
    diagnostics.push(diagnostic('warning', '/entrypoint', 'No project entrypoint is configured yet.'));
  } else {
    validateTarget(project, project.entrypoint, '/entrypoint', diagnostics);
  }

  for (const collection of authoringCollectionKeys) {
    const records = project[collection];
    for (const [id, record] of Object.entries(records)) {
      const basePath = `/${collection}/${escapePathSegment(id)}`;
      if (!isValidEntityId(id)) {
        diagnostics.push(diagnostic('error', `/${collection}/${escapePathSegment(id)}`, `Invalid record id '${id}'.`));
      }
      if (record.id !== id) {
        diagnostics.push(diagnostic('error', `${basePath}/id`, `Record id '${record.id}' must match map key '${id}'.`));
      }
      if (!record.label.trim()) {
        diagnostics.push(diagnostic('error', `${basePath}/label`, 'Record label is required.'));
      }
      if (record.parent) {
        if (record.parent.id === id && record.parent.collection === collection) {
          diagnostics.push(diagnostic('error', `${basePath}/parent`, 'Record cannot parent itself.'));
        }
        validateTarget(project, record.parent, `${basePath}/parent`, diagnostics);
      }
      if (record.inherits) {
        if (record.inherits.id === id && record.inherits.collection === collection) {
          diagnostics.push(diagnostic('error', `${basePath}/inherits`, 'Record cannot inherit from itself.'));
        }
        validateTarget(project, record.inherits, `${basePath}/inherits`, diagnostics);
      }
    }
    detectCycles(project, collection, 'parent', diagnostics);
    detectCycles(project, collection, 'inherits', diagnostics);
  }

  return diagnostics;
}

export function authoringValidationSucceeded(diagnostics: ToolDiagnostic[]): boolean {
  return !diagnostics.some((item) => item.severity === 'error');
}
