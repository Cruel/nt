import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import { isAuthoringProjectView } from '../../shared/project-schema/authoring-project-view';
import { parseVerbData } from '../../shared/project-schema/authoring-verbs';

export function replaceVerbDataPatches(
  document: unknown,
  payload: { verbId: string; data: unknown },
) {
  const path = buildJsonPointer(['verbs', payload.verbId, 'data']);
  if (!isAuthoringProjectView(document))
    return {
      patches: [],
      diagnostics: [
        { severity: 'error' as const, message: 'Current document is not a NovelTea project.' },
      ],
    };
  const record = document.verbs[payload.verbId];
  const data = parseVerbData(payload.data);
  if (!record)
    return {
      patches: [],
      diagnostics: [
        {
          severity: 'error' as const,
          message: 'Verb record does not exist.',
          path: buildJsonPointer(['verbs', payload.verbId]),
        },
      ],
    };
  if (!data)
    return {
      patches: [],
      diagnostics: [{ severity: 'error' as const, message: 'Verb data is invalid.', path }],
    };
  return {
    patches: [{ op: 'replace' as const, path, value: toJsonValue(data) }],
    affectedPaths: [path],
  };
}
