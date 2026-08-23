import { z } from 'zod';
import {
  assignAssetAliasPatches,
  importAssetRecordsPatches,
  reimportAssetPatches,
  removeAssetAliasPatches,
  renameAssetAliasPatches,
} from '@/project/asset-operations';
import {
  buildJsonPointer,
  getJsonAtPointer,
  hasJsonAtPointer,
  parseJsonPointer,
} from '@/project/json-pointer';
import { isJsonArray, isJsonObject, toJsonValue, type JsonValue } from '@/project/json-value';
import { applyJsonPatch, type JsonPatchOperation } from '@/project/json-patch';
import { exactSourceRewritePatches as buildExactSourceRewritePatches } from '../../shared/authoring-source-rewrite';
import {
  createEntityRecordPatches,
  duplicateEntityRecordPatches,
  renameEntityIdPatches,
  updateEntityMetadataPatches,
} from '@/project/entity-operations';
import {
  applyShaderCompiledOutputsPatches,
  replaceMaterialDataPatches,
  replaceShaderDataPatches,
  setMaterialBasePatches,
} from '@/project/shader-material-operations';
import {
  replaceVariableDataPatches,
  setVariableDefaultValuePatches,
  setVariableTypePatches,
} from '@/project/variable-operations';
import {
  clearGameplayInstanceArchetypeOverridesPatches,
  replaceArchetypeConfigurationPatches,
  setArchetypeBasePatches,
  setArchetypeKindPatches,
  setGameplayInstanceArchetypePatches,
} from '@/project/archetype-operations';
import { replaceCharacterDataPatches } from '@/project/character-operations';
import { replaceInteractableDataPatches } from '@/project/interactable-operations';
import { replaceDialogueDataPatches } from '@/project/dialogue-operations';
import { replaceRoomDataPatches } from '@/project/room-operations';
import {
  detachInteractablePlacementPatches,
  moveInteractableToPlacementPatches,
  placeInteractablePatches,
  setRoomPlacementBoundsPatches,
} from '@/project/room-placement-operations';
import {
  deleteInteractableHotspot,
  deleteRoomHotspot,
  renameHotspot,
  setInteractableHotspotMode,
  updateInteractableHotspots,
  updateRoomHotspots,
  validBounds,
} from '@/project/hotspot-operations';
import { generateAuthoringRepairPlan, recordTarget } from '@/project/authoring-repair';
import { replaceSceneDataPatches } from '@/project/scene-operations';
import {
  preflightGraphCommand,
  preflightRoomPlacementDeletion,
} from '@/project/authoring-graph-consumers';
import { replaceInteractionDataPatches } from '@/project/interaction-operations';
import { replaceMapDataPatches } from '@/project/map-operations';
import { replaceScriptModuleDataPatches } from '@/project/script-module-operations';
import { replaceVerbDataPatches } from '@/project/verb-operations';
import { replaceTestDataPatches } from '@/project/test-operations';
import { replaceLayoutDataPatches } from '@/project/layout-operations';
import {
  setProjectAccessibilityScalePatches,
  setProjectDefaultFontPatches,
  setProjectDisplayPatches,
  setProjectEntrypointPatches,
  setProjectAppPatches,
  setProjectIconPatches,
  setProjectReferenceResolutionPatches,
  setProjectRoomNavigationTransitionPatches,
  setProjectBootstrapModulePatches,
  setProjectSystemLayoutPatches,
  setProjectTagColorPatches,
  setProjectTitleScreenPatches,
  setProjectUndefinedInteractionProgramPatches,
  updateProjectMetadataPatches,
} from '@/project/project-settings-operations';
import { systemLayoutRoleValues } from '../../shared/project-schema/authoring-layouts';
import { MAX_REFERENCE_RESOLUTION_DIMENSION } from '../../shared/project-schema/project-display-contract';
import {
  assignChaptersPatches,
  createChapterPatches,
  deleteChapterPatches,
  renameChapterPatches,
  setChapterColorPatches,
  setExplorerOptionsPatches,
  setHiddenCollectionsPatches,
} from '@/project/project-chapters-operations';
import type { CommandDiagnostic, CommandHandler, CommandHandlerResult } from './command-types';
import { authoringProjectSchema } from '../../shared/project-schema/authoring-project';
import { gameplayInstanceKindValues } from '../../shared/project-schema/authoring-archetypes';
import { imageAssetMetadataSchema } from '../../shared/project-schema/authoring-assets';
import { roomHotspotDataSchema } from '../../shared/project-schema/authoring-rooms';
import { roomNormalizedRectSchema } from '../../shared/project-schema/authoring-rooms';
import { interactionProgramSchema } from '../../shared/project-schema/authoring-interaction-programs';
import {
  interactableHotspotBehaviorSchema,
  interactableHotspotsSchema,
} from '../../shared/project-schema/authoring-interactables';
import {
  buildReferenceIndexFromGraph,
  type ReferenceIndex,
} from '../../shared/project-schema/authoring-references';
import {
  authoringCollectionKeys,
  type AuthoringCollectionKey,
} from '../../shared/project-schema/authoring-collections';

const jsonPointerSchema = z.string().refine((value) => value === '' || value.startsWith('/'), {
  message: 'Expected a JSON pointer path.',
});

const patchOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), path: jsonPointerSchema, value: z.unknown() }),
  z.object({ op: z.literal('replace'), path: jsonPointerSchema, value: z.unknown() }),
  z.object({ op: z.literal('remove'), path: jsonPointerSchema }),
]);

const pathValueSchema = z.object({
  path: jsonPointerSchema,
  value: z.unknown(),
});

const pathOnlySchema = z.object({ path: jsonPointerSchema });

const recordSchema = z.object({
  collection: z.string().min(1),
  entityId: z.string().min(1),
  record: z.unknown(),
});

const deleteRecordSchema = z.object({
  collection: z.string().min(1),
  entityId: z.string().min(1),
});

function error(message: string, path?: string): CommandDiagnostic {
  return { severity: 'error', message, path };
}

const EMPTY_REFERENCE_INDEX: ReferenceIndex = {
  usages: [],
  byTarget: new Map(),
};

function commandReferenceIndex(
  document: JsonValue,
  graphSnapshot: Parameters<typeof preflightGraphCommand>[0]['snapshot'],
): ReferenceIndex {
  if (!graphSnapshot) return EMPTY_REFERENCE_INDEX;
  const project = authoringProjectSchema.safeParse(document);
  return project.success
    ? buildReferenceIndexFromGraph(project.data, graphSnapshot.graph)
    : EMPTY_REFERENCE_INDEX;
}

function parsePayload<T>(
  schema: z.ZodType<T>,
  payload: unknown,
): { ok: true; value: T } | { ok: false; diagnostics: CommandDiagnostic[] } {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    diagnostics: parsed.error.issues.map((issue) =>
      error(issue.message, issue.path.length ? `/${issue.path.join('/')}` : undefined),
    ),
  };
}

interface StructuralPatchPreflightContext {
  document: JsonValue;
  graphSnapshot: Parameters<typeof preflightGraphCommand>[0]['snapshot'];
  projectInstanceId: string | null | undefined;
  projectRevision: number | null | undefined;
}

function structuralPatchMayDelete(patch: JsonPatchOperation): boolean {
  const segments = parseJsonPointer(patch.path);
  if (segments.length === 0) return true;
  const root = segments[0];
  if (root === 'properties') return patch.op === 'remove' || segments.length <= 2;
  if (!authoringCollectionKeys.includes(root as AuthoringCollectionKey)) return false;
  if (patch.op === 'remove') return true;
  if (segments.length <= 2 || segments[2] === 'id') return true;
  return root === 'rooms' && segments[2] === 'data' && segments[3] === 'placements';
}

