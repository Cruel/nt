import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import { imageSamplingValues } from './authoring-assets';
import { MAX_REFERENCE_RESOLUTION_DIMENSION } from './project-display-contract';

/**
 * The sole gameplay JSON contract for the native decoder. This is
 * deliberately independent of the editable AuthoringProject V4 shape.
 */
export const COMPILED_PROJECT_SCHEMA = 'noveltea.compiled.project' as const;
export const COMPILED_PROJECT_SCHEMA_VERSION = 4 as const;

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
const characterReferenceSchema = typedReference('character');
const dialogueReferenceSchema = typedReference('dialogue');
const interactableReferenceSchema = typedReference('interactable');
const layoutReferenceSchema = typedReference('layout');
const materialReferenceSchema = typedReference('material');
const roomReferenceSchema = typedReference('room');
const sceneReferenceSchema = typedReference('scene');
const scriptReferenceSchema = typedReference('script');
const propertyReferenceSchema = typedReference('property');
const verbReferenceSchema = typedReference('verb');

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
const propertyBearingDefinition = {
  id,
  traits: z.array(id),
  propertyAssignments: z.array(propertyAssignmentSchema),
};

const propertyOwnerKindSchema = z.enum(['room', 'character', 'interactable']);

const traitPropertySchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('required'), propertyId: id }),
  strict({ kind: z.literal('configured'), propertyId: id, value: runtimeValueSchema }),
]);
const traitDefinitionSchema = strict({
  description: z.string(),
  id,
  label: z.string().min(1),
  ownerKinds: z.array(propertyOwnerKindSchema).min(1),
  properties: z.array(traitPropertySchema).min(1),
});

const propertyDefinitionCommon = {
  description: z.string(),
  enumValues: z.array(z.string().min(1)),
  id,
  label: z.string().min(1),
  nullable: z.boolean(),
  type: z.enum(['boolean', 'integer', 'number', 'string', 'enum']),
};

