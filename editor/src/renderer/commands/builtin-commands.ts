import { z } from 'zod';
import {
  assignAssetAliasPatches,
  deleteAssetPatches,
  importAssetRecordsPatches,
  reimportAssetPatches,
  removeAssetAliasPatches,
  renameAssetAliasPatches,
} from '@/project/asset-operations';
import { buildJsonPointer, getJsonAtPointer, hasJsonAtPointer } from '@/project/json-pointer';
import { isJsonArray, isJsonObject, toJsonValue, type JsonValue } from '@/project/json-value';
import {
  createEntityRecordPatches,
  deleteEntityRecordPatches,
  duplicateEntityRecordPatches,
  renameEntityIdPatches,
  setEntityParentPatches,
  updateEntityMetadataPatches,
} from '@/project/entity-operations';
import {
  applyShaderCompiledOutputsPatches,
  replaceMaterialDataPatches,
  replaceShaderDataPatches,
  setMaterialInheritsPatches,
} from '@/project/shader-material-operations';
import {
  replaceVariableDataPatches,
  setVariableDefaultValuePatches,
  setVariableTypePatches,
} from '@/project/variable-operations';
import { replaceCharacterDataPatches } from '@/project/character-operations';
import { replaceDialogueDataPatches } from '@/project/dialogue-operations';
import { replaceRoomDataPatches } from '@/project/room-operations';
import { replaceSceneDataPatches } from '@/project/scene-operations';
import { replaceTestDataPatches } from '@/project/test-operations';
import { replaceLayoutDataPatches, setDefaultLayoutPatches } from '@/project/layout-operations';
import {
  setProjectComfyUiPatches,
  setProjectDefaultFontPatches,
  setProjectDefaultLayoutPatches,
  setProjectEntrypointPatches,
  setProjectIconPatches,
  setProjectStartupPatches,
  setProjectTagColorPatches,
  setProjectTitleScreenPatches,
  updateProjectMetadataPatches,
} from '@/project/project-settings-operations';
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

function parsePayload<T>(schema: z.ZodType<T>, payload: unknown): { ok: true; value: T } | { ok: false; diagnostics: CommandDiagnostic[] } {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    diagnostics: parsed.error.issues.map((issue) => error(issue.message, issue.path.length ? `/${issue.path.join('/')}` : undefined)),
  };
}

export const projectApplyPatchCommand: CommandHandler = ({ payload }) => {
  const parsed = parsePayload(z.array(patchOperationSchema), payload);
  if (!parsed.ok) return { patches: [], diagnostics: parsed.diagnostics };
  return {
    patches: parsed.value.map((operation) =>
      operation.op === 'remove'
        ? { op: operation.op, path: operation.path }
        : { op: operation.op, path: operation.path, value: toJsonValue(operation.value) },
    ),
    affectedPaths: parsed.value.map((operation) => operation.path),
  };
};

export const projectReplaceAtPathCommand: CommandHandler = ({ document, payload }) => {
  const parsed = parsePayload(pathValueSchema, payload);
  if (!parsed.ok) return { patches: [], diagnostics: parsed.diagnostics };
  if (!hasJsonAtPointer(document, parsed.value.path)) {
    return { patches: [], diagnostics: [error('Replace target does not exist.', parsed.value.path)] };
  }
  return {
    patches: [{ op: 'replace', path: parsed.value.path, value: toJsonValue(parsed.value.value) }],
    affectedPaths: [parsed.value.path],
  };
};

export const projectAddAtPathCommand: CommandHandler = ({ document, payload }) => {
  const parsed = parsePayload(pathValueSchema, payload);
  if (!parsed.ok) return { patches: [], diagnostics: parsed.diagnostics };
  if (parsed.value.path !== '') {
    const parent = parsed.value.path.slice(0, parsed.value.path.lastIndexOf('/')) || '';
    if (!hasJsonAtPointer(document, parent)) {
      return { patches: [], diagnostics: [error('Add parent path does not exist.', parent)] };
    }
  }
  return {
    patches: [{ op: 'add', path: parsed.value.path, value: toJsonValue(parsed.value.value) }],
    affectedPaths: [parsed.value.path],
  };
};

