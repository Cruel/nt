import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import { imageSamplingValues } from './authoring-assets';
import { MAX_REFERENCE_RESOLUTION_DIMENSION } from './project-display-contract';

/**
 * The sole gameplay JSON contract for the native decoder. This is
 * deliberately independent of the editable AuthoringProject shape.
 */
export const COMPILED_PROJECT_SCHEMA = 'noveltea.compiled.project' as const;
export const COMPILED_PROJECT_FORMAT_VERSION = 1 as const;
export const COMPILED_PROJECT_SAVE_CONTRACT_PATTERN = /^sc1:[0-9a-f]{32}$/u;

const strict = <Shape extends z.ZodRawShape>(shape: Shape) => z.object(shape).strict();
const id = entityIdSchema;
const finiteNumber = z.number().finite();
const positiveFiniteNumber = finiteNumber.positive();
const runtimeValueSchema = z.union([z.null(), z.boolean(), finiteNumber, z.string()]);

const typedReference = <Collection extends string>(collection: Collection) =>
  strict({
    id,
    kind: z.literal(collection),
  });

const assetReferenceSchema = typedReference('asset');
const archetypeReferenceSchema = typedReference('archetype');
const characterReferenceSchema = typedReference('character');
const dialogueReferenceSchema = typedReference('dialogue');
const interactableDefinitionReferenceSchema = typedReference('interactable-definition');
const interactableReferenceSchema = typedReference('interactable');
const itemDefinitionReferenceSchema = typedReference('item-definition');
const itemStackReferenceSchema = typedReference('item-stack');
const layoutReferenceSchema = typedReference('layout');
const materialReferenceSchema = typedReference('material');
const compiledMaterialRoleSchema = z.enum([
  'engine-2d',
  'active-text',
  'rmlui-decorator',
  'rmlui-filter',
  'postprocess',
  'hotspot-overlay',
]);
const compiledMaterialParameterTypeSchema = z.enum([
  'float',
  'vec2',
  'vec3',
  'vec4',
  'color',
  'int',
  'bool',
]);
const compiledMaterialParameterValueSchema = z.discriminatedUnion('type', [
  strict({ type: z.literal('float'), value: z.number().finite() }),
  strict({
    type: z.literal('vec2'),
    value: z.tuple([z.number().finite(), z.number().finite()]),
  }),
  strict({
    type: z.literal('vec3'),
    value: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  }),
  strict({
    type: z.literal('vec4'),
    value: z.tuple([
      z.number().finite(),
      z.number().finite(),
      z.number().finite(),
      z.number().finite(),
    ]),
  }),
  strict({
    type: z.literal('color'),
    value: strict({
      r: z.number().finite(),
      g: z.number().finite(),
      b: z.number().finite(),
      a: z.number().finite(),
    }),
  }),
  strict({ type: z.literal('int'), value: z.number().int() }),
  strict({ type: z.literal('bool'), value: z.boolean() }),
]);
const compiledMaterialParameterSchema = strict({
  name: z.string().min(1),
  type: compiledMaterialParameterTypeSchema,
  rendererBinding: z.string().min(1).nullable(),
});
const compiledMaterialInterfaceSchema = strict({
  id,
  role: compiledMaterialRoleSchema,
  postprocessScope: z.enum(['world', 'full-game-viewport']),
  parameters: z.array(compiledMaterialParameterSchema),
});
const roomReferenceSchema = typedReference('room');
const sceneReferenceSchema = typedReference('scene');
const scriptReferenceSchema = typedReference('script');
const propertyReferenceSchema = typedReference('property');
const traitReferenceSchema = typedReference('trait');
const verbReferenceSchema = typedReference('verb');
const featureReferenceSchema = z.discriminatedUnion('ownerKind', [
  strict({ ownerKind: z.literal('room'), room: roomReferenceSchema, featureId: id }),
  strict({
    ownerKind: z.literal('interactable'),
    interactable: interactableReferenceSchema,
    featureId: id,
  }),
]);
export const compiledInteractionSubjectSchema = z.discriminatedUnion('kind', [
  strict({ character: characterReferenceSchema, kind: z.literal('character') }),
  strict({ interactable: interactableReferenceSchema, kind: z.literal('interactable') }),
  strict({ feature: featureReferenceSchema, kind: z.literal('feature') }),
  strict({ itemStack: itemStackReferenceSchema, kind: z.literal('item-stack') }),
]);

export const compiledTextSourceSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('inline'), text: z.string() }),
  strict({ kind: z.literal('localized'), key: z.string().min(1) }),
  strict({ kind: z.literal('lua-expression'), source: z.string().min(1) }),
]);

export const compiledTextSchema = strict({
  markup: z.enum(['plain', 'active-text']),
  source: compiledTextSourceSchema,
});

export const compiledConditionSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('always') }),
  strict({
    kind: z.literal('global-property-comparison'),
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
    value: runtimeValueSchema.optional(),
    property: propertyReferenceSchema,
  }),
  strict({ kind: z.literal('lua-predicate'), source: z.string().min(1) }),
]);

export const compiledEffectSchema = z.discriminatedUnion('kind', [
  strict({
    kind: z.literal('set-global-property'),
    property: propertyReferenceSchema,
    value: runtimeValueSchema,
  }),
  strict({ kind: z.literal('run-lua-effect'), source: z.string().min(1) }),
]);

export const compiledFlowTargetSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('scene'), scene: sceneReferenceSchema }),
  strict({ kind: z.literal('dialogue'), dialogue: dialogueReferenceSchema }),
  strict({ kind: z.literal('room'), room: roomReferenceSchema }),
  strict({ kind: z.literal('return') }),
  strict({ kind: z.literal('end') }),
]);

const compiledEntrypointSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('scene'), scene: sceneReferenceSchema }),
  strict({ kind: z.literal('dialogue'), dialogue: dialogueReferenceSchema }),
  strict({ kind: z.literal('room'), room: roomReferenceSchema }),
]);

const propertyAssignmentSchema = strict({ propertyId: id, value: runtimeValueSchema });
const ownerPropertyContractSchema = strict({
  id,
  label: z.string().min(1),
  description: z.string(),
  type: z.enum(['boolean', 'integer', 'number', 'string', 'enum']),
  nullable: z.boolean(),
  enumValues: z.array(z.string().min(1)),
  defaultValue: runtimeValueSchema.optional(),
});
const instanceLocalPropertySchema = strict({
  ...ownerPropertyContractSchema.shape,
  value: runtimeValueSchema,
});
const propertyBearingDefinition = {
  id,
  traits: z.array(id),
  propertyAssignments: z.array(propertyAssignmentSchema),
};

const propertyOwnerKindSchema = z.enum(['room', 'character', 'interactable', 'feature']);
const exactPropertyOwnerSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('room'), room: roomReferenceSchema }),
  strict({ kind: z.literal('character'), character: characterReferenceSchema }),
  strict({ kind: z.literal('interactable'), interactable: interactableReferenceSchema }),
]);

const inventoryDefinitionSchema = strict({ id, label: z.string().min(1) });
const inventoryOwnerSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('project') }),
  strict({ kind: z.literal('character'), character: characterReferenceSchema }),
  strict({ kind: z.literal('interactable'), interactable: interactableReferenceSchema }),
  strict({ kind: z.literal('room-feature'), room: roomReferenceSchema, featureId: id }),
  strict({
    kind: z.literal('interactable-feature'),
    interactable: interactableReferenceSchema,
    featureId: id,
  }),
]);
const inventoryReferenceSchema = strict({ owner: inventoryOwnerSchema, inventoryId: id });

const featureDefinitionSchema = strict({
  ...propertyBearingDefinition,
  properties: z.array(ownerPropertyContractSchema),
  label: z.string().min(1),
  inventories: z.array(inventoryDefinitionSchema),
});

const traitPropertySchema = strict({
  id,
  label: z.string().min(1),
  description: z.string(),
  type: z.enum(['boolean', 'integer', 'number', 'string', 'enum']),
  nullable: z.boolean(),
  enumValues: z.array(z.string().min(1)),
  defaultValue: runtimeValueSchema.optional(),
});
const traitDefinitionSchema = strict({
  description: z.string(),
  id,
  label: z.string().min(1),
  ownerKinds: z.array(propertyOwnerKindSchema).min(1),
  properties: z.array(traitPropertySchema),
});

const propertyDefinitionCommon = {
  description: z.string(),
  enumValues: z.array(z.string().min(1)),
  id,
  label: z.string().min(1),
  nullable: z.boolean(),
  type: z.enum(['boolean', 'integer', 'number', 'string', 'enum']),
};

