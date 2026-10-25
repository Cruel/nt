import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import { parseInteractionData } from '../../shared/project-schema/authoring-interactions';
import { isAuthoringProjectView } from '../../shared/project-schema/authoring-project-view';

export function replaceInteractionDataPatches(
  document: unknown,
  payload: { interactionId: string; data: unknown },
) {
  const path = buildJsonPointer(['interactions', payload.interactionId, 'data']);
  if (!isAuthoringProjectView(document))
    return {
      patches: [],
      diagnostics: [
        { severity: 'error' as const, message: 'Current document is not a NovelTea project.' },
      ],
    };
  const record = document.interactions[payload.interactionId];
  const data = parseInteractionData(payload.data);
  if (!record)
    return {
      patches: [],
      diagnostics: [
        {
          severity: 'error' as const,
          message: 'Interaction record does not exist.',
          path: buildJsonPointer(['interactions', payload.interactionId]),
        },
      ],
    };
  if (!data)
    return {
      patches: [],
      diagnostics: [{ severity: 'error' as const, message: 'Interaction data is invalid.', path }],
    };
  return {
    patches: [{ op: 'replace' as const, path, value: toJsonValue(data) }],
    affectedPaths: [path],
  };
}