const propertyDefinitionSchema = z.discriminatedUnion('scope', [
  strict({
    ...propertyDefinitionCommon,
    defaultValue: runtimeValueSchema,
    scope: z.literal('global'),
  }),
  strict({
    ...propertyDefinitionCommon,
    defaultValue: runtimeValueSchema.optional(),
    ownerKinds: z.array(propertyOwnerKindSchema).min(1),
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
const roomPlacementReferenceSchema = strict({ placementId: id, room: roomReferenceSchema });
const hotspotHighlightSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('default') }),
  strict({ kind: z.literal('material'), material: materialReferenceSchema }),
  strict({ kind: z.literal('none') }),
]);
const verbHotspotActivationSchema = strict({
  kind: z.literal('verb'),
  verb: verbReferenceSchema,
});
const roomHotspotActivationSchema = z.discriminatedUnion('kind', [
  verbHotspotActivationSchema,
  strict({ kind: z.literal('exit'), exitId: id }),
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

const characterPoseSchema = strict({
  anchor: vector2Schema,
  id,
  material: materialReferenceSchema.nullable(),
  offset: vector2Schema,
  scale: finiteNumber.positive(),
  sprite: assetReferenceSchema.nullable(),
});

const characterExpressionSchema = strict({
  id,
  material: materialReferenceSchema.nullable(),
  poseId: id.nullable(),
  sprite: assetReferenceSchema.nullable(),
});
const characterIdleSchema = strict({
  id,
  kind: z.enum(['bob', 'sway', 'pulse']),
  amplitude: finiteNumber.nonnegative(),
  periodMs: z.number().int().positive(),
  clock: z.enum(['gameplay', 'unscaled-presentation']),
});

const characterDefinitionSchema = strict({
  ...propertyBearingDefinition,
  defaults: strict({ expressionId: id, poseId: id, idleId: id.nullable().optional() }),
  dialogue: strict({
    name: z.string(),
    nameColor: z.string().nullable(),
    styleClass: z.string(),
    textColor: z.string().nullable(),
  }),
  displayName: z.string(),
  expressions: z.array(characterExpressionSchema),
  idles: z.array(characterIdleSchema).optional(),
  poses: z.array(characterPoseSchema),
  initialWorldState: strict({
    enabled: z.boolean(),
    visible: z.boolean(),
    location: z.discriminatedUnion('kind', [
      strict({ kind: z.literal('nowhere') }),
      strict({ kind: z.literal('room-placement'), placement: roomPlacementReferenceSchema }),
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
const roomHookProgramSchema = strict({
  effects: z.array(compiledEffectSchema),
  hook: z.enum(['before-enter', 'after-enter', 'before-leave', 'after-leave']),
});
const roomDefinitionSchema = strict({
  ...propertyBearingDefinition,
  background: strict({
    asset: assetReferenceSchema.nullable(),
    color: z.string().nullable(),
    fit: z.enum(['cover', 'contain', 'stretch', 'center']),
    material: materialReferenceSchema.nullable(),
  }),
  description: compiledTextSchema,
  displayName: z.string(),
  exits: z.array(roomExitSchema),
  lifecycle: strict({
    canEnter: compiledConditionSchema,
    canLeave: compiledConditionSchema,
    hooks: z.array(roomHookProgramSchema),
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
      poseId: id.nullable(),
      expressionId: id.nullable(),
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
  compose: strict({ script: scriptReferenceSchema }).nullable(),
  placements: z.array(roomPlacementSchema),
  hotspots: z.array(
    strict({
      ...hotspotCommonShape,
      shape: strict({ kind: z.literal('rect'), bounds: normalizedRectSchema }),
      activation: roomHotspotActivationSchema,
    }),
  ),
});

const interactableLocationSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('inventory') }),
  strict({ kind: z.literal('nowhere') }),
  strict({ kind: z.literal('room-placement'), placement: roomPlacementReferenceSchema }),
]);
const interactableDefinitionSchema = strict({
  ...propertyBearingDefinition,
  displayName: z.string(),
  initialState: strict({
    enabled: z.boolean(),
    location: interactableLocationSchema,
    visible: z.boolean(),
  }),
  presentation: strict({
    material: materialReferenceSchema.nullable(),
    sprite: assetReferenceSchema.nullable(),
    hotspots: z.discriminatedUnion('kind', [
      strict({
        kind: z.literal('sprite-alpha'),
        hotspot: strict({ ...hotspotCommonShape, activation: verbHotspotActivationSchema }),
      }),
      strict({
        kind: z.literal('custom'),
        hotspots: z.array(
          strict({
            ...hotspotCommonShape,
            activation: verbHotspotActivationSchema,
            shape: strict({ kind: z.literal('rect'), bounds: normalizedRectSchema }),
          }),
        ),
      }),
    ]),
  }),
});

const interactionMoveTargetSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('inventory') }),
  strict({ kind: z.literal('nowhere') }),
  strict({ kind: z.literal('room-placement'), placement: roomPlacementReferenceSchema }),
]);
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
const interactionContextSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('any') }),
  strict({ kind: z.literal('active-room'), room: roomReferenceSchema }),
  strict({ kind: z.literal('room-placement'), placement: roomPlacementReferenceSchema }),
  strict({ condition: compiledConditionSchema, kind: z.literal('predicate') }),
  strict({ kind: z.literal('hotspot'), hotspot: compiledHotspotRefSchema }),
]);
const interactionOperandSchema = z.discriminatedUnion('kind', [
  strict({
    subject: z.discriminatedUnion('kind', [
      strict({ character: characterReferenceSchema, kind: z.literal('character') }),
      strict({ interactable: interactableReferenceSchema, kind: z.literal('interactable') }),
    ]),
    kind: z.literal('exact'),
  }),
  strict({ kind: z.literal('any-character') }),
  strict({ kind: z.literal('any-interactable') }),
  strict({ kind: z.literal('any-subject') }),
]);
const interactionRuleSchema = strict({
  context: interactionContextSchema,
  id,
  operands: z.array(interactionOperandSchema).max(2),
  program: interactionProgramSchema,
  verb: verbReferenceSchema,
});
const interactionDefinitionSchema = strict({
  id,
  rules: z.array(interactionRuleSchema),
});
const verbDefinitionSchema = strict({
  id,
  actionText: compiledTextSchema,
  arity: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  availability: compiledConditionSchema,
  defaultProgram: interactionProgramSchema,
  operandRoles: z.array(z.string().min(1)).max(2),
  quickAction: z.boolean(),
});