const propertyDefinitionSchema = z.union([
  strict({
    ...propertyDefinitionCommon,
    defaultValue: runtimeValueSchema,
    scope: z.literal('global'),
  }),
  strict({
    ...propertyDefinitionCommon,
    owner: exactPropertyOwnerSchema,
    scope: z.literal('identity'),
  }),
]);

const vector2Schema = strict({ x: finiteNumber, y: finiteNumber });
const normalizedRectSchema = strict({
  height: finiteNumber.positive().max(1),
  width: finiteNumber.positive().max(1),
  x: finiteNumber.min(0).max(1),
  y: finiteNumber.min(0).max(1),
}).superRefine((bounds, context) => {
  if (bounds.x + bounds.width > 1)
    context.addIssue({
      code: 'custom',
      path: ['width'],
      message: 'Rectangle exceeds image width.',
    });
  if (bounds.y + bounds.height > 1)
    context.addIssue({
      code: 'custom',
      path: ['height'],
      message: 'Rectangle exceeds image height.',
    });
});
const layoutScaleInheritanceSchema = z.enum(['inherit', 'ignore']);
const layoutScalePolicySchema = strict({
  ui: layoutScaleInheritanceSchema,
  text: layoutScaleInheritanceSchema,
});
const layoutScaleOverridesSchema = strict({
  ui: layoutScaleInheritanceSchema.optional(),
  text: layoutScaleInheritanceSchema.optional(),
});
const hotspotHighlightSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('default') }),
  strict({ kind: z.literal('material'), material: materialReferenceSchema }),
  strict({ kind: z.literal('none') }),
]);
const roomHotspotTargetSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('owner-feature'), featureId: id }),
  strict({ kind: z.literal('subject'), subject: compiledInteractionSubjectSchema }),
  strict({ kind: z.literal('exit'), exitId: id }),
]);
const interactableHotspotTargetSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('owner') }),
  strict({ kind: z.literal('owner-feature'), featureId: id }),
  strict({ kind: z.literal('subject'), subject: compiledInteractionSubjectSchema }),
]);
const hotspotCommonShape = {
  id,
  label: z.string().min(1),
  condition: compiledConditionSchema,
  inputOrder: z.number().int(),
  highlight: hotspotHighlightSchema,
};
const roomHotspotRefSchema = strict({
  kind: z.literal('room-hotspot'),
  room: roomReferenceSchema,
  hotspotId: id,
});
const interactableHotspotRefSchema = strict({
  kind: z.literal('interactable-hotspot'),
  interactable: interactableReferenceSchema,
  hotspotId: id,
});
export const compiledHotspotRefSchema = z.discriminatedUnion('kind', [
  roomHotspotRefSchema,
  interactableHotspotRefSchema,
]);

const characterPresentationLayerSchema = strict({
  id,
  role: z.string().nullable(),
});
const characterLayerCompositionSchema = strict({
  layerId: id,
  material: materialReferenceSchema.nullable(),
  offset: vector2Schema,
  scale: finiteNumber.positive(),
  sprite: assetReferenceSchema.nullable(),
  anchor: vector2Schema,
  visible: z.boolean(),
});
const characterPoseSchema = strict({
  id,
  layers: z.array(characterLayerCompositionSchema),
});
const characterAnimationLayerFrameSchema = strict({
  layerId: id,
  material: materialReferenceSchema.nullable().optional(),
  sprite: assetReferenceSchema.nullable().optional(),
  offset: vector2Schema.optional(),
  scale: finiteNumber.positive().optional(),
  anchor: vector2Schema.optional(),
  visible: z.boolean().optional(),
});
const characterAnimationClipSchema = strict({
  id,
  clock: z.enum(['gameplay', 'unscaled-presentation']),
  frames: z
    .array(
      strict({
        durationMs: z.number().int().positive(),
        layers: z.array(characterAnimationLayerFrameSchema),
      }),
    )
    .min(1),
});
const characterPresentationProfileSchema = strict({
  id,
  layers: z.array(characterPresentationLayerSchema),
  defaultPoseId: id,
  poses: z.array(characterPoseSchema),
  animationClips: z.array(characterAnimationClipSchema).optional(),
  automaticAnimations: strict({
    blink: strict({
      clipId: id,
      role: z.string().min(1),
      intervalMs: z.number().int().positive(),
    }).nullable(),
    speaking: strict({ clipId: id, role: z.string().min(1) }).nullable(),
  }).optional(),
});
const characterLayerOverrideSchema = strict({
  layerId: id,
  material: materialReferenceSchema.nullable().optional(),
  sprite: assetReferenceSchema.nullable().optional(),
  visible: z.boolean().optional(),
});
const characterProfileLayerOverridesSchema = strict({
  profileId: id,
  layers: z.array(characterLayerOverrideSchema),
});

const characterExpressionSchema = strict({
  id,
  profiles: z.array(characterProfileLayerOverridesSchema),
});
const characterAppearanceSchema = strict({
  id,
  profiles: z.array(characterProfileLayerOverridesSchema),
});
const characterIdleSchema = strict({
  id,
  kind: z.enum(['bob', 'sway', 'pulse']),
  amplitude: finiteNumber.nonnegative(),
  periodMs: z.number().int().positive(),
  clock: z.enum(['gameplay', 'unscaled-presentation']),
});
const characterGestureCueSchema = z.discriminatedUnion('kind', [
  strict({
    kind: z.literal('presentation'),
    id,
    atMs: z.number().int().nonnegative(),
    event: id,
  }),
  strict({
    kind: z.literal('audio'),
    id,
    atMs: z.number().int().nonnegative(),
    asset: assetReferenceSchema,
    gain: finiteNumber.min(0).max(1),
    pan: finiteNumber.min(-1).max(1),
  }),
]);
const characterGestureSchema = strict({
  id,
  profiles: z.array(
    strict({
      profileId: id,
      clipId: id,
      cues: z.array(characterGestureCueSchema),
    }),
  ),
});

const characterDefinitionSchema = strict({
  ...propertyBearingDefinition,
  properties: z.array(ownerPropertyContractSchema),
  defaults: strict({
    profileId: id,
    expressionId: id,
    appearanceId: id.nullable(),
    idleId: id.nullable().optional(),
  }),
  dialogue: strict({
    name: z.string(),
    nameColor: z.string().nullable(),
    styleClass: z.string(),
    textColor: z.string().nullable(),
  }),
  displayName: z.string(),
  expressions: z.array(characterExpressionSchema),
  appearances: z.array(characterAppearanceSchema),
  gestures: z.array(characterGestureSchema).optional(),
  idles: z.array(characterIdleSchema).optional(),
  profiles: z.array(characterPresentationProfileSchema),
  inventories: z.array(inventoryDefinitionSchema),
  initialWorldState: strict({
    enabled: z.boolean(),
    visible: z.boolean(),
    location: z.discriminatedUnion('kind', [
      strict({ kind: z.literal('unplaced') }),
      strict({ kind: z.literal('room'), room: roomReferenceSchema }),
    ]),
  }),
});