export const projectRemoveAtPathCommand: CommandHandler = ({ document, payload }) => {
  const parsed = parsePayload(pathOnlySchema, payload);
  if (!parsed.ok) return { patches: [], diagnostics: parsed.diagnostics };
  if (parsed.value.path === '') {
    return { patches: [], diagnostics: [error('Cannot remove the project document root.', parsed.value.path)] };
  }
  if (!hasJsonAtPointer(document, parsed.value.path)) {
    return { patches: [], diagnostics: [error('Remove target does not exist.', parsed.value.path)] };
  }
  return { patches: [{ op: 'remove', path: parsed.value.path }], affectedPaths: [parsed.value.path] };
};

function normalizeCurrentRecord(collection: string, entityId: string, record: JsonValue): { record: JsonValue; diagnostics: CommandDiagnostic[] } {
  const diagnostics: CommandDiagnostic[] = [];
  if (isJsonArray(record)) {
    const next = [...record];
    if (next.length === 0 || typeof next[0] !== 'string') {
      diagnostics.push(error('Legacy-shaped entity record must have a string ID in index 0.', buildJsonPointer([collection, entityId, '0'])));
      return { record, diagnostics };
    }
    if (next[0] !== entityId) {
      next[0] = entityId;
      diagnostics.push({
        severity: 'warning',
        path: buildJsonPointer([collection, entityId, '0']),
        message: 'Entity record id did not match the map key and was normalized.',
      });
    }
    return { record: next, diagnostics };
  }
  return { record, diagnostics };
}

export const entityReplaceRecordCommand: CommandHandler = ({ document, payload }) => {
  const parsed = parsePayload(recordSchema, payload);
  if (!parsed.ok) return { patches: [], diagnostics: parsed.diagnostics };
  const { collection, entityId } = parsed.value;
  const collectionPath = buildJsonPointer([collection]);
  if (!hasJsonAtPointer(document, collectionPath)) {
    return { patches: [], diagnostics: [error('Entity collection does not exist.', collectionPath)] };
  }
  const collectionValue = getJsonAtPointer(document, collectionPath);
  if (!isJsonObject(collectionValue)) {
    return { patches: [], diagnostics: [error('Entity collection is not an object.', collectionPath)] };
  }
  const normalized = normalizeCurrentRecord(collection, entityId, toJsonValue(parsed.value.record));
  if (normalized.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return { patches: [], diagnostics: normalized.diagnostics };
  }
  const path = buildJsonPointer([collection, entityId]);
  return {
    patches: [
      Object.prototype.hasOwnProperty.call(collectionValue, entityId)
        ? { op: 'replace', path, value: normalized.record }
        : { op: 'add', path, value: normalized.record },
    ],
    diagnostics: normalized.diagnostics,
    affectedPaths: [path],
  };
};

export const entityDeleteRecordCommand: CommandHandler = ({ document, payload }) => {
  const parsed = parsePayload(deleteRecordSchema.extend({ force: z.boolean().optional() }), payload);
  if (!parsed.ok) return { patches: [], diagnostics: parsed.diagnostics };
  return deleteEntityRecordPatches(document, parsed.value as never);
};

function parseEntityCommand<T>(schema: z.ZodType<T>, payload: unknown, createResult: (payload: T) => CommandHandlerResult): CommandHandlerResult {
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
  parent: z.object({ collection: z.string(), id: z.string() }).nullable().optional(),
  tags: z.array(z.string()).optional(),
  color: z.string().nullable().optional(),
  data: z.unknown().optional(),
});

