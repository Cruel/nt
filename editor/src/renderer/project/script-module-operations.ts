import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import {
  parseScriptModuleData,
  validateScriptModuleData,
} from '../../shared/project-schema/authoring-script-modules';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { JsonValue } from './json-value';

export function replaceScriptModuleDataPatches(
  document: JsonValue | unknown,
  payload: { scriptId: string; data: unknown },
) {
  const path = buildJsonPointer(['scripts', payload.scriptId, 'data']);
  if (!isAuthoringProject(document))
    return {
      patches: [],
      diagnostics: [
        { severity: 'error' as const, message: 'Current document is not a NovelTea project.' },
      ],
    };
  const record = document.scripts[payload.scriptId];
  const data = parseScriptModuleData(payload.data);
  if (!record)
    return {
      patches: [],
      diagnostics: [
        {
          severity: 'error' as const,
          message: 'Script Module record does not exist.',
          path: buildJsonPointer(['scripts', payload.scriptId]),
        },
      ],
    };
  if (!data)
    return {
      patches: [],
      diagnostics: [
        { severity: 'error' as const, message: 'Script Module data is invalid.', path },
      ],
    };
  const failure = validateScriptModuleData(document, payload.scriptId, { ...record, data }).find(
    (item) => item.severity === 'error',
  );
  if (failure)
    return {
      patches: [],
      diagnostics: [{ severity: 'error' as const, message: failure.message, path: failure.path }],
    };
  return {
    patches: [{ op: 'replace' as const, path, value: toJsonValue(data) }],
    affectedPaths: [path],
  };
}
