import type {
  ProjectMutationChangeSet,
  ProjectMutationPublication,
} from '../../shared/authoring-dependency-contracts';
import { stripLocalEditorProjectState } from '../../shared/project-schema/editor-project-state';
import { type StructurallyAdmittedAuthoringProject } from '../../shared/project-schema/structurally-admitted-authoring-project';
import { buildJsonPointer, parseJsonPointer, type JsonPointer } from './json-pointer';
import { cloneJsonValue, type JsonValue } from './json-value';

export type ProjectMutationKind = ProjectMutationChangeSet['kind'];

let nextProjectInstanceId = 1;

export function createProjectInstanceId(): string {
  const cryptoObject = globalThis.crypto as Crypto | undefined;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
  const id = `project-instance:${nextProjectInstanceId}`;
  nextProjectInstanceId += 1;
  return id;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

export function canonicalMutationPaths(paths: readonly JsonPointer[]): readonly JsonPointer[] {
  return Object.freeze(
    [...new Set(paths.map((path) => buildJsonPointer(parseJsonPointer(path))))].sort((a, b) =>
      a.localeCompare(b),
    ),
  );
}

export interface AdmittedProjectCandidate {
  project: StructurallyAdmittedAuthoringProject;
  document: JsonValue;
}

export function admitProjectCandidate(
  value: unknown,
  _nativeAcknowledged = false,
): AdmittedProjectCandidate | null {
  const cloned = cloneJsonValue(value as JsonValue);
  // Native replies already own admission. Never repair or normalize their working projection.

  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) return null;
  return {
    project: deepFreeze(
      stripLocalEditorProjectState(cloned),
    ) as StructurallyAdmittedAuthoringProject,
    document: deepFreeze(cloned),
  };
}

export function createMutationPublication(input: {
  previousProject: StructurallyAdmittedAuthoringProject | null;
  project: StructurallyAdmittedAuthoringProject;
  projectInstanceId: string;
  projectRevision: number;
  kind: ProjectMutationKind;
  affectedPaths: readonly JsonPointer[];
}): ProjectMutationPublication<StructurallyAdmittedAuthoringProject> {
  return Object.freeze({
    previousProject: input.previousProject,
    project: input.project,
    changeSet: Object.freeze({
      projectInstanceId: input.projectInstanceId,
      projectRevision: input.projectRevision,
      kind: input.kind,
      affectedPaths: canonicalMutationPaths(input.affectedPaths),
    }),
  });
}