const sceneInstructionCommon = { condition: compiledConditionSchema.optional(), id };
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
    action: z.enum(['show', 'hide', 'move', 'pose', 'expression']),
    character: characterReferenceSchema,
    expressionId: id.nullable(),
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
const sceneInstructionSchema = z.discriminatedUnion('kind', [
  strict({
    ...sceneInstructionCommon,
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
    action: z.enum(['show', 'hide', 'move', 'pose', 'expression']),
    character: characterReferenceSchema,
    durationMs: z.number().int().nonnegative(),
    expressionId: id.nullable(),
    kind: z.literal('actor-cue'),
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
    dialogue: dialogueReferenceSchema,
    kind: z.literal('call-dialogue'),
    startBlockId: id.nullable(),
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
    channel: z.enum(['sound-effect', 'music', 'voice', 'ambient']),
    fadeMs: z.number().int().nonnegative(),
    kind: z.literal('audio-cue'),
    loop: z.boolean(),
    volume: finiteNumber.min(0).max(1),
    waitForCompletion: z.boolean(),
  }),
  strict({
    ...sceneInstructionCommon,
    kind: z.literal('set-global-property'),
    property: propertyReferenceSchema,
    value: runtimeValueSchema,
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
    layout: layoutReferenceSchema.nullable(),
    scaleOverrides: layoutScaleOverridesSchema.optional(),
    skippable: z.boolean(),
    slot: z.enum(['hud', 'dialogue-box', 'overlay', 'custom']),
    transition: z.enum(['none', 'fade']),
    waitForCompletion: z.boolean(),
  }),
  strict({
    ...sceneInstructionCommon,
    children: z.array(transitionGroupChildSchema).min(1),
    color: z.string().nullable(),
    durationMs: z.number().int().nonnegative(),
    kind: z.literal('transition-group'),
    skippable: z.boolean(),
    transitionKind: z.enum(['fade', 'cut', 'dissolve']),
    waitForCompletion: z.boolean(),
  }),
]);
export const sceneProgramSchema = strict({ instructions: z.array(sceneInstructionSchema) });
const sceneDefinitionSchema = strict({
  id,
  defaultBackground: strict({
    asset: assetReferenceSchema.nullable(),
    color: z.string().nullable(),
    fit: z.enum(['cover', 'contain', 'stretch', 'center']),
    material: materialReferenceSchema.nullable(),
  }),
  defaultLayout: layoutReferenceSchema.nullable(),
  displayName: z.string(),
  program: sceneProgramSchema,
  continuation: compiledFlowTargetSchema,
});

const dialogueSegmentSchema = z.discriminatedUnion('kind', [
  strict({
    autosaveSafePoint: z.boolean(),
    condition: compiledConditionSchema.optional(),
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
  program: dialogueProgramSchema,
  settings: strict({
    logMode: z.enum(['everything', 'nothing', 'only-choices', 'only-lines']),
    showDisabledChoices: z.boolean(),
  }),
});

const mapLocationSchema = strict({
  id,
  label: compiledTextSchema.nullable(),
  position: vector2Schema,
  room: roomReferenceSchema,
  shape: z.discriminatedUnion('kind', [
    strict({ kind: z.literal('point') }),
    strict({ kind: z.literal('circle'), radius: finiteNumber.positive() }),
    strict({
      height: finiteNumber.positive(),
      kind: z.literal('rect'),
      width: finiteNumber.positive(),
    }),
  ]),
});
const mapDefinitionSchema = strict({
  id,
  connections: z.array(
    strict({
      exit: strict({ exitId: id, room: roomReferenceSchema }),
      id,
      sourceLocationId: id,
      targetLocationId: id,
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
const layoutResourceSchema = strict({
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

export const compiledProjectWireV4Schema = strict({
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
  resources: strict({
    assets: z.array(assetResourceSchema),
    layouts: z.array(layoutResourceSchema),
    scripts: z.array(scriptResourceSchema),
  }),
  schema: z.literal(COMPILED_PROJECT_SCHEMA),
  schemaVersion: z.literal(COMPILED_PROJECT_SCHEMA_VERSION),
  settings: runtimeSettingsSchema,
  startupHook: strict({ source: z.string() }).nullable(),
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
    { path: ['properties'], records: project.properties },
    { path: ['traits'], records: project.traits },
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
export type CompiledProjectWireV4 = z.infer<typeof compiledProjectWireV4Schema>;

export function parseCompiledProjectWireV4(value: unknown): CompiledProjectWireV4 {
  return compiledProjectWireV4Schema.parse(value);
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

/**
 * Produces compact canonical gameplay JSON. It orders object keys recursively,
 * normalizes negative zero, and deliberately preserves every array's order.
 * Compiler stages own definition sorting and authored-sequence preservation.
 */
export function serializeCompiledProjectWireV4(value: unknown): string {
  return JSON.stringify(canonicalizeJson(parseCompiledProjectWireV4(value)));
}