const roomPlacementSchema = strict({
  bounds: normalizedRectSchema,
  id,
  order: z.number().int(),
  presentation: strict({
    label: compiledTextSchema.nullable(),
    layout: layoutReferenceSchema.nullable(),
  }),
});
const worldRectSchema = strict({
  x: finiteNumber,
  y: finiteNumber,
  width: positiveFiniteNumber,
  height: positiveFiniteNumber,
});
export const compiledCameraViewSchema = strict({
  center: vector2Schema,
  zoom: positiveFiniteNumber,
  rotationDegrees: finiteNumber,
});
const roomPresentationSpaceSchema = strict({
  size: strict({ width: positiveFiniteNumber, height: positiveFiniteNumber }),
  bounds: worldRectSchema.nullable(),
  edgePolicy: z.enum(['contain', 'overscan']),
  defaultView: compiledCameraViewSchema,
  views: z.array(strict({ id, view: compiledCameraViewSchema })),
});
const roomAnchorSchema = strict({
  id,
  bounds: normalizedRectSchema,
});
const roomNavigationTransitionSchema = strict({
  kind: z.enum(['cut', 'fade', 'dissolve']),
  durationMs: z.number().int().nonnegative(),
  color: z.string().nullable(),
  skippable: z.boolean(),
});
const roomExitSchema = strict({
  condition: compiledConditionSchema,
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
  id,
  label: compiledTextSchema,
  target: roomReferenceSchema,
  transition: roomNavigationTransitionSchema.nullable(),
});
const roomScriptHookMappingSchema = strict({
  hook: z.enum([
    'can-enter',
    'can-leave',
    'reject-enter',
    'reject-leave',
    'before-enter',
    'after-enter',
    'before-leave',
    'after-leave',
    'compose',
  ]),
  handler: strict({
    module: scriptReferenceSchema,
    export: z.string().check(z.trim(), z.minLength(1)),
  }),
});
const roomDefinitionSchema = strict({
  ...propertyBearingDefinition,
  properties: z.array(ownerPropertyContractSchema),
  background: strict({
    asset: assetReferenceSchema.nullable(),
    color: z.string().nullable(),
    fit: z.enum(['cover', 'contain', 'stretch', 'center']),
    material: materialReferenceSchema.nullable(),
  }),
  description: compiledTextSchema,
  displayName: z.string(),
  presentationSpace: roomPresentationSpaceSchema,
  anchors: z.array(roomAnchorSchema),
  exits: z.array(roomExitSchema),
  lifecycle: strict({
    canEnter: compiledConditionSchema,
    canLeave: compiledConditionSchema,
  }),
  overlays: z.array(
    strict({
      condition: compiledConditionSchema,
      id,
      layout: layoutReferenceSchema,
      visible: z.boolean(),
      order: z.number().int(),
    }),
  ),
  cast: z.array(
    strict({
      id,
      character: characterReferenceSchema,
      condition: compiledConditionSchema,
      placementId: id,
      profileId: id.nullable(),
      poseId: id.nullable(),
      expressionId: id.nullable(),
      appearanceId: id.nullable(),
      idleId: id.nullable().optional(),
      visible: z.boolean(),
      order: z.number().int(),
    }),
  ),
  props: z.array(
    strict({
      id,
      condition: compiledConditionSchema,
      placementId: id,
      asset: assetReferenceSchema.nullable(),
      material: materialReferenceSchema.nullable(),
      visible: z.boolean(),
      order: z.number().int(),
    }),
  ),
  interactables: z.array(
    strict({
      id,
      interactable: interactableReferenceSchema,
      condition: compiledConditionSchema,
      placementId: id,
      visible: z.boolean(),
      order: z.number().int(),
    }),
  ),
  environments: z
    .array(
      strict({
        id,
        condition: compiledConditionSchema,
        asset: assetReferenceSchema.nullable(),
        material: materialReferenceSchema,
        bounds: normalizedRectSchema,
        plane: z.enum(['world-background', 'world-content', 'world-overlay']),
        order: z.number().int(),
        clock: z.enum(['gameplay', 'unscaled-presentation']),
        scrollPerSecond: vector2Schema,
        opacity: finiteNumber.min(0).max(1),
        visible: z.boolean(),
      }),
    )
    .optional(),
  scriptHooks: z.array(roomScriptHookMappingSchema),
  placements: z.array(roomPlacementSchema),
  features: z.array(featureDefinitionSchema),
  hotspots: z.array(
    strict({
      ...hotspotCommonShape,
      shape: strict({ kind: z.literal('rect'), bounds: normalizedRectSchema }),
      target: roomHotspotTargetSchema,
    }),
  ),
});

const interactableLocationSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('inventory'), inventory: inventoryReferenceSchema }),
  strict({ kind: z.literal('unplaced') }),
  strict({ kind: z.literal('room'), room: roomReferenceSchema }),
]);
const interactableDefinitionSchema = strict({
  ...propertyBearingDefinition,
  displayName: z.string(),
  stackable: z.boolean(),
  stackLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  properties: z.array(ownerPropertyContractSchema),
  features: z.array(featureDefinitionSchema),
  inventories: z.array(inventoryDefinitionSchema),
  presentation: strict({
    material: materialReferenceSchema.nullable(),
    sprite: assetReferenceSchema.nullable(),
    hotspots: z.discriminatedUnion('kind', [
      strict({ kind: z.literal('none') }),
      strict({
        kind: z.literal('sprite-alpha'),
        hotspot: strict({ ...hotspotCommonShape, target: interactableHotspotTargetSchema }),
      }),
      strict({
        kind: z.literal('custom'),
        hotspots: z.array(
          strict({
            ...hotspotCommonShape,
            target: interactableHotspotTargetSchema,
            shape: strict({ kind: z.literal('rect'), bounds: normalizedRectSchema }),
          }),
        ),
      }),
    ]),
  }),
});
const interactableInstanceDeclarationSchema = strict({
  id,
  definition: interactableDefinitionReferenceSchema,
  location: interactableLocationSchema,
  enabled: z.boolean(),
  visible: z.boolean(),
  quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  traitAdds: z.array(id),
  traitRemoves: z.array(id),
  propertyOverrides: z.array(propertyAssignmentSchema),
  localProperties: z.array(instanceLocalPropertySchema),
});

const archetypeDefinitionSchema = z.discriminatedUnion('instanceKind', [
  strict({
    id,
    instanceKind: z.literal('room'),
    configuration: roomDefinitionSchema.omit({ id: true }),
  }),
  strict({
    id,
    instanceKind: z.literal('character'),
    configuration: characterDefinitionSchema.omit({ id: true, initialWorldState: true }),
  }),
  strict({
    id,
    instanceKind: z.literal('interactable'),
    configuration: interactableDefinitionSchema.omit({ id: true }),
  }),
]);

const interactionMoveTargetSchema = interactableLocationSchema;
const interactionInstructionSchema = z.discriminatedUnion('kind', [
  strict({ effect: compiledEffectSchema, id, kind: z.literal('apply-effect') }),
  strict({
    id,
    interactable: interactableReferenceSchema,
    kind: z.literal('move-interactable'),
    target: interactionMoveTargetSchema,
  }),
  strict({
    id,
    kind: z.literal('set-interactable-state'),
    enabled: z.boolean().optional(),
    interactable: interactableReferenceSchema,
    visible: z.boolean().optional(),
  }),
  strict({ id, kind: z.literal('notify'), message: compiledTextSchema }),
  strict({ id, kind: z.literal('call-scene'), scene: sceneReferenceSchema }),
  strict({ dialogue: dialogueReferenceSchema, id, kind: z.literal('call-dialogue') }),
]);
export const interactionProgramSchema = strict({
  completion: compiledFlowTargetSchema,
  instructions: z.array(interactionInstructionSchema),
  outcome: z.enum(['handled', 'unhandled']),
});
const subjectFamilySchema = z.enum(['character', 'interactable', 'feature', 'item-stack']);
export const compiledSubjectSelectorSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('any-subject') }),
  strict({ kind: z.literal('family'), family: subjectFamilySchema }),
  strict({ kind: z.literal('trait'), trait: traitReferenceSchema }),
  strict({ kind: z.literal('item-definition'), itemDefinition: itemDefinitionReferenceSchema }),
  strict({
    kind: z.literal('qualified-pattern'),
    family: subjectFamilySchema,
    pattern: z.string().min(2),
  }),
  strict({ kind: z.literal('exact'), subject: compiledInteractionSubjectSchema }),
]);
const interactionSlotSelectorSchema = strict({
  slotId: id,
  selectors: z.array(compiledSubjectSelectorSchema).min(1),
});
const interactionOfferSchema = strict({
  slotId: id,
  condition: compiledConditionSchema.optional(),
  rank: z.number().int(),
  primary: z.boolean(),
});
const interactionRuleSchema = strict({
  guard: compiledConditionSchema,
  id,
  priority: z.number().int(),
  slots: z.array(interactionSlotSelectorSchema),
  offer: interactionOfferSchema.nullable(),
  program: interactionProgramSchema,
  verb: verbReferenceSchema,
});
const interactionDefinitionSchema = strict({
  id,
  rules: z.array(interactionRuleSchema),
});
const verbSlotSchema = strict({
  id,
  label: compiledTextSchema,
  prompt: compiledTextSchema,
  selectors: z.array(compiledSubjectSelectorSchema).min(1),
});
const verbOfferSchema = strict({
  id,
  slotId: id,
  selectors: z.array(compiledSubjectSelectorSchema).min(1),
  condition: compiledConditionSchema.optional(),
  rank: z.number().int(),
  primary: z.boolean(),
});
const verbDefinitionSchema = strict({
  id,
  actionText: compiledTextSchema,
  completedCommandText: compiledTextSchema,
  slots: z.array(verbSlotSchema),
  bindingOrder: z.array(id),
  offers: z.array(verbOfferSchema),
  availability: compiledConditionSchema,
  defaultProgram: interactionProgramSchema,
});