function recordMap(
  document: JsonValue,
  collection: AuthoringCollectionKey,
): Record<string, JsonValue> {
  const path = buildJsonPointer([collection]);
  if (!hasJsonAtPointer(document, path)) return {};
  const value = getJsonAtPointer(document, path);
  return isJsonObject(value) ? value : {};
}

function propertyMap(document: JsonValue): Record<string, JsonValue> {
  const path = buildJsonPointer(['properties']);
  if (!hasJsonAtPointer(document, path)) return {};
  const value = getJsonAtPointer(document, path);
  return isJsonObject(value) ? value : {};
}

function placementIds(document: JsonValue, roomId: string): Set<string> {
  const path = buildJsonPointer(['rooms', roomId, 'data', 'placements']);
  if (!hasJsonAtPointer(document, path)) return new Set();
  const placements = getJsonAtPointer(document, path);
  if (!isJsonArray(placements)) return new Set();
  return new Set(
    placements.flatMap((placement) =>
      isJsonObject(placement) && typeof placement.id === 'string' ? [placement.id] : [],
    ),
  );
}

function preflightStructuralPatches(
  context: StructuralPatchPreflightContext,
  patches: readonly JsonPatchOperation[],
): CommandDiagnostic[] {
  if (!context.projectInstanceId || !patches.some(structuralPatchMayDelete)) return [];
  for (const patch of patches) {
    const segments = parseJsonPointer(patch.path);
    if (
      patch.op !== 'remove' &&
      segments.length === 3 &&
      authoringCollectionKeys.includes(segments[0] as AuthoringCollectionKey) &&
      segments[2] === 'id'
    ) {
      return [
        error('Use the graph-aware entity rename command to change a record ID.', patch.path),
      ];
    }
  }

  let candidate: JsonValue;
  try {
    candidate = applyJsonPatch(context.document, [...patches]).document;
  } catch {
    return [];
  }
  const diagnostics: CommandDiagnostic[] = [];
  const beforeProperties = propertyMap(context.document);
  const afterProperties = propertyMap(candidate);
  for (const id of Object.keys(beforeProperties)) {
    if (Object.prototype.hasOwnProperty.call(afterProperties, id)) continue;
    return [
      error(
        'Property-definition deletion is not supported by the current graph-aware structural command path.',
        buildJsonPointer(['properties', id]),
      ),
    ];
  }
  for (const collection of authoringCollectionKeys) {
    const before = recordMap(context.document, collection);
    const after = recordMap(candidate, collection);
    for (const id of Object.keys(before)) {
      if (Object.prototype.hasOwnProperty.call(after, id)) continue;
      const preflight = preflightGraphCommand({
        snapshot: context.graphSnapshot,
        projectInstanceId: context.projectInstanceId,
        projectRevision: context.projectRevision ?? 0,
        target: { collection, id },
        operation: 'delete',
      });
      if (preflight.kind === 'blocked')
        return [error(preflight.reason, buildJsonPointer([collection, id]))];
      const confirmed = preflight.usages.filter((usage) =>
        usage.edge.facets.includes('reference-integrity'),
      );
      if (confirmed.length > 0) {
        return [
          error(
            `Deletion is blocked by ${confirmed.length} confirmed reference${confirmed.length === 1 ? '' : 's'}. Use the graph-aware delete command to review or Force Delete.`,
            buildJsonPointer([collection, id]),
          ),
        ];
      }
      if (preflight.kind === 'ready' && preflight.warnings.length > 0) {
        diagnostics.push({
          severity: 'warning',
          path: buildJsonPointer([collection, id]),
          message: `${preflight.warnings.length} possible Lua reference${preflight.warnings.length === 1 ? '' : 's'} may require manual review.`,
        });
      }
    }
  }

  const beforeRooms = recordMap(context.document, 'rooms');
  const afterRooms = recordMap(candidate, 'rooms');
  for (const roomId of Object.keys(beforeRooms)) {
    if (!Object.prototype.hasOwnProperty.call(afterRooms, roomId)) continue;
    const afterPlacements = placementIds(candidate, roomId);
    for (const placementId of placementIds(context.document, roomId)) {
      if (afterPlacements.has(placementId)) continue;
      const preflight = preflightRoomPlacementDeletion({
        snapshot: context.graphSnapshot,
        projectInstanceId: context.projectInstanceId,
        projectRevision: context.projectRevision ?? 0,
        roomId,
        placementId,
      });
      if (preflight.kind === 'blocked')
        return [error(preflight.reason, buildJsonPointer(['rooms', roomId, 'data', 'placements']))];
      if (preflight.kind === 'ready' && preflight.warnings.length > 0) {
        diagnostics.push({
          severity: 'warning',
          path: buildJsonPointer(['rooms', roomId, 'data', 'placements']),
          message: `${preflight.warnings.length} possible Lua reference${preflight.warnings.length === 1 ? '' : 's'} may require manual review.`,
        });
      }
    }
  }
  return diagnostics;
}

function withStructuralPatchPreflight(
  context: StructuralPatchPreflightContext,
  result: CommandHandlerResult,
): CommandHandlerResult {
  const diagnostics = preflightStructuralPatches(context, result.patches);
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return { patches: [], diagnostics };
  }
  return diagnostics.length === 0
    ? result
    : {
        ...result,
        diagnostics: [...(result.diagnostics ?? []), ...diagnostics],
      };
}

export const projectApplyPatchCommand: CommandHandler = ({
  document,
  payload,
  graphSnapshot,
  projectInstanceId,
  projectRevision,
}) => {
  const parsed = parsePayload(z.array(patchOperationSchema), payload);
  if (!parsed.ok) return { patches: [], diagnostics: parsed.diagnostics };
  const result: CommandHandlerResult = {
    patches: parsed.value.map((operation) =>
      operation.op === 'remove'
        ? { op: operation.op, path: operation.path }
        : { op: operation.op, path: operation.path, value: toJsonValue(operation.value) },
    ),
    affectedPaths: parsed.value.map((operation) => operation.path),
  };
  return withStructuralPatchPreflight(
    { document, graphSnapshot: graphSnapshot ?? null, projectInstanceId, projectRevision },
    result,
  );
};

export const projectReplaceAtPathCommand: CommandHandler = ({
  document,
  payload,
  graphSnapshot,
  projectInstanceId,
  projectRevision,
}) => {
  const parsed = parsePayload(pathValueSchema, payload);
  if (!parsed.ok) return { patches: [], diagnostics: parsed.diagnostics };
  if (!hasJsonAtPointer(document, parsed.value.path)) {
    return {
      patches: [],
      diagnostics: [error('Replace target does not exist.', parsed.value.path)],
    };
  }
  return withStructuralPatchPreflight(
    { document, graphSnapshot: graphSnapshot ?? null, projectInstanceId, projectRevision },
    {
      patches: [{ op: 'replace', path: parsed.value.path, value: toJsonValue(parsed.value.value) }],
      affectedPaths: [parsed.value.path],
    },
  );
};

export const projectAddAtPathCommand: CommandHandler = ({
  document,
  payload,
  graphSnapshot,
  projectInstanceId,
  projectRevision,
}) => {
  const parsed = parsePayload(pathValueSchema, payload);
  if (!parsed.ok) return { patches: [], diagnostics: parsed.diagnostics };
  if (parsed.value.path !== '') {
    const parent = parsed.value.path.slice(0, parsed.value.path.lastIndexOf('/')) || '';
    if (!hasJsonAtPointer(document, parent)) {
      return { patches: [], diagnostics: [error('Add parent path does not exist.', parent)] };
    }
  }
  return withStructuralPatchPreflight(
    { document, graphSnapshot: graphSnapshot ?? null, projectInstanceId, projectRevision },
    {
      patches: [{ op: 'add', path: parsed.value.path, value: toJsonValue(parsed.value.value) }],
      affectedPaths: [parsed.value.path],
    },
  );
};

