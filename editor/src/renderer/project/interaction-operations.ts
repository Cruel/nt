import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import {
  parseInteractionData,
  validateInteractionData,
} from '../../shared/project-schema/authoring-interactions';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { JsonValue } from './json-value';

export function replaceInteractionDataPatches(
  document: JsonValue | unknown,
  payload: { interactionId: string; data: unknown },
) {
  const path = buildJsonPointer(['interactions', payload.interactionId, 'data']);
  if (!isAuthoringProject(document))
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
  const failure = validateInteractionData(document, payload.interactionId, {
    ...record,
    data,
  }).find((item) => item.severity === 'error');
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