const sceneInstructionCommon = { condition: compiledConditionSchema.optional(), id };
const compiledSceneInputBindingSchema = strict({ inputId: id, value: runtimeValueSchema });
const compiledMaterialOccurrenceTargetSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('background') }),
  strict({
    kind: z.literal('actor'),
    slotId: id,
    layerId: id,
  }),
  strict({ kind: z.literal('layout'), slot: z.enum(['hud', 'dialogue-box', 'overlay', 'custom']) }),
  strict({ kind: z.literal('postprocess'), instanceId: id }),
]);
const transitionGroupChildSchema = z.discriminatedUnion('kind', [
  strict({
    asset: assetReferenceSchema.nullable(),
    color: z.string().nullable(),
    fit: z.enum(['cover', 'contain', 'stretch', 'center']),
    id,
    kind: z.literal('set-background'),
    material: materialReferenceSchema.nullable(),
  }),
  strict({ id, kind: z.literal('clear-background') }),
  strict({
    action: z.enum(['show', 'hide', 'move', 'profile', 'pose', 'expression', 'appearance']),
    character: characterReferenceSchema,
    profileId: id.nullable(),
    expressionId: id.nullable(),
    appearanceId: id.nullable(),
    id,
    kind: z.literal('actor-cue'),
    offset: vector2Schema,
    poseId: id.nullable(),
    position: z.enum(['left', 'center', 'right', 'custom']),
    scale: finiteNumber.positive(),
    slotId: id,
  }),
  strict({
    action: z.enum(['show', 'hide', 'swap']),
    id,
    kind: z.literal('set-layout'),
    layout: layoutReferenceSchema.nullable(),
    plane: z.literal('world-overlay'),
    scaleOverrides: layoutScaleOverridesSchema.optional(),
    slot: z.enum(['overlay', 'custom']),
  }),
]);
const scenePropertyOwnerSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('room'), room: roomReferenceSchema }),
  strict({ kind: z.literal('character'), character: characterReferenceSchema }),
  strict({ kind: z.literal('interactable'), interactable: interactableReferenceSchema }),
  strict({ kind: z.literal('item-stack'), itemStack: itemStackReferenceSchema }),
]);
const sceneCharacterLocationSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('unplaced') }),
  strict({ kind: z.literal('room'), room: roomReferenceSchema }),
]);
const sceneGameplayEffectOperationSchema = z.discriminatedUnion('kind', [
  strict({
    kind: z.literal('set-global-property'),
    property: propertyReferenceSchema,
    value: runtimeValueSchema,
  }),
  strict({
    kind: z.literal('set-property'),
    owner: scenePropertyOwnerSchema,
    property: propertyReferenceSchema,
    value: runtimeValueSchema,
  }),
  strict({
    kind: z.literal('unset-property'),
    owner: scenePropertyOwnerSchema,
    property: propertyReferenceSchema,
  }),
  strict({
    kind: z.literal('move-character'),
    character: characterReferenceSchema,
    location: sceneCharacterLocationSchema,
  }),
  strict({
    kind: z.literal('set-character-state'),
    character: characterReferenceSchema,
    enabled: z.boolean().optional(),
    visible: z.boolean().optional(),
  }),
  strict({
    kind: z.literal('move-interactable'),
    interactable: interactableReferenceSchema,
    location: interactableLocationSchema,
  }),
  strict({
    kind: z.literal('set-interactable-state'),
    interactable: interactableReferenceSchema,
    enabled: z.boolean().optional(),
    visible: z.boolean().optional(),
  }),
  strict({
    kind: z.literal('split-item-stack'),
    stack: itemStackReferenceSchema,
    quantity: z.number().int().positive(),
  }),
  strict({
    kind: z.literal('merge-item-stacks'),
    receiver: itemStackReferenceSchema,
    donor: itemStackReferenceSchema,
  }),
  strict({
    kind: z.literal('transfer-item-quantity'),
    stack: itemStackReferenceSchema,
    quantity: z.number().int().positive(),
    location: interactableLocationSchema,
    placement: z.enum(['coalesce', 'keep-separate']),
  }),
  strict({
    kind: z.literal('grant-item-quantity'),
    definition: itemDefinitionReferenceSchema,
    quantity: z.number().int().positive(),
    location: interactableLocationSchema,
    placement: z.enum(['coalesce', 'keep-separate']),
  }),
  strict({
    kind: z.literal('consume-item-quantity'),
    stack: itemStackReferenceSchema,
    quantity: z.number().int().positive(),
  }),
]);
const sceneGameplayInstanceRefSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('room'), room: roomReferenceSchema }),
  strict({ kind: z.literal('character'), character: characterReferenceSchema }),
  strict({ kind: z.literal('interactable'), interactable: interactableReferenceSchema }),
]);
const sceneInstanceConfigurationSourceSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('archetype'), archetype: archetypeReferenceSchema }),
  strict({ kind: z.literal('compiled-instance'), instance: sceneGameplayInstanceRefSchema }),
  strict({ kind: z.literal('effective-instance'), instance: sceneGameplayInstanceRefSchema }),
]);
const sceneRuntimeWorldOperationSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('create-room'), source: sceneInstanceConfigurationSourceSchema }),
  strict({
    kind: z.literal('create-character'),
    source: sceneInstanceConfigurationSourceSchema,
    location: sceneCharacterLocationSchema,
    enabled: z.boolean(),
    visible: z.boolean(),
  }),
  strict({
    kind: z.literal('create-interactable'),
    source: sceneInstanceConfigurationSourceSchema,
    location: interactableLocationSchema,
    enabled: z.boolean(),
    visible: z.boolean(),
  }),
  strict({
    kind: z.literal('replace-configuration'),
    instance: sceneGameplayInstanceRefSchema,
    source: sceneInstanceConfigurationSourceSchema,
  }),
  strict({ kind: z.literal('clear-configuration'), instance: sceneGameplayInstanceRefSchema }),
  strict({
    kind: z.literal('retarget-room-exit'),
    room: roomReferenceSchema,
    exitId: id,
    target: roomReferenceSchema,
  }),
  strict({ kind: z.literal('destroy-instance'), instance: sceneGameplayInstanceRefSchema }),
]);
const sceneInteractionBindingSchema = strict({
  slotId: id,
  subject: compiledInteractionSubjectSchema,
});
const sceneInstructionSchema = z.discriminatedUnion('kind', [
  strict({
    ...sceneInstructionCommon,
    owner: z.enum(['invocation', 'active-room', 'runtime-session']),
    asset: assetReferenceSchema.nullable(),
    color: z.string().nullable(),
    durationMs: z.number().int().nonnegative(),
    fit: z.enum(['cover', 'contain', 'stretch', 'center']),
    kind: z.literal('set-background'),
    material: materialReferenceSchema.nullable(),
    skippable: z.boolean(),
    transition: z.enum(['none', 'fade', 'cut']),
    waitForCompletion: z.boolean(),
  }),
  strict({
    ...sceneInstructionCommon,
    action: z.enum(['show', 'hide', 'move', 'profile', 'pose', 'expression', 'appearance']),
    character: characterReferenceSchema,
    durationMs: z.number().int().nonnegative(),
    profileId: id.nullable(),
    expressionId: id.nullable(),
    appearanceId: id.nullable(),
    kind: z.literal('actor-cue'),
    owner: z.enum(['invocation', 'active-room', 'runtime-session']),
    offset: vector2Schema,
    poseId: id.nullable(),
    position: z.enum(['left', 'center', 'right', 'custom']),
    scale: finiteNumber.positive(),
    skippable: z.boolean(),
    slotId: id,
    transition: z.enum(['none', 'fade', 'slide']),
    waitForCompletion: z.boolean(),
  }),
  strict({
    ...sceneInstructionCommon,
    autosaveSafePoint: z.boolean(),
    inputs: z.array(compiledSceneInputBindingSchema),
    kind: z.literal('call-scene'),
    scene: sceneReferenceSchema,
  }),
  strict({
    ...sceneInstructionCommon,
    autosaveSafePoint: z.boolean(),
    inputs: z.array(compiledSceneInputBindingSchema),
    kind: z.literal('start-detached-scene'),
    owner: z.enum(['flow', 'active-room', 'runtime-session']),
    scene: sceneReferenceSchema,
  }),
  strict({
    ...sceneInstructionCommon,
    autosaveSafePoint: z.boolean(),
    dialogue: dialogueReferenceSchema,
    kind: z.literal('call-dialogue'),
    startBlockId: id.nullable(),
  }),
  strict({
    ...sceneInstructionCommon,
    autosaveSafePoint: z.boolean(),
    kind: z.literal('resume-dialogue'),
  }),
  strict({
    ...sceneInstructionCommon,
    autosaveSafePoint: z.boolean(),
    kind: z.literal('show-text'),
    speaker: characterReferenceSchema.nullable(),
    text: compiledTextSchema,
    wait: z.enum(['input', 'immediate']),
  }),
  strict({
    ...sceneInstructionCommon,
    action: z.enum(['play', 'stop', 'fade-in', 'fade-out']),
    asset: assetReferenceSchema.nullable(),
    purpose: z.enum(['music', 'ambience', 'voice', 'sound-effect', 'ui-sound']),
    lifetime: z.enum(['desired-loop', 'one-shot']),
    pausePolicy: z.enum(['gameplay', 'owner', 'unscaled']),
    gain: finiteNumber.min(0).max(1),
    pan: finiteNumber.min(-1).max(1),
    panSource: z
      .discriminatedUnion('kind', [
        strict({ kind: z.literal('scene-actor'), slotId: id }),
        strict({ kind: z.literal('room-anchor'), room: roomReferenceSchema, anchorId: id }),
      ])
      .nullable(),
    fadeMs: z.number().int().nonnegative(),
    kind: z.literal('audio-cue'),
    owner: z.enum(['invocation', 'active-room', 'runtime-session']),
    waitForCompletion: z.boolean(),
    causality: z.enum(['causal', 'disposable']),
    synchronized: z.boolean(),
    skipBehavior: z.enum(['stop', 'suppress', 'play']),
    instanceId: id.nullable(),
    replacementGroup: id.nullable(),
  }),
  strict({
    ...sceneInstructionCommon,
    kind: z.literal('set-global-property'),
    property: propertyReferenceSchema,
    value: runtimeValueSchema,
  }),
  strict({
    ...sceneInstructionCommon,
    kind: z.literal('gameplay-effect-batch'),
    operations: z.array(sceneGameplayEffectOperationSchema).min(1),
  }),
  strict({
    ...sceneInstructionCommon,
    kind: z.literal('runtime-world-transaction'),
    operations: z.array(sceneRuntimeWorldOperationSchema).min(1),
  }),
  strict({
    ...sceneInstructionCommon,
    kind: z.literal('directed-room-change'),
    room: roomReferenceSchema,
  }),
  strict({
    ...sceneInstructionCommon,
    kind: z.literal('navigation-attempt'),
    room: roomReferenceSchema,
    exitId: id,
  }),
  strict({
    ...sceneInstructionCommon,
    kind: z.literal('call-interaction'),
    verb: verbReferenceSchema,
    bindings: z.array(sceneInteractionBindingSchema),
  }),
  strict({
    ...sceneInstructionCommon,
    autosaveSafePoint: z.boolean(),
    kind: z.literal('run-lua'),
    mayYield: z.boolean(),
    source: z.string().min(1),
  }),
  strict({
    ...sceneInstructionCommon,
    durationMs: z.number().int().nonnegative(),
    kind: z.literal('wait-duration'),
    skippable: z.boolean(),
  }),
  strict({ ...sceneInstructionCommon, kind: z.literal('wait-input'), skippable: z.boolean() }),
  strict({
    ...sceneInstructionCommon,
    kind: z.literal('wait-condition'),
    waitCondition: compiledConditionSchema,
    skippable: z.boolean(),
  }),
  strict({
    ...sceneInstructionCommon,
    eventId: id,
    kind: z.literal('wait-operation'),
    skippable: z.boolean(),
  }),
  strict({
    ...sceneInstructionCommon,
    eventId: id,
    kind: z.literal('wait-audio'),
    skippable: z.boolean(),
  }),
  strict({
    ...sceneInstructionCommon,
    kind: z.literal('wait-layout-signal'),
    owner: z.enum(['invocation', 'active-room', 'runtime-session']),
    signalId: id,
    skippable: z.boolean(),
    slot: z.enum(['hud', 'dialogue-box', 'overlay', 'custom']),
  }),
  strict({
    ...sceneInstructionCommon,
    branches: z.array(strict({ condition: compiledConditionSchema, id, targetInstructionId: id })),
    fallbackInstructionId: id,
    kind: z.literal('conditional-branch'),
  }),
  strict({
    ...sceneInstructionCommon,
    autosaveSafePoint: z.boolean(),
    kind: z.literal('choice'),
    options: z
      .array(
        strict({
          condition: compiledConditionSchema.optional(),
          effects: z.array(compiledEffectSchema),
          id,
          label: compiledTextSchema,
          targetInstructionId: id,
        }),
      )
      .min(1),
    prompt: compiledTextSchema.nullable(),
  }),
  strict({
    ...sceneInstructionCommon,
    action: z.enum(['show', 'hide', 'swap']),
    durationMs: z.number().int().nonnegative(),
    kind: z.literal('set-layout'),
    owner: z.enum(['invocation', 'active-room', 'runtime-session']),
    layout: layoutReferenceSchema.nullable(),
    scaleOverrides: layoutScaleOverridesSchema.optional(),
    skippable: z.boolean(),
    slot: z.enum(['hud', 'dialogue-box', 'overlay', 'custom']),
    transition: z.enum(['none', 'fade']),
    waitForCompletion: z.boolean(),
  }),
  strict({
    ...sceneInstructionCommon,
    kind: z.literal('material-parameter'),
    owner: z.enum(['invocation', 'active-room', 'runtime-session']),
    target: compiledMaterialOccurrenceTargetSchema,
    material: materialReferenceSchema,
    parameter: z.string().min(1),
    value: compiledMaterialParameterValueSchema,
    transition: z.enum(['none', 'tween']),
    durationMs: z.number().int().nonnegative(),
    easing: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out']),
    clock: z.enum(['gameplay', 'unscaled-presentation']),
    waitForCompletion: z.boolean(),
    skippable: z.boolean(),
  }),
  strict({
    ...sceneInstructionCommon,
    kind: z.literal('postprocess-effect'),
    owner: z.enum(['invocation', 'active-room', 'runtime-session']),
    action: z.enum(['upsert', 'remove']),
    instanceId: id,
    material: materialReferenceSchema.nullable(),
    scope: z.enum(['world', 'full-game-viewport']),
    order: z.number().int(),
    clock: z.enum(['gameplay', 'unscaled-presentation']),
    parameters: z.array(
      strict({ name: z.string().min(1), value: compiledMaterialParameterValueSchema }),
    ),
  }),
  strict({
    ...sceneInstructionCommon,
    children: z.array(transitionGroupChildSchema).min(1),
    color: z.string().nullable(),
    durationMs: z.number().int().nonnegative(),
    kind: z.literal('transition-group'),
    owner: z.enum(['invocation', 'active-room', 'runtime-session']),
    skippable: z.boolean(),
    transitionKind: z.enum(['fade', 'cut', 'dissolve']),
    waitForCompletion: z.boolean(),
  }),
]);
const sceneEventSchema = strict({
  id,
  timeline: strict({
    trackId: id,
    startMs: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
  }),
  completionDependencies: z.array(id),
  instruction: sceneInstructionSchema,
}).superRefine((event, context) => {
  if (event.id !== event.instruction.id)
    context.addIssue({
      code: 'custom',
      path: ['instruction', 'id'],
      message: 'Scene Event and instruction IDs must match.',
    });
});
export const sceneProgramSchema = strict({ events: z.array(sceneEventSchema) });
const sceneStageSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('inherited') }),
  strict({ kind: z.literal('staged-room'), room: roomReferenceSchema }),
  strict({
    kind: z.literal('blank'),
    background: strict({
      asset: assetReferenceSchema.nullable(),
      color: z.string().nullable(),
      fit: z.enum(['cover', 'contain', 'stretch', 'center']),
      material: materialReferenceSchema.nullable(),
    }),
    layout: layoutReferenceSchema.nullable(),
  }),
]);
const compiledSceneInputDefinitionSchema = strict({
  defaultValue: runtimeValueSchema.optional(),
  id,
  label: z.string().min(1),
  nullable: z.boolean(),
  type: z.enum(['boolean', 'integer', 'number', 'string']),
});
const compiledSceneOutcomeDefinitionSchema = strict({ id, label: z.string().min(1) });
const compiledSceneTerminalSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('return'), outcome: id.nullable() }),
  strict({
    inputs: z.array(compiledSceneInputBindingSchema),
    kind: z.literal('continue-scene'),
    scene: sceneReferenceSchema,
  }),
  strict({ dialogue: dialogueReferenceSchema, kind: z.literal('continue-dialogue') }),
  strict({ kind: z.literal('release-to-exploration') }),
  strict({ kind: z.literal('complete-game') }),
]);
const sceneDefinitionSchema = strict({
  id,
  displayName: z.string(),
  stage: sceneStageSchema,
  inputs: z.array(compiledSceneInputDefinitionSchema),
  outcomes: z.array(compiledSceneOutcomeDefinitionSchema),
  program: sceneProgramSchema,
  terminal: compiledSceneTerminalSchema,
});