export const projectRemoveAtPathCommand: CommandHandler = ({
  document,
  payload,
  graphSnapshot,
  projectInstanceId,
  projectRevision,
}) => {
  const parsed = parsePayload(pathOnlySchema, payload);
  if (!parsed.ok) return { patches: [], diagnostics: parsed.diagnostics };
  if (parsed.value.path === '') {
    return {
      patches: [],
      diagnostics: [error('Cannot remove the project document root.', parsed.value.path)],
    };
  }
  if (!hasJsonAtPointer(document, parsed.value.path)) {
    return {
      patches: [],
      diagnostics: [error('Remove target does not exist.', parsed.value.path)],
    };
  }
  return withStructuralPatchPreflight(
    { document, graphSnapshot: graphSnapshot ?? null, projectInstanceId, projectRevision },
    {
      patches: [{ op: 'remove', path: parsed.value.path }],
      affectedPaths: [parsed.value.path],
    },
  );
};

export const entityReplaceRecordCommand: CommandHandler = ({
  document,
  payload,
  graphSnapshot,
  projectInstanceId,
  projectRevision,
}) => {
  const parsed = parsePayload(recordSchema, payload);
  if (!parsed.ok) return { patches: [], diagnostics: parsed.diagnostics };
  const { collection, entityId } = parsed.value;
  const collectionPath = buildJsonPointer([collection]);
  if (!hasJsonAtPointer(document, collectionPath)) {
    return {
      patches: [],
      diagnostics: [error('Entity collection does not exist.', collectionPath)],
    };
  }
  const collectionValue = getJsonAtPointer(document, collectionPath);
  if (!isJsonObject(collectionValue)) {
    return {
      patches: [],
      diagnostics: [error('Entity collection is not an object.', collectionPath)],
    };
  }
  const record = toJsonValue(parsed.value.record);
  if (!isJsonObject(record)) {
    return {
      patches: [],
      diagnostics: [error('Entity record must use the current object shape.', collectionPath)],
    };
  }
  if (record.id !== entityId) {
    return {
      patches: [],
      diagnostics: [
        error(
          'Entity record id must match the map key.',
          buildJsonPointer([collection, entityId, 'id']),
        ),
      ],
    };
  }
  const path = buildJsonPointer([collection, entityId]);
  return withStructuralPatchPreflight(
    { document, graphSnapshot: graphSnapshot ?? null, projectInstanceId, projectRevision },
    {
      patches: [
        Object.prototype.hasOwnProperty.call(collectionValue, entityId)
          ? { op: 'replace', path, value: record }
          : { op: 'add', path, value: record },
      ],
      diagnostics: [],
      affectedPaths: [path],
    },
  );
};

export const entityDeleteRecordCommand: CommandHandler = ({
  document,
  payload,
  graphSnapshot,
  projectInstanceId,
  projectRevision,
}) => {
  const parsed = parsePayload(
    deleteRecordSchema.extend({
      force: z.boolean().optional(),
      replacements: z.record(z.string(), z.string().min(1)).optional(),
    }),
    payload,
  );
  if (!parsed.ok) return { patches: [], diagnostics: parsed.diagnostics };
  if (!projectInstanceId) {
    return {
      patches: [],
      diagnostics: [error('The dependency graph is not ready for the current project revision.')],
    };
  }
  const collection = parsed.value.collection as AuthoringCollectionKey;
  const deletePath = buildJsonPointer([collection, parsed.value.entityId]);
  const metadataPath = buildJsonPointer([
    'editor',
    'recordMetadata',
    collection,
    parsed.value.entityId,
  ]);
  const plan = generateAuthoringRepairPlan({
    snapshot: graphSnapshot ?? null,
    projectInstanceId,
    projectRevision: projectRevision ?? 0,
    target: recordTarget(collection, parsed.value.entityId),
    deletePath,
    ...(hasJsonAtPointer(document, metadataPath) ? { metadataPath } : {}),
    force: parsed.value.force,
    replacements: parsed.value.replacements,
  });
  if (plan.status !== 'ready') {
    return { patches: [], diagnostics: [{ severity: 'error', message: plan.reason }] };
  }
  return {
    patches: [...plan.plan.patches],
    affectedPaths: plan.plan.patches.map((patch) => patch.path),
    diagnostics: plan.plan.warnings.map((message) => ({ severity: 'warning' as const, message })),
  };
};

function preflightWarningsResult(
  result: CommandHandlerResult,
  preflight: ReturnType<typeof preflightGraphCommand> | null,
): CommandHandlerResult {
  if (!preflight || preflight.kind === 'blocked' || preflight.warnings.length === 0) return result;
  return {
    ...result,
    diagnostics: [
      ...(result.diagnostics ?? []),
      {
        severity: 'warning',
        message: `${preflight.warnings.length} possible Lua reference${preflight.warnings.length === 1 ? '' : 's'} may require manual review.`,
      },
    ],
  };
}

function exactSourceRewritePatches(
  document: unknown,
  preflight: Extract<ReturnType<typeof preflightGraphCommand>, { kind: 'ready' }>,
  replacementId: string,
): CommandHandlerResult {
  const rewritten = buildExactSourceRewritePatches(
    toJsonValue(document),
    preflight.usages,
    replacementId,
  );
  if (!rewritten.ok)
    return { patches: [], diagnostics: [error(rewritten.message, rewritten.path)] };
  const patches = rewritten.patches as JsonPatchOperation[];
  return { patches, affectedPaths: patches.map((patch) => patch.path) };
}

function parseEntityCommand<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  createResult: (payload: T) => CommandHandlerResult,
): CommandHandlerResult {
  const parsed = parsePayload(schema, payload);
  if (!parsed.ok) return { patches: [], diagnostics: parsed.diagnostics };
  return createResult(parsed.value);
}

const authoringCollectionSchema = z.string().min(1);
const entityIdSchema = z.string().min(1);

const createEntityRecordSchema = z.object({
  collection: authoringCollectionSchema,
  entityId: entityIdSchema,
  label: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  color: z.string().nullable().optional(),
  data: z.unknown().optional(),
});

const renameEntityIdSchema = z.object({
  collection: authoringCollectionSchema,
  fromId: entityIdSchema,
  toId: entityIdSchema,
  label: z.string().optional(),
  confirmRenameWithoutLuaRewrite: z.boolean().optional(),
});

const duplicateEntityRecordSchema = z.object({
  collection: authoringCollectionSchema,
  sourceId: entityIdSchema,
  targetId: entityIdSchema,
  label: z.string().optional(),
});

const updateEntityMetadataSchema = z.object({
  collection: authoringCollectionSchema,
  entityId: entityIdSchema,
  label: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  color: z.string().nullable().optional(),
  sortKey: z.string().nullable().optional(),
});

const importedAssetMetadataBaseSchema = z.object({
  originalPath: z.string(),
  originalName: z.string(),
  projectRelativePath: z.string(),
  extension: z.string(),
  mimeType: z.string().optional(),
  byteSize: z.number().nonnegative(),
  contentHash: z.string(),
  importedAt: z.string(),
});
const importedAssetMetadataSchema = z.discriminatedUnion('kind', [
  importedAssetMetadataBaseSchema.extend({
    kind: z.literal('image'),
    imageMetadata: imageAssetMetadataSchema,
  }),
  importedAssetMetadataBaseSchema.extend({
    kind: z.enum(['font', 'audio', 'script', 'shader-source', 'text', 'data', 'binary']),
    imageMetadata: z.null(),
  }),
]);

