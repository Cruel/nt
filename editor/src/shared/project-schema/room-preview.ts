import { z } from 'zod';
import { shaderMaterialProjectWireSchema } from './shader-material-project';
import { interactableLocationSchema } from './authoring-interactables';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const safeProjectLogicalPath = z
  .string()
  .startsWith('project:/')
  .refine(
    (value) =>
      value.length > 'project:/'.length &&
      !value.includes('\\') &&
      value
        .slice('project:/'.length)
        .split('/')
        .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    'Expected a safe project:/ logical path.',
  );
const scalar = z.union([z.null(), z.boolean(), z.number().finite(), z.string()]);
const vector2 = strict({ x: z.number().finite(), y: z.number().finite() });
const normalizedRect = strict({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
});
const ownerKind = z.enum([
  'room',
  'scene',
  'dialogue',
  'character',
  'interactable',
  'verb',
  'interaction',
  'map',
]);
const definitionCollection = z.enum([
  'rooms',
  'scenes',
  'dialogues',
  'characters',
  'interactables',
  'verbs',
  'interactions',
  'maps',
]);

const scaleRange = strict({
  enabled: z.boolean(),
  minimum: z.number().finite(),
  maximum: z.number().finite(),
});
export const focusedRoomPreviewEnvironmentSchema = strict({
  profile: strict({
    name: z.string(),
    nativeResolution: strict({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
  }),
  project: strict({
    referenceResolution: strict({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    worldRasterPolicy: z.enum(['capped', 'native']),
    barColor: z.string(),
    accessibility: strict({ uiScale: scaleRange, textScale: scaleRange }),
  }),
});

export const focusedRoomIdentityAndVisitSchema = strict({
  roomId: z.string().min(1),
  recordLabel: z.string(),
  displayName: z.string(),
  visit: strict({ visitIndex: z.literal(1), sourceRoomId: z.null(), entryExitId: z.null() }),
});

const propertyIdentity = strict({
  ownerKind,
  ownerId: z.string().min(1),
  propertyId: z.string().min(1),
});
export const focusedLuaAdmissionSchema = strict({
  definitions: z.array(strict({ collection: definitionCollection, id: z.string().min(1) })),
  variableIds: z.array(z.string().min(1)),
  properties: z.array(propertyIdentity),
  interactableLocationIds: z.array(z.string().min(1)),
  compositionDraftCharacterIds: z.array(z.string().min(1)),
  compositionDraftInteractableIds: z.array(z.string().min(1)),
});

export const focusedRoomQueryStateSchema = strict({
  variables: z.array(
    strict({
      id: z.string().min(1),
      type: z.enum(['boolean', 'integer', 'number', 'string', 'enum']),
      value: scalar,
    }),
  ),
  properties: z.array(
    strict({
      ...propertyIdentity.shape,
      result: z.discriminatedUnion('kind', [
        strict({ kind: z.literal('value'), value: scalar }),
        strict({ kind: z.literal('missing') }),
      ]),
    }),
  ),
  definitions: z.array(
    strict({
      collection: definitionCollection,
      id: z.string().min(1),
      displayName: z.string().nullable(),
    }),
  ),
  interactableLocations: z.array(
    strict({
      interactableId: z.string().min(1),
      location: interactableLocationSchema,
    }),
  ),
});

export const focusedConditionSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('always') }),
  strict({
    kind: z.literal('variable-comparison'),
    variableId: z.string().min(1),
    operator: z.enum([
      'equal',
      'not-equal',
      'less',
      'less-equal',
      'greater',
      'greater-equal',
      'truthy',
      'falsy',
    ]),
    value: scalar.optional(),
  }),
  strict({ kind: z.literal('lua-predicate'), source: z.string() }),
]);

export const focusedTextSchema = strict({
  markup: z.enum(['plain', 'active-text']),
  source: z.discriminatedUnion('kind', [
    strict({ kind: z.literal('resolved'), text: z.string() }),
    strict({ kind: z.literal('lua-expression'), source: z.string() }),
  ]),
});