const dialogueCuePositionSchema = strict({
  offset: z.number().int().nonnegative(),
  order: z.number().int().nonnegative(),
});
const dialogueSemanticCueSchema = z.discriminatedUnion('kind', [
  strict({
    expressionId: id,
    id,
    kind: z.literal('speaker-expression'),
    position: dialogueCuePositionSchema,
  }),
  strict({
    id,
    kind: z.literal('stage'),
    position: dialogueCuePositionSchema,
    mutation: strict({
      action: z.enum(['update', 'show', 'hide', 'clear']),
      appearanceId: id.nullable().optional(),
      character: characterReferenceSchema.optional(),
      expressionId: id.optional(),
      offset: strict({ x: finiteNumber, y: finiteNumber }).optional(),
      poseId: id.optional(),
      position: z.enum(['left', 'center', 'right']).optional(),
      profileId: id.optional(),
      scale: finiteNumber.positive().optional(),
      slotId: id,
    }),
  }),
  strict({
    id,
    kind: z.literal('media'),
    position: dialogueCuePositionSchema,
    mutation: strict({
      action: z.enum(['update', 'show', 'hide', 'clear']),
      content: z
        .discriminatedUnion('kind', [
          strict({ asset: assetReferenceSchema, kind: z.literal('image') }),
          strict({
            appearanceId: id.nullable(),
            character: characterReferenceSchema,
            expressionId: id,
            kind: z.literal('character'),
            poseId: id,
            profileId: id,
          }),
        ])
        .optional(),
      slotId: id,
    }),
  }),
  strict({
    gestureId: id,
    id,
    kind: z.literal('gesture'),
    position: dialogueCuePositionSchema,
    slotId: id,
    waitForCompletion: z.boolean(),
    skippable: z.boolean(),
  }),
  strict({
    asset: assetReferenceSchema,
    gain: finiteNumber.min(0).max(1),
    id,
    kind: z.literal('voice'),
    pan: finiteNumber.min(-1).max(1),
    pausePolicy: z.enum(['gameplay', 'owner', 'unscaled']),
    position: dialogueCuePositionSchema,
    skipBehavior: z.enum(['stop', 'suppress', 'play']),
    waitForCompletion: z.boolean(),
  }),
  strict({
    asset: assetReferenceSchema,
    causality: z.enum(['causal', 'disposable']),
    gain: finiteNumber.min(0).max(1),
    id,
    kind: z.literal('sound-effect'),
    pan: finiteNumber.min(-1).max(1),
    pausePolicy: z.enum(['gameplay', 'owner', 'unscaled']),
    position: dialogueCuePositionSchema,
    skipBehavior: z.enum(['stop', 'suppress', 'play']),
    synchronized: z.boolean(),
    waitForCompletion: z.boolean(),
  }),
  strict({
    emphasis: z.discriminatedUnion('kind', [
      strict({
        amplitude: strict({ x: finiteNumber, y: finiteNumber }),
        durationMs: z.number().int().positive(),
        frequencyHz: finiteNumber.positive(),
        kind: z.literal('shake'),
        skippable: z.boolean(),
        waitForCompletion: z.boolean(),
      }),
      strict({
        durationMs: z.number().int().positive(),
        kind: z.literal('punch'),
        rotationDegrees: finiteNumber,
        skippable: z.boolean(),
        translation: strict({ x: finiteNumber, y: finiteNumber }),
        waitForCompletion: z.boolean(),
        zoomDelta: finiteNumber,
      }),
      strict({
        color: z.string().min(1),
        durationMs: z.number().int().positive(),
        kind: z.literal('flash'),
        opacity: finiteNumber.min(0).max(1),
        skippable: z.boolean(),
        waitForCompletion: z.boolean(),
      }),
    ]),
    id,
    kind: z.literal('camera'),
    position: dialogueCuePositionSchema,
  }),
]);