const assetImportSchema = z.object({
  assets: z.array(importedAssetMetadataSchema),
  fileOrigin: z
    .enum(['copied-by-import', 'existing-project-file', 'generated-project-file'])
    .optional(),
});
const assetAliasSchema = z.object({ assetId: entityIdSchema, alias: z.string().min(1) });
const assetRenameAliasSchema = z.object({
  fromAlias: z.string().min(1),
  toAlias: z.string().min(1),
});
const assetReimportSchema = z.object({
  assetId: entityIdSchema,
  asset: importedAssetMetadataSchema,
});
const assetDeleteSchema = z.object({ assetId: entityIdSchema, force: z.boolean().optional() });
const shaderReplaceDataSchema = z.object({ shaderId: entityIdSchema, data: z.unknown() });
const materialReplaceDataSchema = z.object({ materialId: entityIdSchema, data: z.unknown() });
const materialSetBaseSchema = z.object({
  materialId: entityIdSchema,
  baseMaterialId: entityIdSchema.nullable(),
});
const variableReplaceDataSchema = z.object({ variableId: entityIdSchema, data: z.unknown() });
const gameplayInstanceCollectionSchema = z.enum(['rooms', 'characters', 'interactables']);
const gameplayInstanceArchetypeSchema = z.object({
  collection: gameplayInstanceCollectionSchema,
  entityId: entityIdSchema,
  archetypeId: entityIdSchema.nullable(),
});
const gameplayInstanceArchetypeOverridesSchema = z.object({
  collection: gameplayInstanceCollectionSchema,
  entityId: entityIdSchema,
});
const archetypeConfigurationSchema = z.object({
  archetypeId: entityIdSchema,
  configuration: z.unknown(),
});
const archetypeBaseSchema = z.object({
  archetypeId: entityIdSchema,
  baseArchetypeId: entityIdSchema.nullable(),
});
const archetypeKindSchema = z.object({
  archetypeId: entityIdSchema,
  instanceKind: z.enum(gameplayInstanceKindValues),
});
const characterReplaceDataSchema = z.object({ characterId: entityIdSchema, data: z.unknown() });
const interactableReplaceDataSchema = z.object({
  interactableId: entityIdSchema,
  data: z.unknown(),
});
const dialogueReplaceDataSchema = z.object({ dialogueId: entityIdSchema, data: z.unknown() });
const roomReplaceDataSchema = z.object({ roomId: entityIdSchema, data: z.unknown() });
const roomHotspotSchema = z.object({ roomId: entityIdSchema, hotspotId: entityIdSchema });
const roomAddHotspotSchema = z.object({ roomId: entityIdSchema, hotspot: roomHotspotDataSchema });
const roomRenameHotspotSchema = roomHotspotSchema.extend({ nextId: entityIdSchema });
const roomUpdateHotspotSchema = roomHotspotSchema.extend({
  hotspot: roomHotspotDataSchema.omit({ id: true, shape: true }),
});
const roomSetHotspotBoundsSchema = roomHotspotSchema.extend({ bounds: z.unknown() });
const roomReorderHotspotsSchema = z.object({
  roomId: entityIdSchema,
  hotspotIds: z.array(entityIdSchema),
});
const roomSetPlacementBoundsSchema = z.object({
  roomId: entityIdSchema,
  placementId: entityIdSchema,
  bounds: roomNormalizedRectSchema,
});
const roomPlaceInteractableSchema = z.object({
  roomId: entityIdSchema,
  interactableId: entityIdSchema,
  instanceId: entityIdSchema,
  placementId: entityIdSchema,
  bounds: roomNormalizedRectSchema,
});
const roomMoveInteractableToPlacementSchema = z.object({
  roomId: entityIdSchema,
  interactableId: entityIdSchema,
  placementId: entityIdSchema,
});
const roomDetachInteractablePlacementSchema = z.object({
  roomId: entityIdSchema,
  interactableId: entityIdSchema,
  sourcePlacementId: entityIdSchema,
  placementId: entityIdSchema,
});
const interactableHotspotSchema = z.object({
  interactableId: entityIdSchema,
  hotspotId: entityIdSchema,
});
const interactableAddHotspotSchema = z.object({
  interactableId: entityIdSchema,
  hotspot: interactableHotspotsSchema.options[1].shape.hotspots.element,
});
const interactableRenameHotspotSchema = interactableHotspotSchema.extend({
  nextId: entityIdSchema,
});
const interactableUpdateHotspotSchema = interactableHotspotSchema.extend({
  hotspot: interactableHotspotBehaviorSchema.omit({ id: true }),
});
const interactableSetHotspotBoundsSchema = interactableHotspotSchema.extend({
  bounds: z.unknown(),
});
const interactableReorderHotspotsSchema = z.object({
  interactableId: entityIdSchema,
  hotspotIds: z.array(entityIdSchema),
});
const interactableSetHotspotModeSchema = z.object({
  interactableId: entityIdSchema,
  kind: z.enum(['sprite-alpha', 'custom']),
});
const sceneReplaceDataSchema = z.object({ sceneId: entityIdSchema, data: z.unknown() });
const testReplaceDataSchema = z.object({ testId: entityIdSchema, data: z.unknown() });
const layoutReplaceDataSchema = z.object({ layoutId: entityIdSchema, data: z.unknown() });
const verbReplaceDataSchema = z.object({ verbId: entityIdSchema, data: z.unknown() });
const interactionReplaceDataSchema = z.object({ interactionId: entityIdSchema, data: z.unknown() });
const mapReplaceDataSchema = z.object({ mapId: entityIdSchema, data: z.unknown() });
const scriptModuleReplaceDataSchema = z.object({ scriptId: entityIdSchema, data: z.unknown() });
const setSystemLayoutSchema = z.object({
  role: z.enum(systemLayoutRoleValues),
  layoutId: entityIdSchema.nullable(),
});
const projectMetadataSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  author: z.string().optional(),
  description: z.string().optional(),
});
const projectEntrypointSchema = z.object({
  target: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('room'), id: entityIdSchema }),
      z.object({ kind: z.literal('scene'), id: entityIdSchema }),
      z.object({ kind: z.literal('dialogue'), id: entityIdSchema }),
    ])
    .nullable(),
});
const projectBootstrapModuleSchema = z.object({ scriptId: z.string() });
const projectDisplaySchema = z.object({
  referenceResolution: z.object({
    width: z.number().finite(),
    height: z.number().finite(),
  }),
  worldRasterPolicy: z.string(),
  barColor: z.string(),
});
const projectReferenceResolutionSchema = z.object({
  width: z.number().int().positive().max(MAX_REFERENCE_RESOLUTION_DIMENSION),
  height: z.number().int().positive().max(MAX_REFERENCE_RESOLUTION_DIMENSION),
});
const projectAccessibilityScaleSchema = z.object({
  scale: z.enum(['uiScale', 'textScale']),
  policy: z.object({
    enabled: z.boolean(),
    minimum: z.number().finite(),
    maximum: z.number().finite(),
  }),
});
const projectDefaultFontSchema = z.object({ assetId: entityIdSchema.nullable() });
const projectTitleScreenSchema = z.object({
  titleImageId: entityIdSchema.nullable().optional(),
  showProjectTitle: z.boolean().optional(),
  showAuthor: z.boolean().optional(),
  subtitle: z.string().optional(),
  startLabel: z.string().optional(),
});
const projectUndefinedInteractionProgramSchema = z.object({
  program: interactionProgramSchema.nullable(),
});
const projectIconSchema = z.object({ assetId: entityIdSchema.nullable() });
const projectAssetRefSchema = z
  .object({
    $ref: z.object({ collection: z.literal('assets'), id: z.string() }).strict(),
  })
  .strict();