const focusedCharacterVisualSchema = strict({
  profileId: z.string().min(1),
  requestedPoseId: z.string().min(1),
  resolvedPoseId: z.string().min(1),
  expressionId: z.string().min(1),
  appearanceId: z.string().min(1).nullable(),
  idleId: z.string().min(1).nullable(),
  layers: z.array(
    strict({
      id: z.string().min(1),
      role: z.string().min(1).nullable(),
      spriteAssetId: z.string().min(1).nullable(),
      materialId: z.string().min(1).nullable(),
      offset: vector2,
      scale: z.number().finite(),
      anchor: vector2,
      visible: z.boolean(),
    }),
  ),
  idle: z
    .discriminatedUnion('kind', [
      strict({
        kind: z.enum(['bob', 'sway', 'pulse']),
        amplitude: z.number().finite(),
        periodMs: z.number().int().positive(),
        clock: z.enum(['gameplay', 'unscaled-presentation']),
      }),
    ])
    .nullable(),
});

const focusedCameraViewSchema = strict({
  center: vector2,
  zoom: z.number().finite().positive(),
  rotationDegrees: z.number().finite(),
});
const focusedWorldRectSchema = strict({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});

export const focusedRoomWorldDefinitionSchema = strict({
  presentationSpace: strict({
    size: strict({ width: z.number().finite().positive(), height: z.number().finite().positive() }),
    bounds: focusedWorldRectSchema.nullable(),
    edgePolicy: z.enum(['contain', 'overscan']),
    view: focusedCameraViewSchema,
  }),
  anchors: z.array(strict({ id: z.string().min(1), bounds: normalizedRect })),
  background: strict({
    assetId: z.string().min(1).nullable(),
    materialId: z.string().min(1).nullable(),
    fit: z.enum(['cover', 'contain', 'stretch', 'center']),
    color: z.string().nullable(),
  }),
  placements: z.array(
    strict({
      id: z.string().min(1),
      bounds: normalizedRect,
      order: z.number().int(),
      label: focusedTextSchema.nullable(),
      layoutId: z.string().min(1).nullable(),
    }),
  ),
  persistentCharacters: z.array(
    strict({
      characterId: z.string().min(1),
      placementId: z.string().min(1),
      enabled: z.boolean(),
      visible: z.boolean(),
      order: z.literal(0),
      visual: focusedCharacterVisualSchema,
    }),
  ),
  cast: z.array(
    strict({
      entryId: z.string().min(1),
      characterId: z.string().min(1),
      condition: focusedConditionSchema,
      placementId: z.string().min(1),
      enabled: z.boolean(),
      visible: z.boolean(),
      occurrenceVisible: z.boolean(),
      order: z.number().int(),
      visual: focusedCharacterVisualSchema,
    }),
  ),
  interactables: z.array(
    strict({
      occurrenceId: z.string().min(1),
      interactableId: z.string().min(1),
      condition: focusedConditionSchema,
      placementId: z.string().min(1),
      spriteAssetId: z.string().min(1).nullable(),
      materialId: z.string().min(1).nullable(),
      enabled: z.boolean(),
      visible: z.boolean(),
      occurrenceVisible: z.boolean(),
      order: z.number().int(),
    }),
  ),
  props: z.array(
    strict({
      propId: z.string().min(1),
      condition: focusedConditionSchema,
      placementId: z.string().min(1),
      assetId: z.string().min(1).nullable(),
      materialId: z.string().min(1).nullable(),
      visible: z.boolean(),
      order: z.number().int(),
    }),
  ),
  environments: z.array(
    strict({
      environmentId: z.string().min(1),
      condition: focusedConditionSchema,
      assetId: z.string().min(1).nullable(),
      materialId: z.string().min(1),
      bounds: normalizedRect,
      plane: z.enum(['world-background', 'world-content', 'world-overlay']),
      order: z.number().int(),
      clock: z.enum(['gameplay', 'unscaled-presentation']),
      scrollPerSecond: vector2,
      opacity: z.number().finite(),
      visible: z.boolean(),
    }),
  ),
  overlays: z.array(
    strict({
      overlayId: z.string().min(1),
      condition: focusedConditionSchema,
      layoutId: z.string().min(1),
      visible: z.boolean(),
      order: z.number().int(),
    }),
  ),
});

export const focusedLayoutSourceComponentSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('inline'), text: z.string() }),
  strict({ kind: z.literal('asset'), logicalPath: safeProjectLogicalPath }),
]);

export const focusedRoomLayoutDefinitionSchema = strict({
  instanceId: z.string().min(1),
  layoutId: z.string().min(1).nullable(),
  mount: z.discriminatedUnion('kind', [
    strict({ kind: z.literal('game-hud') }),
    strict({
      kind: z.literal('room-overlay'),
      overlayId: z.string().min(1),
      order: z.number().int(),
      visible: z.boolean(),
    }),
  ]),
  source: z.discriminatedUnion('kind', [
    strict({ kind: z.literal('builtin-game-hud') }),
    strict({
      kind: z.literal('authored'),
      layoutKind: z.enum(['document', 'fragment']),
      templateId: z.literal('layout-fragment-host-v1').nullable(),
      sourceUrl: safeProjectLogicalPath,
      defaultParent: z.string().nullable(),
      scopedStyles: z.boolean(),
      scriptNamespace: z.string().nullable(),
      rml: focusedLayoutSourceComponentSchema,
      rcss: focusedLayoutSourceComponentSchema,
      lua: focusedLayoutSourceComponentSchema,
    }),
  ]),
  scriptEnabled: z.boolean(),
  containsDedicatedLuaSource: z.boolean(),
  containsExecutableRmlLua: z.boolean(),
  scalePolicy: strict({ ui: z.enum(['inherit', 'ignore']), text: z.enum(['inherit', 'ignore']) }),
});

export const focusedRoomUiDefinitionSchema = strict({
  description: focusedTextSchema,
  exits: z.array(
    strict({
      exitId: z.string().min(1),
      label: z.string().min(1),
      direction: z.enum([
        'northwest',
        'north',
        'northeast',
        'west',
        'east',
        'southwest',
        'south',
        'southeast',
        'custom',
      ]),
      targetRoomId: z.string().min(1),
      condition: focusedConditionSchema,
    }),
  ),
});

export const focusedRoomCompositionDefinitionSchema = strict({
  moduleId: z.string().min(1),
  exportName: z.string().min(1),
  source: focusedLayoutSourceComponentSchema,
});

export const focusedShaderMaterialProjectSchema = shaderMaterialProjectWireSchema;