const dialogueSegmentSchema = z.discriminatedUnion('kind', [
  strict({
    autosaveSafePoint: z.boolean(),
    condition: compiledConditionSchema.optional(),
    cues: z.array(dialogueSemanticCueSchema),
    effects: z.array(compiledEffectSchema),
    id,
    kind: z.literal('line'),
    logged: z.boolean(),
    showOnce: z.boolean(),
    speaker: characterReferenceSchema.nullable(),
    text: compiledTextSchema,
  }),
  strict({
    condition: compiledConditionSchema.optional(),
    id,
    kind: z.literal('run-lua'),
    mayYield: z.boolean(),
    source: z.string().min(1),
  }),
  strict({
    condition: compiledConditionSchema.optional(),
    id,
    inputs: z.array(compiledSceneInputBindingSchema),
    kind: z.literal('call-scene'),
    scene: sceneReferenceSchema,
    uiPolicy: z.enum(['preserve', 'conceal']),
  }),
  strict({
    condition: compiledConditionSchema.optional(),
    id,
    kind: z.literal('handoff'),
    payload: runtimeValueSchema.optional(),
  }),
]);
const dialogueBlockSchema = z.discriminatedUnion('kind', [
  strict({
    defaultSpeaker: characterReferenceSchema.nullable(),
    id,
    kind: z.literal('sequence'),
    segments: z.array(dialogueSegmentSchema),
  }),
  strict({ id, kind: z.literal('choice') }),
  strict({ id, kind: z.literal('redirect'), targetBlockId: id }),
]);
const dialogueEdgeSchema = z.discriminatedUnion('kind', [
  strict({ fromBlockId: id, id, kind: z.literal('next'), toBlockId: id }),
  strict({
    autosaveSafePoint: z.boolean(),
    condition: compiledConditionSchema.optional(),
    effects: z.array(compiledEffectSchema),
    fromBlockId: id,
    id,
    kind: z.literal('choice'),
    label: compiledTextSchema,
    logged: z.boolean(),
    toBlockId: id,
  }),
]);
export const dialogueProgramSchema = strict({
  blocks: z.array(dialogueBlockSchema),
  edges: z.array(dialogueEdgeSchema),
  entryBlockId: id,
});
const dialogueDefinitionSchema = strict({
  id,
  completion: compiledFlowTargetSchema,
  defaultSpeaker: characterReferenceSchema.nullable(),
  displayName: z.string(),
  stageSlots: z.array(
    strict({
      id,
      initial: strict({
        appearanceId: id.nullable(),
        character: characterReferenceSchema,
        expressionId: id,
        offset: strict({ x: finiteNumber, y: finiteNumber }),
        poseId: id,
        position: z.enum(['left', 'center', 'right']),
        profileId: id,
        scale: finiteNumber.positive(),
        visible: z.boolean(),
      }).nullable(),
      speakerSync: z.boolean(),
    }),
  ),
  mediaSlots: z.array(
    strict({
      id,
      initial: z
        .discriminatedUnion('kind', [
          strict({ asset: assetReferenceSchema, kind: z.literal('image') }),
          strict({
            appearanceId: id.nullable(),
            character: characterReferenceSchema,
            expressionId: id,
            kind: z.literal('character'),
            poseId: id,
            profileId: id,
          }),
        ])
        .nullable(),
      visible: z.boolean(),
    }),
  ),
  program: dialogueProgramSchema,
  settings: strict({
    logMode: z.enum(['everything', 'nothing', 'only-choices', 'only-lines']),
    showDisabledChoices: z.boolean(),
  }),
});

const normalizedMapCoordinate = finiteNumber.min(0).max(1);
const mapPointSchema = strict({ x: normalizedMapCoordinate, y: normalizedMapCoordinate });
const mapPolygonSchema = strict({ points: z.array(mapPointSchema).min(3) });
const mapExitReferenceSchema = strict({ exitId: id, room: roomReferenceSchema });
const mapLocationSchema = strict({
  id,
  room: roomReferenceSchema,
  regions: z.array(mapPolygonSchema),
  label: compiledTextSchema.nullable(),
  icon: assetReferenceSchema.nullable(),
  style: z.string().min(1).nullable(),
  labelAnchor: mapPointSchema.nullable(),
  connectionAnchor: mapPointSchema.nullable(),
  visibility: compiledConditionSchema,
  pickOrder: z.number().int(),
  logicalOrder: z.number().int(),
});
const mapDefinitionSchema = strict({
  id,
  connections: z.array(
    strict({
      id,
      exits: z.array(mapExitReferenceSchema).min(1).max(2),
      sourceLocationId: id,
      targetLocationId: id,
      label: compiledTextSchema.nullable(),
      icon: assetReferenceSchema.nullable(),
      style: z.string().min(1).nullable(),
      visibility: compiledConditionSchema,
      logicalOrder: z.number().int(),
      path: z.array(mapPointSchema),
      hitRegions: z.array(mapPolygonSchema),
    }),
  ),
  locations: z.array(mapLocationSchema),
  presentation: strict({
    background: assetReferenceSchema.nullable(),
    initialMode: z.enum(['minimap', 'full-map']),
    layout: layoutReferenceSchema.nullable(),
    title: compiledTextSchema.nullable(),
  }),
});

