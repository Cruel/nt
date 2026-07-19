import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue, type JsonValue } from '@/project/json-value';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  parseTestData,
  validateTestData,
  type TestData,
} from '../../shared/project-schema/authoring-tests';
import type { JsonPatchOperation } from './json-patch';
import type { EntityOperationDiagnostic, EntityOperationResult } from './entity-operations';

export interface ReplaceTestDataPayload {
  testId: string;
  data: TestData | unknown;
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
  document: JsonValue | unknown,
  payload: ReplaceTestDataPayload,
): EntityOperationResult {
  if (!isAuthoringProject(document))
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
  const diagnostics = validateTestData(document, payload.testId, { ...record, data });
  const failure = diagnostics.find((item) => item.severity === 'error');
  if (failure) return { patches: [], diagnostics: [error(failure.message, failure.path)] };
  const patch: JsonPatchOperation = {
    op: 'replace',
    path: pathForTestData(payload.testId),
    value: toJsonValue(data),
  };
  return { patches: [patch], affectedPaths: [patch.path] };
}
