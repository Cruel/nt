import type {
  ProjectContentSaveRequest,
  ProjectMutationPathValue,
} from '../../shared/editor-tooling';
import {
  stripLocalEditorProjectState,
  type EditorRecoveryState,
} from '../../shared/project-schema/editor-project-state';
import { authoringProjectSchema } from '../../shared/project-schema/authoring-project';
import { projectWorkspaceSaveUnitFileOwnership } from '../../shared/project-workspace/project-workspace-service';
import { getJsonAtPointer, hasJsonAtPointer, type JsonPointer } from './json-pointer';
import { applyJsonPatch, type JsonPatchOperation } from './json-patch';
import { cloneJsonValue, type JsonValue } from './json-value';

function mutationValue(document: JsonValue, path: JsonPointer): ProjectMutationPathValue {
  return hasJsonAtPointer(document, path)
    ? { exists: true, value: cloneJsonValue(getJsonAtPointer(document, path)) }
    : { exists: false };
}

function ownershipFor(document: JsonValue, scriptSourcePaths: Readonly<Record<string, string>>) {
  const parsed = authoringProjectSchema.safeParse(stripLocalEditorProjectState(document));
  return parsed.success
    ? projectWorkspaceSaveUnitFileOwnership(parsed.data, scriptSourcePaths)
    : {};
}

export function buildRecoveryFileOwnershipHints(input: {
  recovery: EditorRecoveryState;
  baselineDocument: JsonValue;
  candidateDocument: JsonValue;
  baselineScriptSourcePaths?: Readonly<Record<string, string>>;
  candidateScriptSourcePaths?: Readonly<Record<string, string>>;
}): Record<string, string[]> {
  const before = ownershipFor(input.baselineDocument, input.baselineScriptSourcePaths ?? {});
  const after = ownershipFor(
    input.candidateDocument,
    input.candidateScriptSourcePaths ?? input.baselineScriptSourcePaths ?? {},
  );
  return Object.fromEntries(
    Object.keys(input.recovery.saveUnitsById)
      .sort()
      .map((saveUnitId) => [
        saveUnitId,
        [
          ...new Set([...(before[saveUnitId]?.files ?? []), ...(after[saveUnitId]?.files ?? [])]),
        ].sort(),
      ]),
  );
}

export function buildProjectContentSaveRequest(input: {
  baselineDocument: JsonValue;
  candidateDocument: JsonValue;
  recovery: EditorRecoveryState;
  saveUnitIds: readonly string[];
  affectedPaths: readonly JsonPointer[];
  operationLabel: string;
  identityRemap?: ProjectContentSaveRequest['identityRemap'];
  structural?: boolean;
  assetTransition?: ProjectContentSaveRequest['assetTransition'];
  baselineScriptSourcePaths?: Readonly<Record<string, string>>;
  candidateScriptSourcePaths?: Readonly<Record<string, string>>;
}): ProjectContentSaveRequest {
  const baseline = stripLocalEditorProjectState(input.baselineDocument) as JsonValue;
  const candidate = stripLocalEditorProjectState(input.candidateDocument) as JsonValue;
  const affectedPaths = [...new Set(input.affectedPaths)].sort() as JsonPointer[];
  return {
    saveUnitIds: [...new Set(input.saveUnitIds)].sort(),
    affectedPaths,
    baseValueByPath: Object.fromEntries(
      affectedPaths.map((path) => [path, mutationValue(baseline, path)]),
    ),
    localValueByPath: Object.fromEntries(
      affectedPaths.map((path) => [path, mutationValue(candidate, path)]),
    ),
    operationLabel: input.operationLabel,
    recoveryFileOwnershipHints: buildRecoveryFileOwnershipHints({
      recovery: input.recovery,
      baselineDocument: input.baselineDocument,
      candidateDocument: input.candidateDocument,
      baselineScriptSourcePaths: input.baselineScriptSourcePaths,
      candidateScriptSourcePaths: input.candidateScriptSourcePaths,
    }),
    ...(input.identityRemap === undefined ? {} : { identityRemap: input.identityRemap }),
    ...(input.structural === undefined ? {} : { structural: input.structural }),
    ...(input.assetTransition === undefined ? {} : { assetTransition: input.assetTransition }),
  };
}

export function applyProjectMutationValues(
  document: JsonValue,
  values: Readonly<Record<string, ProjectMutationPathValue>>,
): JsonValue {
  const operations: JsonPatchOperation[] = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, value]) =>
      value.exists
        ? hasJsonAtPointer(document, path as JsonPointer)
          ? { op: 'replace' as const, path, value: cloneJsonValue(value.value as JsonValue) }
          : { op: 'add' as const, path, value: cloneJsonValue(value.value as JsonValue) }
        : { op: 'remove' as const, path },
    );
  return operations.length > 0
    ? applyJsonPatch(document, operations).document
    : cloneJsonValue(document);
}