const assetResourceSchema = z.discriminatedUnion('kind', [
  strict({
    aliases: z.array(z.string().min(1)),
    id,
    kind: z.literal('image'),
    path: z.string().min(1),
    sampling: z.enum(imageSamplingValues),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  strict({
    aliases: z.array(z.string().min(1)),
    id,
    kind: z.enum(['font', 'audio', 'script', 'shader-source', 'text', 'data', 'binary']),
    path: z.string().min(1),
  }),
]);
const layoutSourceSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('inline'), text: z.string() }),
  strict({ asset: assetReferenceSchema, kind: z.literal('asset') }),
]);
const layoutContractValueTypeSchema = z.enum(['boolean', 'integer', 'number', 'string']);
const layoutContractValueShapeSchema = strict({
  nullable: z.boolean(),
  type: layoutContractValueTypeSchema,
});
const compiledLayoutPersistableValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(compiledLayoutPersistableValueSchema),
    z.record(z.string().min(1), compiledLayoutPersistableValueSchema),
  ]),
);
const compiledLayoutStateShapeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion('type', [
    strict({
      defaultValue: compiledLayoutPersistableValueSchema.nullable(),
      hasDefault: z.boolean(),
      nullable: z.boolean(),
      type: layoutContractValueTypeSchema,
    }),
    strict({
      defaultValue: compiledLayoutPersistableValueSchema.nullable(),
      hasDefault: z.boolean(),
      items: compiledLayoutStateShapeSchema,
      nullable: z.boolean(),
      type: z.literal('array'),
    }),
    strict({
      defaultValue: compiledLayoutPersistableValueSchema.nullable(),
      fields: z.array(strict({ id, required: z.boolean(), shape: compiledLayoutStateShapeSchema })),
      hasDefault: z.boolean(),
      nullable: z.boolean(),
      type: z.literal('object'),
    }),
  ]),
);
const layoutResourceSchema = strict({
  contract: strict({
    inputs: z.array(
      strict({
        defaultValue: runtimeValueSchema.nullable(),
        hasDefault: z.boolean(),
        id,
        nullable: z.boolean(),
        type: layoutContractValueTypeSchema,
      }),
    ),
    signals: z.array(
      strict({
        fields: z.array(
          strict({
            id,
            required: z.boolean(),
            ...layoutContractValueShapeSchema.shape,
          }),
        ),
        id,
      }),
    ),
    state: compiledLayoutStateShapeSchema.nullable(),
  }).optional(),
  dependencies: strict({
    fonts: z.array(assetReferenceSchema),
    images: z.array(assetReferenceSchema),
    materials: z.array(materialReferenceSchema),
    scripts: z.array(assetReferenceSchema),
    stylesheets: z.array(assetReferenceSchema),
  }),
  id,
  kind: z.enum(['document', 'fragment']),
  lua: layoutSourceSchema,
  mount: strict({ defaultParent: z.string().nullable(), scopedStyles: z.boolean() }),
  rcss: layoutSourceSchema,
  rml: layoutSourceSchema,
  script: strict({ enabled: z.boolean(), namespace: z.string().nullable() }),
  scalePolicy: layoutScalePolicySchema,
  target: z.enum([
    'default-ui',
    'dialogue-ui',
    'scene-overlay',
    'room-overlay',
    'menu-ui',
    'custom-overlay',
  ]),
});
const scriptResourceSchema = strict({
  id,
  source: z.discriminatedUnion('kind', [
    strict({ kind: z.literal('inline-lua'), source: z.string() }),
    strict({ asset: assetReferenceSchema, kind: z.literal('asset') }),
  ]),
});

const localizationCatalogSchema = strict({
  entries: z.array(strict({ key: z.string().min(1), value: z.string() })),
  locale: z.string().check(z.trim(), z.minLength(1)),
});
const runtimeSettingsSchema = strict({
  display: strict({
    referenceResolution: strict({
      height: z.number().int().positive().max(MAX_REFERENCE_RESOLUTION_DIMENSION),
      width: z.number().int().positive().max(MAX_REFERENCE_RESOLUTION_DIMENSION),
    }),
    barColor: z.string(),
    worldRasterPolicy: z.enum(['capped', 'native']),
  }),
  accessibility: strict({
    uiScale: strict({
      enabled: z.boolean(),
      maximum: positiveFiniteNumber,
      minimum: positiveFiniteNumber,
    }),
    textScale: strict({
      enabled: z.boolean(),
      maximum: positiveFiniteNumber,
      minimum: positiveFiniteNumber,
    }),
  }),
  audio: strict({
    purposes: strict({
      music: strict({ volume: finiteNumber.min(0).max(1), muted: z.boolean() }),
      ambience: strict({ volume: finiteNumber.min(0).max(1), muted: z.boolean() }),
      voice: strict({ volume: finiteNumber.min(0).max(1), muted: z.boolean() }),
      'sound-effect': strict({ volume: finiteNumber.min(0).max(1), muted: z.boolean() }),
      'ui-sound': strict({ volume: finiteNumber.min(0).max(1), muted: z.boolean() }),
    }),
    voiceDucking: strict({
      enabled: z.boolean(),
      musicGain: finiteNumber.min(0).max(1),
      ambienceGain: finiteNumber.min(0).max(1),
    }),
  }),
  systemLayouts: z.array(
    strict({
      layout: layoutReferenceSchema.nullable(),
      role: z.enum([
        'title',
        'game-hud',
        'pause-menu',
        'save-menu',
        'load-menu',
        'settings-menu',
        'text-log',
        'modal',
        'debug-overlay',
        'command-builder',
        'scene-text',
        'scene-choice',
      ]),
    }),
  ),
  roomNavigationTransition: roomNavigationTransitionSchema,
  text: strict({ defaultFont: assetReferenceSchema.nullable() }),
  titleScreen: strict({
    showAuthor: z.boolean(),
    showProjectTitle: z.boolean(),
    startLabel: z.string().min(1),
    subtitle: z.string(),
    titleImage: assetReferenceSchema.nullable(),
  }),
});

export const compiledDiagnosticSchema = strict({
  code: z.string().min(1),
  jsonPointer: z.string(),
  message: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  sourcePath: z.string(),
  sortKey: strict({ code: z.string(), jsonPointer: z.string(), sourcePath: z.string() }),
});

