import { buildJsonPointer } from '@/project/json-pointer';
import { toJsonValue } from '@/project/json-value';
import { structuredMessages } from '../../shared/authoring-structured-messages';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import type { JsonPatchOperation } from './json-patch';

export interface StructuredMessageOwnerMove {
  fromPrefix: string;
  toPrefix: string;
}

export interface StructuredMessageOwnerMoveResult {
  patches: JsonPatchOperation[];
  affectedPaths: string[];
  conflict: { path: string; message: string } | null;
}

export function preserveStructuredMessageIdentityPatches(
  project: AuthoringProject,
  moves: readonly StructuredMessageOwnerMove[],
): StructuredMessageOwnerMoveResult {
  const patches: JsonPatchOperation[] = [];
  const affectedPaths: string[] = [];
  const plannedTargets = new Map<string, string>();

  for (const move of moves) {
    for (const message of structuredMessages(project)) {
      if (message.path !== move.fromPrefix && !message.path.startsWith(`${move.fromPrefix}/`))
        continue;
      const toPath = `${move.toPrefix}${message.path.slice(move.fromPrefix.length)}`;
      const existing = project.localization.structuredMessageIds[toPath];
      const planned = plannedTargets.get(toPath);
      if (
        (existing !== undefined && existing !== message.id) ||
        (planned && planned !== message.id)
      )
        return {
          patches: [],
          affectedPaths: [],
          conflict: {
            path: buildJsonPointer(['localization', 'structuredMessageIds', toPath]),
            message: `Cannot preserve localization identity: target structured Message ownership already maps to '${existing ?? planned}'.`,
          },
        };
      plannedTargets.set(toPath, message.id);

      const fromIdentityPath = buildJsonPointer([
        'localization',
        'structuredMessageIds',
        message.path,
      ]);
      const toIdentityPath = buildJsonPointer(['localization', 'structuredMessageIds', toPath]);
      if (Object.hasOwn(project.localization.structuredMessageIds, message.path)) {
        patches.push({ op: 'remove', path: fromIdentityPath });
        affectedPaths.push(fromIdentityPath);
      }
      patches.push({
        op: existing !== undefined ? 'replace' : 'add',
        path: toIdentityPath,
        value: toJsonValue(message.id),
      });
      affectedPaths.push(toIdentityPath);
    }
  }

  return { patches, affectedPaths, conflict: null };
}
