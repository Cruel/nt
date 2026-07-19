import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import { parseVerbData } from '../../shared/project-schema/authoring-verbs';
import { validateInteractionProgram } from '../../shared/project-schema/authoring-interactions';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { JsonValue } from './json-value';

export function replaceVerbDataPatches(
  document: JsonValue | unknown,
  payload: { verbId: string; data: unknown },
) {
  const path = buildJsonPointer(['verbs', payload.verbId, 'data']);
  if (!isAuthoringProject(document))
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
  const failure = validateInteractionProgram(
    document,
    data.defaultProgram,
    `${path}/defaultProgram`,
  ).find((item) => item.severity === 'error');
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
