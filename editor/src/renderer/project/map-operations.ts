import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import { parseMapData } from '../../shared/project-schema/authoring-maps';
import { isAuthoringProjectView } from '../../shared/project-schema/authoring-project-view';

export function replaceMapDataPatches(
  document: unknown,
  payload: { mapId: string; data: unknown },
) {
  const path = buildJsonPointer(['maps', payload.mapId, 'data']);
  if (!isAuthoringProjectView(document))
    return {
      patches: [],
      diagnostics: [
        { severity: 'error' as const, message: 'Current document is not a NovelTea project.' },
      ],
    };
  const record = document.maps[payload.mapId];
  const data = parseMapData(payload.data);
  if (!record)
    return {
      patches: [],
      diagnostics: [
        {
          severity: 'error' as const,
          message: 'Map record does not exist.',
          path: buildJsonPointer(['maps', payload.mapId]),
        },
      ],
    };
  if (!data)
    return {
      patches: [],
      diagnostics: [{ severity: 'error' as const, message: 'Map data is invalid.', path }],
    };
  return {
    patches: [{ op: 'replace' as const, path, value: toJsonValue(data) }],
    affectedPaths: [path],
  };
}