export const compiledProjectWireSchema = strict({
  archetypes: z.array(archetypeDefinitionSchema),
  definitions: strict({
    characters: z.array(characterDefinitionSchema),
    dialogues: z.array(dialogueDefinitionSchema),
    interactables: z.array(interactableDefinitionSchema),
    interactions: z.array(interactionDefinitionSchema),
    maps: z.array(mapDefinitionSchema),
    rooms: z.array(roomDefinitionSchema),
    scenes: z.array(sceneDefinitionSchema),
    verbs: z.array(verbDefinitionSchema),
  }),
  entrypoint: compiledEntrypointSchema,
  localization: strict({
    catalogs: z.array(localizationCatalogSchema),
    defaultLocale: z.string().check(z.trim(), z.minLength(1)),
    fallbackLocale: z.string().check(z.trim(), z.minLength(1)).nullable(),
  }),
  project: strict({
    author: z.string(),
    description: z.string(),
    id,
    name: z.string(),
    version: z.string(),
  }),
  properties: z.array(propertyDefinitionSchema),
  traits: z.array(traitDefinitionSchema),
  inventories: z.array(inventoryDefinitionSchema),
  interactableInstances: z.array(interactableInstanceDeclarationSchema),
  resources: strict({
    assets: z.array(assetResourceSchema),
    layouts: z.array(layoutResourceSchema),
    materialInterfaces: z.array(compiledMaterialInterfaceSchema),
    scripts: z.array(scriptResourceSchema),
  }),
  saveContract: z.string().regex(COMPILED_PROJECT_SAVE_CONTRACT_PATTERN),
  schema: z.literal(COMPILED_PROJECT_SCHEMA),
  schemaVersion: z.literal(COMPILED_PROJECT_FORMAT_VERSION),
  settings: runtimeSettingsSchema,
  bootstrapModule: scriptReferenceSchema,
  undefinedInteractionProgram: interactionProgramSchema.nullable().optional(),
}).superRefine((project, context) => {
  const collections = [
    { path: ['definitions', 'characters'], records: project.definitions.characters },
    { path: ['definitions', 'dialogues'], records: project.definitions.dialogues },
    { path: ['definitions', 'interactables'], records: project.definitions.interactables },
    { path: ['definitions', 'interactions'], records: project.definitions.interactions },
    { path: ['definitions', 'maps'], records: project.definitions.maps },
    { path: ['definitions', 'rooms'], records: project.definitions.rooms },
    { path: ['definitions', 'scenes'], records: project.definitions.scenes },
    { path: ['definitions', 'verbs'], records: project.definitions.verbs },
    { path: ['traits'], records: project.traits },
    { path: ['archetypes'], records: project.archetypes },
    { path: ['interactableInstances'], records: project.interactableInstances },
    { path: ['resources', 'assets'], records: project.resources.assets },
    { path: ['resources', 'layouts'], records: project.resources.layouts },
    { path: ['resources', 'scripts'], records: project.resources.scripts },
  ];
  collections.forEach(({ path, records }) => {
    const ids = new Set<string>();
    records.forEach((record, index) => {
      if (ids.has(record.id))
        context.addIssue({
          code: 'custom',
          message: `Duplicate ID '${record.id}'.`,
          path: [...path, index, 'id'],
        });
      ids.add(record.id);
    });
  });
  const propertyIdentities = new Set<string>();
  project.properties.forEach((property, index) => {
    const identity =
      property.scope === 'global' || !('owner' in property)
        ? `registry:${property.id}`
        : property.owner.kind === 'room'
          ? `room:${property.owner.room.id}:${property.id}`
          : property.owner.kind === 'character'
            ? `character:${property.owner.character.id}:${property.id}`
            : `interactable:${property.owner.interactable.id}:${property.id}`;
    if (propertyIdentities.has(identity))
      context.addIssue({
        code: 'custom',
        message: `Duplicate Property identity '${property.id}'.`,
        path: ['properties', index, 'id'],
      });
    propertyIdentities.add(identity);
  });
  for (const scale of ['uiScale', 'textScale'] as const) {
    const policy = project.settings.accessibility[scale];
    if (policy.minimum > policy.maximum) {
      context.addIssue({
        code: 'custom',
        message: 'Accessibility scale minimum must not exceed maximum.',
        path: ['settings', 'accessibility', scale, 'minimum'],
      });
    }
    if (policy.enabled && (policy.minimum > 1 || policy.maximum < 1)) {
      context.addIssue({
        code: 'custom',
        message: 'Enabled accessibility scale range must include 1.0.',
        path: ['settings', 'accessibility', scale],
      });
    }
  }
});

export type CompiledRuntimeValue = z.infer<typeof runtimeValueSchema>;
export type CompiledText = z.infer<typeof compiledTextSchema>;
export type CompiledCondition = z.infer<typeof compiledConditionSchema>;
export type CompiledEffect = z.infer<typeof compiledEffectSchema>;
export type CompiledFlowTarget = z.infer<typeof compiledFlowTargetSchema>;
export type CompiledAssetReference = z.infer<typeof assetReferenceSchema>;
export type CompiledLayoutReference = z.infer<typeof layoutReferenceSchema>;
export type CompiledMaterialReference = z.infer<typeof materialReferenceSchema>;
export type InteractionProgram = z.infer<typeof interactionProgramSchema>;
export type SceneProgram = z.infer<typeof sceneProgramSchema>;
export type DialogueProgram = z.infer<typeof dialogueProgramSchema>;
export type CompiledDiagnostic = z.infer<typeof compiledDiagnosticSchema>;
export type CompiledHotspotRef = z.infer<typeof compiledHotspotRefSchema>;
export type CompiledProjectWire = z.infer<typeof compiledProjectWireSchema>;

export function parseCompiledProjectWire(value: unknown): CompiledProjectWire {
  return compiledProjectWireSchema.parse(value);
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]!.codePointAt(0)! - rightPoints[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function canonicalizeJson(value: CanonicalJson): CanonicalJson {
  if (typeof value === 'number') return Object.is(value, -0) ? 0 : value;
  if (value === null || typeof value !== 'object') return value;

  type PendingContainer =
    | { source: CanonicalJson[]; target: CanonicalJson[] }
    | {
        source: { [key: string]: CanonicalJson };
        target: { [key: string]: CanonicalJson };
      };

  const root: CanonicalJson = Array.isArray(value)
    ? Array.from<CanonicalJson>({ length: value.length })
    : {};
  const pending: PendingContainer[] = [
    Array.isArray(value)
      ? { source: value, target: root as CanonicalJson[] }
      : {
          source: value,
          target: root as { [key: string]: CanonicalJson },
        },
  ];

  // Keep this iterative so large compiled-project traversals do not depend on host recursion depth.
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;

    if (Array.isArray(current.source)) {
      const target = current.target as CanonicalJson[];
      for (let index = 0; index < current.source.length; index += 1) {
        const child = current.source[index]!;
        if (typeof child === 'number') {
          target[index] = Object.is(child, -0) ? 0 : child;
        } else if (Array.isArray(child)) {
          const childTarget = Array.from<CanonicalJson>({ length: child.length });
          target[index] = childTarget;
          pending.push({ source: child, target: childTarget });
        } else if (child !== null && typeof child === 'object') {
          const childTarget: { [key: string]: CanonicalJson } = {};
          target[index] = childTarget;
          pending.push({ source: child, target: childTarget });
        } else {
          target[index] = child;
        }
      }
      continue;
    }

    const target = current.target as { [key: string]: CanonicalJson };
    for (const key of Object.keys(current.source).sort(compareUnicodeCodePoints)) {
      const child = current.source[key]!;
      if (typeof child === 'number') {
        target[key] = Object.is(child, -0) ? 0 : child;
      } else if (Array.isArray(child)) {
        const childTarget = Array.from<CanonicalJson>({ length: child.length });
        target[key] = childTarget;
        pending.push({ source: child, target: childTarget });
      } else if (child !== null && typeof child === 'object') {
        const childTarget: { [key: string]: CanonicalJson } = {};
        target[key] = childTarget;
        pending.push({ source: child, target: childTarget });
      } else {
        target[key] = child;
      }
    }
  }

  return root;
}

function fnv1a32(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Computes the compiler-owned identity for state that a save may retain or resume through.
 * Project display metadata, localization, runtime settings, and asset/layout source details are
 * deliberately excluded; persistent declarations, executable checkpoint-addressable definitions,
 * Bootstrap/module code, and referenced resource identities are included.
 */
export function computeCompiledProjectSaveContract(project: CompiledProjectWire): `sc1:${string}` {
  const projection: CanonicalJson = {
    bootstrapModule: project.bootstrapModule as CanonicalJson,
    archetypes: project.archetypes as CanonicalJson,
    definitions: project.definitions as CanonicalJson,
    inventories: project.inventories as CanonicalJson,
    interactableInstances: project.interactableInstances as CanonicalJson,
    properties: project.properties as CanonicalJson,
    resources: {
      assets: project.resources.assets.map((asset) => asset.id),
      layouts: project.resources.layouts.map((layout) =>
        layout.contract?.state
          ? {
              id: layout.id,
              state: layout.contract.state as CanonicalJson,
            }
          : layout.id,
      ) as CanonicalJson,
      materialInterfaces: project.resources.materialInterfaces as CanonicalJson,
      scripts: project.resources.scripts as CanonicalJson,
    },
    traits: project.traits as CanonicalJson,
  };
  const canonical = JSON.stringify(canonicalizeJson(projection));
  const digest = [2166136261, 2246822507, 3266489909, 668265263]
    .map((seed) => fnv1a32(canonical, seed))
    .join('');
  return `sc1:${digest}`;
}

/**
 * Produces compact canonical gameplay JSON. It orders object keys recursively,
 * normalizes negative zero, and deliberately preserves every array's order.
 * Compiler stages own definition sorting and authored-sequence preservation.
 */
export function serializeCompiledProjectWire(value: unknown): string {
  return JSON.stringify(canonicalizeJson(parseCompiledProjectWire(value) as CanonicalJson));
}