export const roomPreviewDocumentSchema = strict({
  schema: z.literal('noveltea.room-preview'),
  environment: focusedRoomPreviewEnvironmentSchema,
  room: focusedRoomIdentityAndVisitSchema,
  luaAdmission: focusedLuaAdmissionSchema,
  queryState: focusedRoomQueryStateSchema,
  shaderMaterials: focusedShaderMaterialProjectSchema,
  world: focusedRoomWorldDefinitionSchema,
  layouts: z.array(focusedRoomLayoutDefinitionSchema),
  ui: focusedRoomUiDefinitionSchema,
  composition: focusedRoomCompositionDefinitionSchema.nullable(),
}).superRefine((document, context) => {
  const issue = (path: (string | number)[], message: string) =>
    context.addIssue({ code: 'custom', path, message });
  const uniqueIds = <T>(
    values: readonly T[],
    identity: (value: T) => string,
    path: (string | number)[],
  ): Set<string> => {
    const result = new Set<string>();
    values.forEach((value, index) => {
      const id = identity(value);
      if (result.has(id)) issue([...path, index], `Duplicate identity '${id}'.`);
      result.add(id);
    });
    return result;
  };
  const canonicalKeys = <T>(
    values: readonly T[],
    identity: (value: T) => string,
    path: (string | number)[],
  ): string[] => {
    const keys = values.map(identity);
    const canonical = [...new Set(keys)].sort((left, right) => left.localeCompare(right));
    if (JSON.stringify(keys) !== JSON.stringify(canonical))
      issue(path, 'Set-valued array must be sorted and unique by typed identity.');
    return keys;
  };
  const definitionKey = (value: { collection: string; id: string }) =>
    `${value.collection}\u0000${value.id}`;
  const propertyKey = (value: { ownerKind: string; ownerId: string; propertyId: string }) =>
    `${value.ownerKind}\u0000${value.ownerId}\u0000${value.propertyId}`;

  const admissionDefinitionKeys = canonicalKeys(document.luaAdmission.definitions, definitionKey, [
    'luaAdmission',
    'definitions',
  ]);
  const admissionVariableIds = canonicalKeys(document.luaAdmission.variableIds, (value) => value, [
    'luaAdmission',
    'variableIds',
  ]);
  const admissionPropertyKeys = canonicalKeys(document.luaAdmission.properties, propertyKey, [
    'luaAdmission',
    'properties',
  ]);
  const admissionLocationIds = canonicalKeys(
    document.luaAdmission.interactableLocationIds,
    (value) => value,
    ['luaAdmission', 'interactableLocationIds'],
  );
  canonicalKeys(document.luaAdmission.compositionDraftCharacterIds, (value) => value, [
    'luaAdmission',
    'compositionDraftCharacterIds',
  ]);
  canonicalKeys(document.luaAdmission.compositionDraftInteractableIds, (value) => value, [
    'luaAdmission',
    'compositionDraftInteractableIds',
  ]);
  const queryVariableIds = canonicalKeys(document.queryState.variables, (value) => value.id, [
    'queryState',
    'variables',
  ]);
  const queryPropertyKeys = canonicalKeys(document.queryState.properties, propertyKey, [
    'queryState',
    'properties',
  ]);
  const queryDefinitionKeys = canonicalKeys(document.queryState.definitions, definitionKey, [
    'queryState',
    'definitions',
  ]);
  const queryLocationIds = canonicalKeys(
    document.queryState.interactableLocations,
    (value) => value.interactableId,
    ['queryState', 'interactableLocations'],
  );
  canonicalKeys(document.layouts, (value) => value.instanceId, ['layouts']);

  const structuredConditionVariableIds = new Set<string>();
  const collectCondition = (condition: z.infer<typeof focusedConditionSchema>) => {
    if (condition.kind === 'variable-comparison')
      structuredConditionVariableIds.add(condition.variableId);
  };
  document.world.overlays.forEach((value) => collectCondition(value.condition));
  document.world.cast.forEach((value) => collectCondition(value.condition));
  document.world.interactables.forEach((value) => collectCondition(value.condition));
  document.world.props.forEach((value) => collectCondition(value.condition));
  document.world.environments.forEach((value) => collectCondition(value.condition));
  document.ui.exits.forEach((value) => collectCondition(value.condition));
  const expectedQueryVariables = [
    ...new Set([...admissionVariableIds, ...structuredConditionVariableIds]),
  ].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(queryVariableIds) !== JSON.stringify(expectedQueryVariables))
    issue(
      ['queryState', 'variables'],
      'Query Variable state must equal Lua admission plus structured-condition Variables.',
    );
  if (JSON.stringify(queryPropertyKeys) !== JSON.stringify(admissionPropertyKeys))
    issue(['queryState', 'properties'], 'Query Property state must exactly match Lua admission.');
  if (JSON.stringify(queryDefinitionKeys) !== JSON.stringify(admissionDefinitionKeys))
    issue(
      ['queryState', 'definitions'],
      'Query Definition state must exactly match Lua admission.',
    );
  if (JSON.stringify(queryLocationIds) !== JSON.stringify(admissionLocationIds))
    issue(
      ['queryState', 'interactableLocations'],
      'Interactable location state must exactly match Lua admission.',
    );

  const admittedCharacters = new Set(
    document.luaAdmission.definitions
      .filter((value) => value.collection === 'characters')
      .map((value) => value.id),
  );
  const admittedInteractables = new Set(
    document.luaAdmission.definitions
      .filter((value) => value.collection === 'interactables')
      .map((value) => value.id),
  );
  document.luaAdmission.compositionDraftCharacterIds.forEach((id, index) => {
    if (!admittedCharacters.has(id))
      issue(
        ['luaAdmission', 'compositionDraftCharacterIds', index],
        'Composition Character mutation requires matching read admission.',
      );
  });
  document.luaAdmission.compositionDraftInteractableIds.forEach((id, index) => {
    if (!admittedInteractables.has(id))
      issue(
        ['luaAdmission', 'compositionDraftInteractableIds', index],
        'Composition Interactable mutation requires matching read admission.',
      );
  });

  const placements = uniqueIds(document.world.placements, (value) => value.id, [
    'world',
    'placements',
  ]);
  uniqueIds(document.world.persistentCharacters, (value) => value.characterId, [
    'world',
    'persistentCharacters',
  ]);
  uniqueIds(document.world.cast, (value) => value.entryId, ['world', 'cast']);
  uniqueIds(document.world.interactables, (value) => value.occurrenceId, [
    'world',
    'interactables',
  ]);
  uniqueIds(document.world.props, (value) => value.propId, ['world', 'props']);
  uniqueIds(document.world.environments, (value) => value.environmentId, ['world', 'environments']);
  const overlayIds = uniqueIds(document.world.overlays, (value) => value.overlayId, [
    'world',
    'overlays',
  ]);
  uniqueIds(document.ui.exits, (value) => value.exitId, ['ui', 'exits']);
  canonicalKeys(document.world.persistentCharacters, (value) => value.characterId, [
    'world',
    'persistentCharacters',
  ]);
  canonicalKeys(document.world.interactables, (value) => value.occurrenceId, [
    'world',
    'interactables',
  ]);
  document.world.persistentCharacters.forEach((value, index) => {
    if (!placements.has(value.placementId))
      issue(
        ['world', 'persistentCharacters', index, 'placementId'],
        'Referenced Room placement does not exist.',
      );
  });
  document.world.cast.forEach((value, index) => {
    if (!placements.has(value.placementId))
      issue(['world', 'cast', index, 'placementId'], 'Referenced Room placement does not exist.');
  });
  document.world.interactables.forEach((value, index) => {
    if (!placements.has(value.placementId))
      issue(
        ['world', 'interactables', index, 'placementId'],
        'Referenced Room placement does not exist.',
      );
  });
  document.world.props.forEach((value, index) => {
    if (!placements.has(value.placementId))
      issue(['world', 'props', index, 'placementId'], 'Referenced Room placement does not exist.');
  });
  const overlayLayouts = new Map<string, number>();
  let gameHudCount = 0;
  document.layouts.forEach((layout, index) => {
    if (layout.mount.kind === 'game-hud') {
      gameHudCount += 1;
      if (layout.instanceId !== 'game-hud')
        issue(['layouts', index, 'instanceId'], "Game HUD instanceId must be 'game-hud'.");
      if (layout.source.kind === 'builtin-game-hud' && layout.layoutId !== null)
        issue(['layouts', index, 'layoutId'], 'Built-in Game HUD must have null layoutId.');
    } else {
      const overlayId = layout.mount.overlayId;
      const overlay = document.world.overlays.find(
        (candidate) => candidate.overlayId === overlayId,
      );
      overlayLayouts.set(overlayId, (overlayLayouts.get(overlayId) ?? 0) + 1);
      if (layout.instanceId !== `room-overlay:${overlayId}`)
        issue(['layouts', index, 'instanceId'], 'Room overlay instanceId is not canonical.');
      if (!overlay)
        issue(
          ['layouts', index, 'mount', 'overlayId'],
          'Layout mount references an unknown overlay.',
        );
      else {
        if (layout.layoutId !== overlay.layoutId)
          issue(['layouts', index, 'layoutId'], 'Layout identity does not match its overlay.');
        if (layout.mount.order !== overlay.order || layout.mount.visible !== overlay.visible)
          issue(
            ['layouts', index, 'mount'],
            'Layout mount does not match overlay order/visibility.',
          );
      }
    }
    if (layout.source.kind === 'builtin-game-hud') {
      if (
        layout.mount.kind !== 'game-hud' ||
        layout.scriptEnabled ||
        layout.containsDedicatedLuaSource ||
        layout.containsExecutableRmlLua
      )
        issue(['layouts', index], 'Built-in Game HUD carries invalid authored Layout state.');
      return;
    }
    if (layout.layoutId === null)
      issue(['layouts', index, 'layoutId'], 'Authored Layout requires a layoutId.');
    if (
      (layout.source.layoutKind === 'fragment') !==
      (layout.source.templateId === 'layout-fragment-host-v1')
    )
      issue(['layouts', index, 'source', 'templateId'], 'Layout templateId does not match kind.');
    if (layout.source.rml.kind === 'asset') {
      if (layout.source.sourceUrl !== layout.source.rml.logicalPath)
        issue(
          ['layouts', index, 'source', 'sourceUrl'],
          'Asset-backed Layout sourceUrl must equal the RML logical path.',
        );
    } else if (layout.layoutId !== null) {
      const expected = `project:/__noveltea_inline_layout_${layout.layoutId.replace(/[^A-Za-z0-9_-]/g, '_')}.rml`;
      if (layout.source.sourceUrl !== expected)
        issue(
          ['layouts', index, 'source', 'sourceUrl'],
          'Inline Layout sourceUrl is not canonical.',
        );
    }
    const expectedDedicated =
      layout.source.lua.kind === 'asset' ||
      new TextEncoder().encode(layout.source.lua.text.replace(/^\uFEFF/, '')).byteLength > 0;
    if (layout.containsDedicatedLuaSource !== expectedDedicated)
      issue(
        ['layouts', index, 'containsDedicatedLuaSource'],
        'Dedicated Lua presence flag does not match source bytes.',
      );
  });
  if (gameHudCount !== 1) issue(['layouts'], 'Focused Room requires exactly one Game HUD Layout.');
  for (const overlayId of overlayIds)
    if (overlayLayouts.get(overlayId) !== 1)
      issue(
        ['world', 'overlays'],
        `Overlay '${overlayId}' requires exactly one Layout definition.`,
      );

  const shaderIds = new Set(Object.keys(document.shaderMaterials.shaders));
  const materialIds = new Set(Object.keys(document.shaderMaterials.materials));
  for (const [materialId, material] of Object.entries(document.shaderMaterials.materials))
    if (!shaderIds.has(material.shader))
      issue(
        ['shaderMaterials', 'materials', materialId, 'shader'],
        `Material references missing Shader '${material.shader}'.`,
      );
  const checkMaterial = (materialId: string | null, path: (string | number)[]) => {
    if (materialId !== null && !materialIds.has(materialId))
      issue(path, `Referenced Material '${materialId}' is absent from shaderMaterials.`);
  };
  checkMaterial(document.world.background.materialId, ['world', 'background', 'materialId']);
  document.world.persistentCharacters.forEach((value, index) => {
    value.visual.layers.forEach((layer, layerIndex) =>
      checkMaterial(layer.materialId, [
        'world',
        'persistentCharacters',
        index,
        'visual',
        'layers',
        layerIndex,
        'materialId',
      ]),
    );
  });
  document.world.cast.forEach((value, index) => {
    value.visual.layers.forEach((layer, layerIndex) =>
      checkMaterial(layer.materialId, [
        'world',
        'cast',
        index,
        'visual',
        'layers',
        layerIndex,
        'materialId',
      ]),
    );
  });
  document.world.interactables.forEach((value, index) =>
    checkMaterial(value.materialId, ['world', 'interactables', index, 'materialId']),
  );
  document.world.props.forEach((value, index) =>
    checkMaterial(value.materialId, ['world', 'props', index, 'materialId']),
  );
  document.world.environments.forEach((value, index) =>
    checkMaterial(value.materialId, ['world', 'environments', index, 'materialId']),
  );
});

export type RoomPreviewDocument = z.infer<typeof roomPreviewDocumentSchema>;
