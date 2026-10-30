import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import { isAuthoringProjectView } from '../../shared/project-schema/authoring-project-view';
import { parseTestData } from '../../shared/project-schema/authoring-tests';
import type { EntityOperationDiagnostic, EntityOperationResult } from './entity-operations';
import type { JsonPatchOperation } from './json-patch';

export interface ReplaceTestDataPayload {
  testId: string;
  data: unknown;
}

function error(message: string, path?: string): EntityOperationDiagnostic {
  return { severity: 'error', message, path };
}

function pathForTest(testId: string) {
  return buildJsonPointer(['tests', testId]);
}

function pathForTestData(testId: string) {
  return buildJsonPointer(['tests', testId, 'data']);
}

export function replaceTestDataPatches(
  document: unknown,
  payload: ReplaceTestDataPayload,
): EntityOperationResult {
  if (!isAuthoringProjectView(document))
    return { patches: [], diagnostics: [error('Current document is not a NovelTea project.')] };
  const record = document.tests[payload.testId];
  if (!record)
    return {
      patches: [],
      diagnostics: [error('Test record does not exist.', pathForTest(payload.testId))],
    };
  const data = parseTestData(payload.data);
  if (!data)
    return {
      patches: [],
      diagnostics: [error('Test data is invalid.', pathForTestData(payload.testId))],
    };
  const patch: JsonPatchOperation = {
    op: 'replace',
    path: pathForTestData(payload.testId),
    value: toJsonValue(data),
  };
  return { patches: [patch], affectedPaths: [patch.path] };
}
