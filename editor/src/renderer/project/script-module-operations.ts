import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import { isAuthoringProjectView } from '../../shared/project-schema/authoring-project-view';
import { parseScriptModuleData } from '../../shared/project-schema/authoring-script-modules';

export function replaceScriptModuleDataPatches(
  document: unknown,
  payload: { scriptId: string; data: unknown },
) {
  const path = buildJsonPointer(['scripts', payload.scriptId, 'data']);
  if (!isAuthoringProjectView(document))
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
  return {
    patches: [{ op: 'replace' as const, path, value: toJsonValue(data) }],
    affectedPaths: [path],
  };
}