const renameEntityIdSchema = z.object({
  collection: authoringCollectionSchema,
  fromId: entityIdSchema,
  toId: entityIdSchema,
  label: z.string().optional(),
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

const setEntityParentSchema = z.object({
  collection: authoringCollectionSchema,
  entityId: entityIdSchema,
  parentId: z.string().nullable(),
});

const importedAssetMetadataSchema = z.object({
  originalPath: z.string(),
  originalName: z.string(),
  projectRelativePath: z.string(),
  kind: z.enum(['image', 'font', 'audio', 'script', 'shader-source', 'text', 'data', 'binary']),
  extension: z.string(),
  mimeType: z.string().optional(),
  byteSize: z.number().nonnegative(),
  contentHash: z.string(),
  importedAt: z.string(),
});

const assetImportSchema = z.object({ assets: z.array(importedAssetMetadataSchema) });
const assetAliasSchema = z.object({ assetId: entityIdSchema, alias: z.string().min(1) });
const assetRenameAliasSchema = z.object({ fromAlias: z.string().min(1), toAlias: z.string().min(1) });
const assetReimportSchema = z.object({ assetId: entityIdSchema, asset: importedAssetMetadataSchema });
const assetDeleteSchema = z.object({ assetId: entityIdSchema, force: z.boolean().optional() });
const shaderReplaceDataSchema = z.object({ shaderId: entityIdSchema, data: z.unknown() });
const materialReplaceDataSchema = z.object({ materialId: entityIdSchema, data: z.unknown() });
const variableReplaceDataSchema = z.object({ variableId: entityIdSchema, data: z.unknown() });
const characterReplaceDataSchema = z.object({ characterId: entityIdSchema, data: z.unknown() });
const dialogueReplaceDataSchema = z.object({ dialogueId: entityIdSchema, data: z.unknown() });
const roomReplaceDataSchema = z.object({ roomId: entityIdSchema, data: z.unknown() });
const sceneReplaceDataSchema = z.object({ sceneId: entityIdSchema, data: z.unknown() });
const testReplaceDataSchema = z.object({ testId: entityIdSchema, data: z.unknown() });
const layoutReplaceDataSchema = z.object({ layoutId: entityIdSchema, data: z.unknown() });
const setDefaultLayoutSchema = z.object({ layoutId: entityIdSchema.nullable() });
const projectMetadataSchema = z.object({ name: z.string().optional(), version: z.string().optional(), author: z.string().optional(), description: z.string().optional() });
const projectEntrypointSchema = z.object({ target: z.object({ collection: z.string().min(1), id: entityIdSchema }).nullable() });
const projectStartupSchema = z.object({ initScript: z.string() });
const projectDefaultFontSchema = z.object({ assetId: entityIdSchema.nullable() });
const projectTitleScreenSchema = z.object({
  titleImageId: entityIdSchema.nullable().optional(),
  showProjectTitle: z.boolean().optional(),
  showAuthor: z.boolean().optional(),
  subtitle: z.string().optional(),
  startLabel: z.string().optional(),
});
const projectIconSchema = z.object({ assetId: entityIdSchema.nullable() });
const projectComfyUiSchema = z.object({
  enabled: z.boolean().optional(),
  serverUrl: z.string().optional(),
  defaultWorkflowId: z.string().min(1).optional(),
  requestTimeoutMs: z.number().int().min(1000).max(120000).optional(),
  connectionCheckIntervalMs: z.number().int().min(3000).max(120000).optional(),
});
const projectTagColorSchema = z.object({ tag: z.string().min(1), color: z.string().min(1) });
const chapterCreateSchema = z.object({ chapterId: entityIdSchema, label: z.string().min(1), color: z.string().nullable().optional() });
const chapterRenameSchema = z.object({ chapterId: entityIdSchema, label: z.string().min(1) });
const chapterDeleteSchema = z.object({ chapterId: entityIdSchema });
const chapterColorSchema = z.object({ chapterId: entityIdSchema, color: z.string().nullable() });
const assignChaptersSchema = z.object({ collection: z.string().min(1), entityId: entityIdSchema, chapterIds: z.array(entityIdSchema) });
const hiddenCollectionsSchema = z.object({ hiddenCollectionKeys: z.array(z.string().min(1)) });
const explorerOptionsSchema = z.object({ followActiveTab: z.boolean().optional(), organizeByChapter: z.boolean().optional(), groupUnassignedItems: z.boolean().optional(), hideEmptyCategories: z.boolean().optional(), showInfoOnHover: z.boolean().optional() });
const variableSetTypeSchema = z.object({
  variableId: entityIdSchema,
  type: z.enum(['boolean', 'integer', 'number', 'string', 'enum']),
  defaultValue: z.unknown().optional(),
  enumValues: z.array(z.string()).optional(),
});
const variableSetDefaultValueSchema = z.object({ variableId: entityIdSchema, defaultValue: z.unknown() });
const materialSetInheritsSchema = z.object({ materialId: entityIdSchema, inheritsId: z.string().nullable() });
const shaderCompiledOutputSchema = z.object({ shader: z.string(), stage: z.string(), variant: z.string(), runtimePath: z.string() });
const shaderApplyCompiledOutputsSchema = z.object({ outputs: z.array(shaderCompiledOutputSchema) });

export const entityCreateRecordCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(createEntityRecordSchema, payload, (parsed) => createEntityRecordPatches(document, parsed as never));

export const entityRenameIdCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(renameEntityIdSchema, payload, (parsed) => renameEntityIdPatches(document, parsed as never));

export const entityDuplicateRecordCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(duplicateEntityRecordSchema, payload, (parsed) => duplicateEntityRecordPatches(document, parsed as never));

export const entityUpdateMetadataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(updateEntityMetadataSchema, payload, (parsed) => updateEntityMetadataPatches(document, parsed as never));

export const entitySetParentCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(setEntityParentSchema, payload, (parsed) => setEntityParentPatches(document, parsed as never));

export const assetImportFilesCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(assetImportSchema, payload, (parsed) => importAssetRecordsPatches(document, parsed));

export const assetAssignAliasCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(assetAliasSchema, payload, (parsed) => assignAssetAliasPatches(document, parsed));

export const assetRemoveAliasCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(assetAliasSchema, payload, (parsed) => removeAssetAliasPatches(document, parsed));

export const assetRenameAliasCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(assetRenameAliasSchema, payload, (parsed) => renameAssetAliasPatches(document, parsed));

export const assetReimportFileCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(assetReimportSchema, payload, (parsed) => reimportAssetPatches(document, parsed));

export const assetDeleteAssetCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(assetDeleteSchema, payload, (parsed) => deleteAssetPatches(document, parsed));

export const shaderReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(shaderReplaceDataSchema, payload, (parsed) => replaceShaderDataPatches(document, parsed as never));

export const shaderApplyCompiledOutputsCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(shaderApplyCompiledOutputsSchema, payload, (parsed) => applyShaderCompiledOutputsPatches(document, parsed));

export const materialReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(materialReplaceDataSchema, payload, (parsed) => replaceMaterialDataPatches(document, parsed as never));

export const materialSetInheritsCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(materialSetInheritsSchema, payload, (parsed) => setMaterialInheritsPatches(document, parsed));

export const variableReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(variableReplaceDataSchema, payload, (parsed) => replaceVariableDataPatches(document, parsed));

export const variableSetTypeCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(variableSetTypeSchema, payload, (parsed) => setVariableTypePatches(document, parsed));

export const variableSetDefaultValueCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(variableSetDefaultValueSchema, payload, (parsed) => setVariableDefaultValuePatches(document, parsed));

export const layoutReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(layoutReplaceDataSchema, payload, (parsed) => replaceLayoutDataPatches(document, parsed));

export const characterReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(characterReplaceDataSchema, payload, (parsed) => replaceCharacterDataPatches(document, parsed));

export const dialogueReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(dialogueReplaceDataSchema, payload, (parsed) => replaceDialogueDataPatches(document, parsed));

export const roomReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(roomReplaceDataSchema, payload, (parsed) => replaceRoomDataPatches(document, parsed));

export const sceneReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(sceneReplaceDataSchema, payload, (parsed) => replaceSceneDataPatches(document, parsed));

export const testReplaceDataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(testReplaceDataSchema, payload, (parsed) => replaceTestDataPatches(document, parsed));

export const projectSetDefaultLayoutCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(setDefaultLayoutSchema, payload, (parsed) => setDefaultLayoutPatches(document, parsed));

export const projectUpdateMetadataCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(projectMetadataSchema, payload, (parsed) => updateProjectMetadataPatches(document, parsed));

export const projectSetEntrypointCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(projectEntrypointSchema, payload, (parsed) => setProjectEntrypointPatches(document, parsed as never));

export const projectSetStartupCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(projectStartupSchema, payload, (parsed) => setProjectStartupPatches(document, parsed));

export const projectSetRuntimeDefaultLayoutCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(setDefaultLayoutSchema, payload, (parsed) => setProjectDefaultLayoutPatches(document, parsed));

export const projectSetDefaultFontCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(projectDefaultFontSchema, payload, (parsed) => setProjectDefaultFontPatches(document, parsed));

export const projectSetTitleScreenCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(projectTitleScreenSchema, payload, (parsed) => setProjectTitleScreenPatches(document, parsed));

export const projectSetIconCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(projectIconSchema, payload, (parsed) => setProjectIconPatches(document, parsed));

export const projectSetComfyUiCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(projectComfyUiSchema, payload, (parsed) => setProjectComfyUiPatches(document, parsed));

export const projectSetTagColorCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(projectTagColorSchema, payload, (parsed) => setProjectTagColorPatches(document, parsed));

export const projectCreateChapterCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(chapterCreateSchema, payload, (parsed) => createChapterPatches(document, parsed));

export const projectRenameChapterCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(chapterRenameSchema, payload, (parsed) => renameChapterPatches(document, parsed));

export const projectDeleteChapterCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(chapterDeleteSchema, payload, (parsed) => deleteChapterPatches(document, parsed));

export const projectSetChapterColorCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(chapterColorSchema, payload, (parsed) => setChapterColorPatches(document, parsed));

export const projectAssignChaptersCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(assignChaptersSchema, payload, (parsed) => assignChaptersPatches(document, parsed as never));

export const projectSetHiddenCollectionsCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(hiddenCollectionsSchema, payload, (parsed) => setHiddenCollectionsPatches(document, parsed as never));

export const projectSetExplorerOptionsCommand: CommandHandler = ({ document, payload }) =>
  parseEntityCommand(explorerOptionsSchema, payload, (parsed) => setExplorerOptionsPatches(document, parsed));

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
    'entity.setParent': entitySetParentCommand,
    'asset.importFiles': assetImportFilesCommand,
    'asset.assignAlias': assetAssignAliasCommand,
    'asset.removeAlias': assetRemoveAliasCommand,
    'asset.renameAlias': assetRenameAliasCommand,
    'asset.reimportFile': assetReimportFileCommand,
    'asset.deleteAsset': assetDeleteAssetCommand,
    'shader.replaceData': shaderReplaceDataCommand,
    'shader.applyCompiledOutputs': shaderApplyCompiledOutputsCommand,
    'material.replaceData': materialReplaceDataCommand,
    'material.setInherits': materialSetInheritsCommand,
    'variable.replaceData': variableReplaceDataCommand,
    'variable.setType': variableSetTypeCommand,
    'variable.setDefaultValue': variableSetDefaultValueCommand,
    'layout.replaceData': layoutReplaceDataCommand,
    'character.replaceData': characterReplaceDataCommand,
    'dialogue.replaceData': dialogueReplaceDataCommand,
    'room.replaceData': roomReplaceDataCommand,
    'scene.replaceData': sceneReplaceDataCommand,
    'test.replaceData': testReplaceDataCommand,
    'project.setDefaultLayout': projectSetDefaultLayoutCommand,
    'project.updateMetadata': projectUpdateMetadataCommand,
    'project.setEntrypoint': projectSetEntrypointCommand,
    'project.setStartup': projectSetStartupCommand,
    'project.setRuntimeDefaultLayout': projectSetRuntimeDefaultLayoutCommand,
    'project.setDefaultFont': projectSetDefaultFontCommand,
    'project.setTitleScreen': projectSetTitleScreenCommand,
    'project.setIcon': projectSetIconCommand,
    'project.setComfyUi': projectSetComfyUiCommand,
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
    case 'project.applyPatch': return 'Apply project patch';
    case 'project.replaceAtPath': return 'Replace project value';
    case 'project.addAtPath': return 'Add project value';
    case 'project.removeAtPath': return 'Remove project value';
    case 'entity.replaceRecord': return 'Replace entity record';
    case 'entity.createRecord': return 'Create entity record';
    case 'entity.renameId': return 'Rename entity ID';
    case 'entity.duplicateRecord': return 'Duplicate entity record';
    case 'entity.deleteRecord': return 'Delete entity record';
    case 'entity.updateMetadata': return 'Update entity metadata';
    case 'entity.setParent': return 'Set entity parent';
    case 'asset.importFiles': return 'Import assets';
    case 'asset.assignAlias': return 'Assign asset alias';
    case 'asset.removeAlias': return 'Remove asset alias';
    case 'asset.renameAlias': return 'Rename asset alias';
    case 'asset.reimportFile': return 'Reimport asset';
    case 'asset.deleteAsset': return 'Delete asset';
    case 'shader.replaceData': return 'Update shader';
    case 'shader.applyCompiledOutputs': return 'Apply shader compile outputs';
    case 'material.replaceData': return 'Update material';
    case 'material.setInherits': return 'Set material inheritance';
    case 'variable.replaceData': return 'Update variable';
    case 'variable.setType': return 'Set variable type';
    case 'variable.setDefaultValue': return 'Set variable default value';
    case 'layout.replaceData': return 'Update layout';
    case 'character.replaceData': return 'Update character';
    case 'dialogue.replaceData': return 'Update dialogue';
    case 'room.replaceData': return 'Update room';
    case 'scene.replaceData': return 'Update scene';
    case 'test.replaceData': return 'Update test';
    case 'project.setDefaultLayout': return 'Set default layout';
    case 'project.updateMetadata': return 'Update project metadata';
    case 'project.setEntrypoint': return 'Set project entrypoint';
    case 'project.setStartup': return 'Update project startup';
    case 'project.setRuntimeDefaultLayout': return 'Set project default layout';
    case 'project.setDefaultFont': return 'Set project default font';
    case 'project.setTitleScreen': return 'Update title screen settings';
    case 'project.setIcon': return 'Set project icon';
    case 'project.setComfyUi': return 'Update ComfyUI settings';
    case 'project.setTagColor': return 'Set tag color';
    case 'project.createChapter': return 'Create chapter';
    case 'project.renameChapter': return 'Rename chapter';
    case 'project.deleteChapter': return 'Delete chapter';
    case 'project.setChapterColor': return 'Set chapter color';
    case 'project.assignChapters': return 'Assign chapters';
    case 'project.setHiddenCollections': return 'Update hidden categories';
    case 'project.setExplorerOptions': return 'Update explorer options';
    default: return type;
  }
}

export type BuiltinCommandHandlerResult = CommandHandlerResult;