const projectLocalizedAppIdentitySchema = z
  .object({
    displayName: z.string().optional(),
    shortName: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();
const projectAppSchema = z
  .object({
    displayName: z.string(),
    shortName: z.string().optional(),
    publisher: z.string().optional(),
    copyright: z.string().optional(),
    description: z.string().optional(),
    defaultLocale: z.string().optional(),
    localized: z.record(z.string(), projectLocalizedAppIdentitySchema),
    applicationId: z.string(),
    saveNamespace: z.string(),
    versionName: z.string(),
    buildNumber: z.number().finite().optional(),
    icon: projectAssetRefSchema.nullable(),
    iconBackgroundColor: z.string().optional(),
    accentColor: z.string().optional(),
    themeColor: z.string().optional(),
    launchImage: projectAssetRefSchema.nullable(),
    launchBackgroundColor: z.string().optional(),
    desktop: z
      .object({
        appleBundleId: z.string().optional(),
        linuxDesktopId: z.string().optional(),
        windowsIdentity: z.string().optional(),
        buildNumber: z.number().finite().optional(),
      })
      .strict(),
    web: z
      .object({ manifestId: z.string().optional(), buildNumber: z.number().finite().optional() })
      .strict(),
    android: z
      .object({
        applicationId: z.string().optional(),
        versionCode: z.number().finite().optional(),
        allowBackup: z.boolean().optional(),
        isGame: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();
const projectSetAppSchema = z.object({ app: projectAppSchema });
const projectRoomNavigationTransitionSchema = z.object({
  transition: z
    .object({
      kind: z.enum(['cut', 'fade', 'dissolve']),
      durationMs: z.number().finite(),
      color: z.string().nullable(),
      skippable: z.boolean(),
    })
    .strict(),
});
const projectTagColorSchema = z.object({ tag: z.string().min(1), color: z.string().min(1) });
const chapterCreateSchema = z.object({
  chapterId: entityIdSchema,
  label: z.string().min(1),
  color: z.string().nullable().optional(),
});
const chapterRenameSchema = z.object({ chapterId: entityIdSchema, label: z.string().min(1) });
const chapterDeleteSchema = z.object({ chapterId: entityIdSchema });
const chapterColorSchema = z.object({ chapterId: entityIdSchema, color: z.string().nullable() });
const assignChaptersSchema = z.object({
  collection: z.string().min(1),
  entityId: entityIdSchema,
  chapterIds: z.array(entityIdSchema),
});
const hiddenCollectionsSchema = z.object({ hiddenCollectionKeys: z.array(z.string().min(1)) });
const explorerOptionsSchema = z.object({
  followActiveTab: z.boolean().optional(),
  organizeByChapter: z.boolean().optional(),
  groupUnassignedItems: z.boolean().optional(),
  hideEmptyCategories: z.boolean().optional(),
  showInfoOnHover: z.boolean().optional(),
});
const variableSetTypeSchema = z.object({
  variableId: entityIdSchema,
  type: z.enum(['boolean', 'integer', 'number', 'string', 'enum']),
  defaultValue: z.unknown().optional(),
  enumValues: z.array(z.string()).optional(),
});
const variableSetDefaultValueSchema = z.object({
  variableId: entityIdSchema,
  defaultValue: z.unknown(),
});
const shaderCompiledOutputSchema = z.object({
  shader: z.string(),
  stage: z.string(),
  variant: z.string(),
  metadata: z
    .object({
      path: z.string().regex(/^project:\/shaders\/bgfx\//),
      byteHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      byteSize: z.number().int().nonnegative().safe(),
      compileInputFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    })
    .strict(),
});
const shaderApplyCompiledOutputsSchema = z.object({ outputs: z.array(shaderCompiledOutputSchema) });

export const entityCreateRecordCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(createEntityRecordSchema, payload, (parsed) =>
    createEntityRecordPatches(document, parsed as never),
  );

export const entityRenameIdCommand: CommandHandler = ({
  document,
  payload,
  graphSnapshot,
  projectInstanceId,
  projectRevision,
}) =>
  parseEntityCommand(renameEntityIdSchema, payload, (parsed) =>
    (() => {
      if (!projectInstanceId) {
        return {
          patches: [],
          diagnostics: [
            error('The dependency graph is not ready for the current project revision.'),
          ],
        };
      }
      const preflight = preflightGraphCommand({
        snapshot: graphSnapshot ?? null,
        projectInstanceId,
        projectRevision: projectRevision ?? 0,
        target: { collection: parsed.collection as never, id: parsed.fromId },
        operation: 'rename',
        confirmRenameWithoutLuaRewrite: parsed.confirmRenameWithoutLuaRewrite,
      });
      if (preflight.kind === 'blocked') {
        return { patches: [], diagnostics: [{ severity: 'error', message: preflight.reason }] };
      }
      const sourceRewrites = exactSourceRewritePatches(document, preflight, parsed.toId);
      if (sourceRewrites.diagnostics?.some((diagnostic) => diagnostic.severity === 'error'))
        return sourceRewrites;
      const renamed = renameEntityIdPatches(
        applyJsonPatch(toJsonValue(document), sourceRewrites.patches).document,
        parsed as never,
        commandReferenceIndex(document, graphSnapshot ?? null),
      );
      return preflightWarningsResult(
        {
          ...renamed,
          patches: [...sourceRewrites.patches, ...renamed.patches],
          affectedPaths: [
            ...(sourceRewrites.affectedPaths ?? []),
            ...(renamed.affectedPaths ?? []),
          ],
        },
        preflight,
      );
    })(),
  );

export const entityDuplicateRecordCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(duplicateEntityRecordSchema, payload, (parsed) =>
    duplicateEntityRecordPatches(document, parsed as never),
  );

export const entityUpdateMetadataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(updateEntityMetadataSchema, payload, (parsed) =>
    updateEntityMetadataPatches(document, parsed as never),
  );

export const assetImportFilesCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(assetImportSchema, payload, (parsed) =>
    importAssetRecordsPatches(document, parsed),
  );

export const assetAssignAliasCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(assetAliasSchema, payload, (parsed) =>
    assignAssetAliasPatches(document, parsed),
  );

export const assetRemoveAliasCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(assetAliasSchema, payload, (parsed) =>
    removeAssetAliasPatches(document, parsed),
  );

export const assetRenameAliasCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(assetRenameAliasSchema, payload, (parsed) =>
    renameAssetAliasPatches(document, parsed),
  );

export const assetReimportFileCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(assetReimportSchema, payload, (parsed) =>
    reimportAssetPatches(document, parsed),
  );

export const assetDeleteAssetCommand: CommandHandler = ({
  document,
  payload,
  graphSnapshot,
  projectInstanceId,
  projectRevision,
}) =>
  parseEntityCommand(assetDeleteSchema, payload, (parsed) => {
    if (!projectInstanceId) {
      return {
        patches: [],
        diagnostics: [error('The dependency graph is not ready for the current project revision.')],
      };
    }
    const deletePath = buildJsonPointer(['assets', parsed.assetId]);
    const metadataPath = buildJsonPointer(['editor', 'recordMetadata', 'assets', parsed.assetId]);
    const plan = generateAuthoringRepairPlan({
      snapshot: graphSnapshot ?? null,
      projectInstanceId,
      projectRevision: projectRevision ?? 0,
      target: recordTarget('assets', parsed.assetId),
      deletePath,
      ...(hasJsonAtPointer(document, metadataPath) ? { metadataPath } : {}),
      force: parsed.force,
    });
    if (plan.status !== 'ready') {
      return { patches: [], diagnostics: [{ severity: 'error', message: plan.reason }] };
    }
    return {
      patches: [...plan.plan.patches],
      affectedPaths: plan.plan.patches.map((patch) => patch.path),
      diagnostics: plan.plan.warnings.map((message) => ({ severity: 'warning' as const, message })),
    };
  });

export const shaderReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(shaderReplaceDataSchema, payload, (parsed) =>
    replaceShaderDataPatches(document, parsed as never),
  );

export const shaderApplyCompiledOutputsCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(shaderApplyCompiledOutputsSchema, payload, (parsed) =>
    applyShaderCompiledOutputsPatches(document, parsed),
  );

export const materialReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(materialReplaceDataSchema, payload, (parsed) =>
    replaceMaterialDataPatches(document, parsed as never),
  );

export const materialSetBaseCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(materialSetBaseSchema, payload, (parsed) =>
    setMaterialBasePatches(document, parsed),
  );

export const variableReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(variableReplaceDataSchema, payload, (parsed) =>
    replaceVariableDataPatches(document, parsed),
  );

export const variableSetTypeCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(variableSetTypeSchema, payload, (parsed) =>
    setVariableTypePatches(document, parsed),
  );

export const variableSetDefaultValueCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(variableSetDefaultValueSchema, payload, (parsed) =>
    setVariableDefaultValuePatches(document, parsed),
  );

export const layoutReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(layoutReplaceDataSchema, payload, (parsed) =>
    replaceLayoutDataPatches(document, parsed),
  );

export const gameplayInstanceSetArchetypeCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(gameplayInstanceArchetypeSchema, payload, (parsed) =>
    setGameplayInstanceArchetypePatches(document, parsed),
  );

export const gameplayInstanceClearArchetypeOverridesCommand: CommandHandler = ({
  document,
  payload,
}) =>
  parseEntityCommand(gameplayInstanceArchetypeOverridesSchema, payload, (parsed) =>
    clearGameplayInstanceArchetypeOverridesPatches(document, parsed),
  );

export const archetypeReplaceConfigurationCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(archetypeConfigurationSchema, payload, (parsed) =>
    replaceArchetypeConfigurationPatches(document, parsed as never),
  );

export const archetypeSetBaseCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(archetypeBaseSchema, payload, (parsed) =>
    setArchetypeBasePatches(document, parsed),
  );

export const archetypeSetKindCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(archetypeKindSchema, payload, (parsed) =>
    setArchetypeKindPatches(document, parsed),
  );

export const characterReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(characterReplaceDataSchema, payload, (parsed) =>
    replaceCharacterDataPatches(document, parsed),
  );

export const interactableReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(interactableReplaceDataSchema, payload, (parsed) =>
    replaceInteractableDataPatches(document, parsed),
  );

export const dialogueReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(dialogueReplaceDataSchema, payload, (parsed) =>
    replaceDialogueDataPatches(document, parsed),
  );

export const roomReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(roomReplaceDataSchema, payload, (parsed) =>
    replaceRoomDataPatches(document, parsed),
  );

export const roomAddHotspotCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(roomAddHotspotSchema, payload, ({ roomId, hotspot }) =>
    updateRoomHotspots(document, roomId, (data) =>
      data.hotspots.some((item) => item.id === hotspot.id)
        ? null
        : { ...data, hotspots: [...data.hotspots, hotspot] },
    ),
  );
export const roomDeleteHotspotCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(roomHotspotSchema, payload, ({ roomId, hotspotId }) =>
    deleteRoomHotspot(document, roomId, hotspotId),
  );
export const roomRenameHotspotCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(roomRenameHotspotSchema, payload, ({ roomId, hotspotId, nextId }) =>
    renameHotspot(document, 'room', roomId, hotspotId, nextId),
  );
export const roomUpdateHotspotCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(roomUpdateHotspotSchema, payload, ({ roomId, hotspotId, hotspot }) =>
    updateRoomHotspots(document, roomId, (data) => ({
      ...data,
      hotspots: data.hotspots.map((item) =>
        item.id === hotspotId ? { ...item, ...hotspot } : item,
      ),
    })),
  );
export const roomSetHotspotBoundsCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(roomSetHotspotBoundsSchema, payload, ({ roomId, hotspotId, bounds }) =>
    validBounds(bounds)
      ? updateRoomHotspots(document, roomId, (data) => ({
          ...data,
          hotspots: data.hotspots.map((item) =>
            item.id === hotspotId
              ? { ...item, shape: { kind: 'rect', bounds: bounds as never } }
              : item,
          ),
        }))
      : { patches: [], diagnostics: [error('Hotspot bounds are invalid.')] },
  );
export const roomReorderHotspotsCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(roomReorderHotspotsSchema, payload, ({ roomId, hotspotIds }) =>
    updateRoomHotspots(document, roomId, (data) => {
      if (
        hotspotIds.length !== data.hotspots.length ||
        new Set(hotspotIds).size !== hotspotIds.length
      )
        return null;
      const byId = new Map(data.hotspots.map((item) => [item.id, item]));
      const hotspots = hotspotIds.map((id) => byId.get(id));
      return hotspots.every(Boolean)
        ? { ...data, hotspots: hotspots as typeof data.hotspots }
        : null;
    }),
  );

export const roomSetPlacementBoundsCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(roomSetPlacementBoundsSchema, payload, (parsed) =>
    setRoomPlacementBoundsPatches(document, parsed),
  );
export const roomPlaceInteractableCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(roomPlaceInteractableSchema, payload, (parsed) =>
    placeInteractablePatches(document, parsed),
  );
export const roomMoveInteractableToPlacementCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(roomMoveInteractableToPlacementSchema, payload, (parsed) =>
    moveInteractableToPlacementPatches(document, parsed),
  );
export const roomDetachInteractablePlacementCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(roomDetachInteractablePlacementSchema, payload, (parsed) =>
    detachInteractablePlacementPatches(document, parsed),
  );

export const interactableAddHotspotCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(interactableAddHotspotSchema, payload, ({ interactableId, hotspot }) =>
    updateInteractableHotspots(document, interactableId, (data) =>
      data.presentation.hotspots.kind !== 'custom' ||
      data.presentation.hotspots.hotspots.some((item) => item.id === hotspot.id)
        ? null
        : {
            ...data,
            presentation: {
              ...data.presentation,
              hotspots: {
                kind: 'custom',
                hotspots: [...data.presentation.hotspots.hotspots, hotspot],
              },
            },
          },
    ),
  );
export const interactableDeleteHotspotCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(interactableHotspotSchema, payload, ({ interactableId, hotspotId }) =>
    deleteInteractableHotspot(document, interactableId, hotspotId),
  );
export const interactableRenameHotspotCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(
    interactableRenameHotspotSchema,
    payload,
    ({ interactableId, hotspotId, nextId }) =>
      renameHotspot(document, 'interactable', interactableId, hotspotId, nextId),
  );
export const interactableUpdateHotspotCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(
    interactableUpdateHotspotSchema,
    payload,
    ({ interactableId, hotspotId, hotspot }) =>
      updateInteractableHotspots(document, interactableId, (data) => {
        const current = data.presentation.hotspots;
        const hotspots =
          current.kind === 'sprite-alpha'
            ? {
                kind: 'sprite-alpha' as const,
                hotspot:
                  current.hotspot.id === hotspotId
                    ? { id: hotspotId, ...hotspot }
                    : current.hotspot,
              }
            : {
                kind: 'custom' as const,
                hotspots: current.hotspots.map((item) =>
                  item.id === hotspotId ? { ...item, ...hotspot } : item,
                ),
              };
        return { ...data, presentation: { ...data.presentation, hotspots } };
      }),
  );
export const interactableSetHotspotBoundsCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(
    interactableSetHotspotBoundsSchema,
    payload,
    ({ interactableId, hotspotId, bounds }) =>
      validBounds(bounds)
        ? updateInteractableHotspots(document, interactableId, (data) =>
            data.presentation.hotspots.kind !== 'custom'
              ? null
              : {
                  ...data,
                  presentation: {
                    ...data.presentation,
                    hotspots: {
                      kind: 'custom',
                      hotspots: data.presentation.hotspots.hotspots.map((item) =>
                        item.id === hotspotId
                          ? { ...item, shape: { kind: 'rect', bounds: bounds as never } }
                          : item,
                      ),
                    },
                  },
                },
          )
        : { patches: [], diagnostics: [error('Hotspot bounds are invalid.')] },
  );
export const interactableReorderHotspotsCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(interactableReorderHotspotsSchema, payload, ({ interactableId, hotspotIds }) =>
    updateInteractableHotspots(document, interactableId, (data) => {
      if (data.presentation.hotspots.kind !== 'custom') return null;
      const current = data.presentation.hotspots.hotspots;
      if (hotspotIds.length !== current.length || new Set(hotspotIds).size !== hotspotIds.length)
        return null;
      const byId = new Map(current.map((item) => [item.id, item]));
      const hotspots = hotspotIds.map((id) => byId.get(id));
      return hotspots.every(Boolean)
        ? {
            ...data,
            presentation: {
              ...data.presentation,
              hotspots: { kind: 'custom', hotspots: hotspots as typeof current },
            },
          }
        : null;
    }),
  );
export const interactableSetHotspotModeCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(interactableSetHotspotModeSchema, payload, ({ interactableId, kind }) =>
    setInteractableHotspotMode(document, interactableId, kind),
  );

export const sceneReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(sceneReplaceDataSchema, payload, (parsed) =>
    replaceSceneDataPatches(document, parsed),
  );

export const testReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(testReplaceDataSchema, payload, (parsed) =>
    replaceTestDataPatches(document, parsed),
  );

export const verbReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(verbReplaceDataSchema, payload, (parsed) =>
    replaceVerbDataPatches(document, parsed),
  );

export const interactionReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(interactionReplaceDataSchema, payload, (parsed) =>
    replaceInteractionDataPatches(document, parsed),
  );

export const mapReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(mapReplaceDataSchema, payload, (parsed) =>
    replaceMapDataPatches(document, parsed),
  );

export const scriptModuleReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(scriptModuleReplaceDataSchema, payload, (parsed) =>
    replaceScriptModuleDataPatches(document, parsed),
  );

export const projectUpdateMetadataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(projectMetadataSchema, payload, (parsed) =>
    updateProjectMetadataPatches(document, parsed),
  );

export const projectSetEntrypointCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(projectEntrypointSchema, payload, (parsed) =>
    setProjectEntrypointPatches(document, parsed as never),
  );

export const projectSetBootstrapModuleCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(projectBootstrapModuleSchema, payload, (parsed) =>
    setProjectBootstrapModulePatches(document, parsed),
  );

export const projectSetDisplayCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(projectDisplaySchema, payload, (parsed) =>
    setProjectDisplayPatches(document, parsed),
  );

export const projectSetReferenceResolutionCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(projectReferenceResolutionSchema, payload, (parsed) =>
    setProjectReferenceResolutionPatches(document, parsed),
  );

export const projectSetAccessibilityScaleCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(projectAccessibilityScaleSchema, payload, (parsed) =>
    setProjectAccessibilityScalePatches(document, parsed),
  );

export const projectSetSystemLayoutCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(setSystemLayoutSchema, payload, (parsed) =>
    setProjectSystemLayoutPatches(document, parsed),
  );

export const projectSetDefaultFontCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(projectDefaultFontSchema, payload, (parsed) =>
    setProjectDefaultFontPatches(document, parsed),
  );

export const projectSetTitleScreenCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(projectTitleScreenSchema, payload, (parsed) =>
    setProjectTitleScreenPatches(document, parsed),
  );

export const projectSetUndefinedInteractionProgramCommand: CommandHandler = ({
  document,
  payload,
}) =>
  parseEntityCommand(projectUndefinedInteractionProgramSchema, payload, (parsed) =>
    setProjectUndefinedInteractionProgramPatches(document, parsed),
  );

export const projectSetIconCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(projectIconSchema, payload, (parsed) =>
    setProjectIconPatches(document, parsed),
  );

export const projectSetAppCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(projectSetAppSchema, payload, (parsed) =>
    setProjectAppPatches(document, parsed),
  );

export const projectSetRoomNavigationTransitionCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(projectRoomNavigationTransitionSchema, payload, (parsed) =>
    setProjectRoomNavigationTransitionPatches(document, parsed),
  );

export const projectSetTagColorCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(projectTagColorSchema, payload, (parsed) =>
    setProjectTagColorPatches(document, parsed),
  );

export const projectCreateChapterCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(chapterCreateSchema, payload, (parsed) =>
    createChapterPatches(document, parsed),
  );

export const projectRenameChapterCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(chapterRenameSchema, payload, (parsed) =>
    renameChapterPatches(document, parsed),
  );

export const projectDeleteChapterCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(chapterDeleteSchema, payload, (parsed) =>
    deleteChapterPatches(document, parsed),
  );

export const projectSetChapterColorCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(chapterColorSchema, payload, (parsed) =>
    setChapterColorPatches(document, parsed),
  );

export const projectAssignChaptersCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(assignChaptersSchema, payload, (parsed) =>
    assignChaptersPatches(document, parsed as never),
  );

export const projectSetHiddenCollectionsCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(hiddenCollectionsSchema, payload, (parsed) =>
    setHiddenCollectionsPatches(document, parsed as never),
  );

export const projectSetExplorerOptionsCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(explorerOptionsSchema, payload, (parsed) =>
    setExplorerOptionsPatches(document, parsed),
  );

export function createBuiltinCommandHandlers(): Record<string, CommandHandler> {
  return {
    'project.applyPatch': projectApplyPatchCommand,
    'project.replaceAtPath': projectReplaceAtPathCommand,
    'project.addAtPath': projectAddAtPathCommand,
    'project.removeAtPath': projectRemoveAtPathCommand,
    'entity.replaceRecord': entityReplaceRecordCommand,
    'entity.createRecord': entityCreateRecordCommand,
    'entity.renameId': entityRenameIdCommand,
    'entity.duplicateRecord': entityDuplicateRecordCommand,
    'entity.deleteRecord': entityDeleteRecordCommand,
    'entity.updateMetadata': entityUpdateMetadataCommand,
    'asset.importFiles': assetImportFilesCommand,
    'asset.assignAlias': assetAssignAliasCommand,
    'asset.removeAlias': assetRemoveAliasCommand,
    'asset.renameAlias': assetRenameAliasCommand,
    'asset.reimportFile': assetReimportFileCommand,
    'asset.deleteAsset': assetDeleteAssetCommand,
    'shader.replaceData': shaderReplaceDataCommand,
    'shader.applyCompiledOutputs': shaderApplyCompiledOutputsCommand,
    'material.replaceData': materialReplaceDataCommand,
    'material.setBase': materialSetBaseCommand,
    'variable.replaceData': variableReplaceDataCommand,
    'variable.setType': variableSetTypeCommand,
    'variable.setDefaultValue': variableSetDefaultValueCommand,
    'layout.replaceData': layoutReplaceDataCommand,
    'gameplay-instance.setArchetype': gameplayInstanceSetArchetypeCommand,
    'gameplay-instance.clearArchetypeOverrides': gameplayInstanceClearArchetypeOverridesCommand,
    'archetype.replaceConfiguration': archetypeReplaceConfigurationCommand,
    'archetype.setBase': archetypeSetBaseCommand,
    'archetype.setKind': archetypeSetKindCommand,
    'character.replaceData': characterReplaceDataCommand,
    'interactable.replaceData': interactableReplaceDataCommand,
    'dialogue.replaceData': dialogueReplaceDataCommand,
    'room.replaceData': roomReplaceDataCommand,
    'room.addHotspot': roomAddHotspotCommand,
    'room.deleteHotspot': roomDeleteHotspotCommand,
    'room.renameHotspot': roomRenameHotspotCommand,
    'room.updateHotspot': roomUpdateHotspotCommand,
    'room.setHotspotBounds': roomSetHotspotBoundsCommand,
    'room.reorderHotspots': roomReorderHotspotsCommand,
    'room.setPlacementBounds': roomSetPlacementBoundsCommand,
    'room.placeInteractable': roomPlaceInteractableCommand,
    'room.moveInteractableToPlacement': roomMoveInteractableToPlacementCommand,
    'room.detachInteractablePlacement': roomDetachInteractablePlacementCommand,
    'interactable.addHotspot': interactableAddHotspotCommand,
    'interactable.deleteHotspot': interactableDeleteHotspotCommand,
    'interactable.renameHotspot': interactableRenameHotspotCommand,
    'interactable.updateHotspot': interactableUpdateHotspotCommand,
    'interactable.setHotspotBounds': interactableSetHotspotBoundsCommand,
    'interactable.reorderHotspots': interactableReorderHotspotsCommand,
    'interactable.setHotspotMode': interactableSetHotspotModeCommand,
    'scene.replaceData': sceneReplaceDataCommand,
    'test.replaceData': testReplaceDataCommand,
    'verb.replaceData': verbReplaceDataCommand,
    'interaction.replaceData': interactionReplaceDataCommand,
    'map.replaceData': mapReplaceDataCommand,
    'script.replaceData': scriptModuleReplaceDataCommand,
    'project.updateMetadata': projectUpdateMetadataCommand,
    'project.setEntrypoint': projectSetEntrypointCommand,
    'project.setBootstrapModule': projectSetBootstrapModuleCommand,
    'project.setDisplay': projectSetDisplayCommand,
    'project.setReferenceResolution': projectSetReferenceResolutionCommand,
    'project.setAccessibilityScale': projectSetAccessibilityScaleCommand,
    'project.setSystemLayout': projectSetSystemLayoutCommand,
    'project.setDefaultFont': projectSetDefaultFontCommand,
    'project.setTitleScreen': projectSetTitleScreenCommand,
    'project.setUndefinedInteractionProgram': projectSetUndefinedInteractionProgramCommand,
    'project.setIcon': projectSetIconCommand,
    'project.setApp': projectSetAppCommand,
    'project.setRoomNavigationTransition': projectSetRoomNavigationTransitionCommand,
    'project.setTagColor': projectSetTagColorCommand,
    'project.createChapter': projectCreateChapterCommand,
    'project.renameChapter': projectRenameChapterCommand,
    'project.deleteChapter': projectDeleteChapterCommand,
    'project.setChapterColor': projectSetChapterColorCommand,
    'project.assignChapters': projectAssignChaptersCommand,
    'project.setHiddenCollections': projectSetHiddenCollectionsCommand,
    'project.setExplorerOptions': projectSetExplorerOptionsCommand,
  };
}

export function labelForCommand(type: string): string {
  switch (type) {
    case 'project.applyPatch':
      return 'Apply project patch';
    case 'project.replaceAtPath':
      return 'Replace project value';
    case 'project.addAtPath':
      return 'Add project value';
    case 'project.removeAtPath':
      return 'Remove project value';
    case 'entity.replaceRecord':
      return 'Replace entity record';
    case 'entity.createRecord':
      return 'Create entity record';
    case 'entity.renameId':
      return 'Rename entity ID';
    case 'entity.duplicateRecord':
      return 'Duplicate entity record';
    case 'entity.deleteRecord':
      return 'Delete entity record';
    case 'entity.updateMetadata':
      return 'Update entity metadata';
    case 'asset.importFiles':
      return 'Import assets';
    case 'asset.assignAlias':
      return 'Assign asset alias';
    case 'asset.removeAlias':
      return 'Remove asset alias';
    case 'asset.renameAlias':
      return 'Rename asset alias';
    case 'asset.reimportFile':
      return 'Reimport asset';
    case 'asset.deleteAsset':
      return 'Delete asset';
    case 'shader.replaceData':
      return 'Update shader';
    case 'shader.applyCompiledOutputs':
      return 'Apply shader compile outputs';
    case 'material.replaceData':
      return 'Update material';
    case 'material.setBase':
      return 'Set base material';
    case 'variable.replaceData':
      return 'Update variable';
    case 'variable.setType':
      return 'Set variable type';
    case 'variable.setDefaultValue':
      return 'Set variable default value';
    case 'layout.replaceData':
      return 'Update layout';
    case 'gameplay-instance.setArchetype':
      return 'Set Archetype';
    case 'gameplay-instance.clearArchetypeOverrides':
      return 'Reset Archetype overrides';
    case 'archetype.replaceConfiguration':
      return 'Update Archetype configuration';
    case 'archetype.setBase':
      return 'Set base Archetype';
    case 'archetype.setKind':
      return 'Set Archetype kind';
    case 'character.replaceData':
      return 'Update character';
    case 'interactable.replaceData':
      return 'Update interactable';
    case 'dialogue.replaceData':
      return 'Update dialogue';
    case 'room.replaceData':
      return 'Update room';
    case 'room.setPlacementBounds':
      return 'Update room placement bounds';
    case 'room.placeInteractable':
      return 'Place interactable';
    case 'room.moveInteractableToPlacement':
      return 'Move interactable to placement';
    case 'room.detachInteractablePlacement':
      return 'Create dedicated interactable placement';
    case 'scene.replaceData':
      return 'Update scene';
    case 'test.replaceData':
      return 'Update test';
    case 'verb.replaceData':
      return 'Update verb';
    case 'interaction.replaceData':
      return 'Update interaction';
    case 'map.replaceData':
      return 'Update map';
    case 'script.replaceData':
      return 'Update Script Module';
    case 'project.updateMetadata':
      return 'Update project metadata';
    case 'project.setEntrypoint':
      return 'Set project entrypoint';
    case 'project.setBootstrapModule':
      return 'Update project startup';
    case 'project.setDisplay':
      return 'Update project display';
    case 'project.setReferenceResolution':
      return 'Change project reference resolution';
    case 'project.setAccessibilityScale':
      return 'Update project accessibility scale';
    case 'project.setSystemLayout':
      return 'Set project system layout';
    case 'project.setDefaultFont':
      return 'Set project default font';
    case 'project.setTitleScreen':
      return 'Update title screen settings';
    case 'project.setUndefinedInteractionProgram':
      return 'Update undefined Interaction behavior';
    case 'project.setIcon':
      return 'Set project icon';
    case 'project.setApp':
      return 'Update app identity';
    case 'project.setRoomNavigationTransition':
      return 'Update room navigation transition';
    case 'project.setTagColor':
      return 'Set tag color';
    case 'project.createChapter':
      return 'Create chapter';
    case 'project.renameChapter':
      return 'Rename chapter';
    case 'project.deleteChapter':
      return 'Delete chapter';
    case 'project.setChapterColor':
      return 'Set chapter color';
    case 'project.assignChapters':
      return 'Assign chapters';
    case 'project.setHiddenCollections':
      return 'Update hidden categories';
    case 'project.setExplorerOptions':
      return 'Update explorer options';
    default:
      return type;
  }
}

export type BuiltinCommandHandlerResult = CommandHandlerResult;
