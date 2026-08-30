import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import { defaultedLuaExplicitDependenciesSchema } from './authoring-lua-analysis';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

const typedRef = <Collection extends string>(collection: Collection) =>
  strict({
    $ref: strict({ collection: z.literal(collection), id: entityIdSchema }),
  });

export const assetRefSchema = typedRef('assets');
export const archetypeRefSchema = typedRef('archetypes');
export const materialRefSchema = typedRef('materials');
export const characterRefSchema = typedRef('characters');
export const dialogueRefSchema = typedRef('dialogues');
export const layoutRefSchema = typedRef('layouts');
export const variableRefSchema = typedRef('variables');
export const roomRefSchema = typedRef('rooms');
export const sceneRefSchema = typedRef('scenes');
export const scriptRefSchema = typedRef('scripts');
export const interactableRefSchema = typedRef('interactables');
export const verbRefSchema = typedRef('verbs');
export const traitRefSchema = typedRef('traits');
export const interactableInstanceRefSchema = strict({
  $ref: strict({ registry: z.literal('interactableInstances'), id: entityIdSchema }),
});

export const inventoryOwnerSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('project') }),
  strict({ kind: z.literal('character'), character: characterRefSchema }),
  strict({ kind: z.literal('interactable'), interactable: interactableInstanceRefSchema }),
  strict({ kind: z.literal('room-feature'), room: roomRefSchema, featureId: entityIdSchema }),
  strict({
    kind: z.literal('interactable-feature'),
    interactable: interactableInstanceRefSchema,
    featureId: entityIdSchema,
  }),
]);

export const inventoryReferenceSchema = strict({
  owner: inventoryOwnerSchema,
  inventoryId: entityIdSchema,
});

export const runtimeScalarSchema = z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
]);

export const flowTargetSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('scene'), id: entityIdSchema }),
  strict({ kind: z.literal('dialogue'), id: entityIdSchema }),
  strict({ kind: z.literal('room'), id: entityIdSchema }),
  strict({ kind: z.literal('return') }),
  strict({ kind: z.literal('end') }),
]);

export const textSourceSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('inline'), text: z.string() }),
  strict({ kind: z.literal('localized'), key: entityIdSchema }),
  strict({
    kind: z.literal('lua-expression'),
    source: z.string().min(1),
    additionalDependencies: defaultedLuaExplicitDependenciesSchema,
  }),
]);

export const textContentSchema = strict({
  source: textSourceSchema,
  markup: z.enum(['plain', 'active-text']),
});

export const valueComparisonOperatorSchema = z.enum([
  'equal',
  'not-equal',
  'less',
  'less-equal',
  'greater',
  'greater-equal',
]);
export const propertyComparisonOperatorSchema = z.enum([
  ...valueComparisonOperatorSchema.options,
  'truthy',
  'falsy',
]);

const interactionSlotOperandSchema = strict({
  kind: z.literal('interaction-slot'),
  slotId: entityIdSchema,
});
const commandResultOperandSchema = strict({
  kind: z.literal('command-result'),
  bindingId: entityIdSchema,
});

export const gameplayIdentityOperandSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('room'), room: roomRefSchema }),
  strict({ kind: z.literal('character'), character: characterRefSchema }),
  strict({ kind: z.literal('interactable'), interactable: interactableInstanceRefSchema }),
  strict({ kind: z.literal('room-feature'), room: roomRefSchema, featureId: entityIdSchema }),
  strict({
    kind: z.literal('interactable-feature'),
    interactable: interactableInstanceRefSchema,
    featureId: entityIdSchema,
  }),
  strict({ kind: z.literal('current-room') }),
  interactionSlotOperandSchema,
  commandResultOperandSchema,
]);

export const interactableOperandSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('interactable'), interactable: interactableInstanceRefSchema }),
  interactionSlotOperandSchema,
  commandResultOperandSchema,
]);

export const locationSubjectOperandSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('character'), character: characterRefSchema }),
  strict({ kind: z.literal('interactable'), interactable: interactableInstanceRefSchema }),
  interactionSlotOperandSchema,
  commandResultOperandSchema,
]);

export const roomOperandSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('room'), room: roomRefSchema }),
  strict({ kind: z.literal('current-room') }),
  commandResultOperandSchema,
]);

export const inventoryOwnerOperandSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('project') }),
  strict({ kind: z.literal('character'), character: characterRefSchema }),
  strict({ kind: z.literal('interactable'), interactable: interactableInstanceRefSchema }),
  strict({ kind: z.literal('room-feature'), room: roomRefSchema, featureId: entityIdSchema }),
  strict({
    kind: z.literal('interactable-feature'),
    interactable: interactableInstanceRefSchema,
    featureId: entityIdSchema,
  }),
  interactionSlotOperandSchema,
  commandResultOperandSchema,
]);

export const inventoryOperandSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('inventory'), inventory: inventoryReferenceSchema }),
  strict({ kind: z.literal('player-inventory') }),
  strict({
    kind: z.literal('owner-inventory'),
    owner: inventoryOwnerOperandSchema,
    inventoryId: entityIdSchema,
  }),
  commandResultOperandSchema,
]);

export const locationOperandSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('unplaced') }),
  strict({ kind: z.literal('room'), room: roomOperandSchema }),
  strict({ kind: z.literal('inventory'), inventory: inventoryOperandSchema }),
]);

export const interactableMatcherSchema = strict({
  definition: interactableRefSchema.optional(),
  traits: z.array(traitRefSchema).default([]),
  properties: z
    .array(
      strict({
        propertyId: entityIdSchema,
        value: runtimeScalarSchema,
      }),
    )
    .default([]),
  exact: interactableOperandSchema.optional(),
});

export type Condition =
  | { kind: 'always' }
  | { kind: 'all'; conditions: Condition[] }
  | { kind: 'any'; conditions: Condition[] }
  | { kind: 'not'; condition: Condition }
  | {
      kind: 'variable-comparison';
      variable: z.infer<typeof variableRefSchema>;
      operator: z.infer<typeof propertyComparisonOperatorSchema>;
      value?: z.infer<typeof runtimeScalarSchema>;
    }
  | {
      kind: 'property-comparison';
      owner: z.infer<typeof gameplayIdentityOperandSchema>;
      propertyId: string;
      operator: z.infer<typeof propertyComparisonOperatorSchema>;
      value?: z.infer<typeof runtimeScalarSchema>;
    }
  | {
      kind: 'trait-presence';
      owner: z.infer<typeof gameplayIdentityOperandSchema>;
      trait: z.infer<typeof traitRefSchema>;
      present: boolean;
    }
  | {
      kind: 'location-comparison';
      subject: z.infer<typeof locationSubjectOperandSchema>;
      operator: 'equal' | 'not-equal';
      location: z.infer<typeof locationOperandSchema>;
    }
  | {
      kind: 'inventory-quantity-comparison';
      inventory: z.infer<typeof inventoryOperandSchema>;
      matcher: z.infer<typeof interactableMatcherSchema>;
      operator: z.infer<typeof valueComparisonOperatorSchema>;
      quantity: number;
    }
  | {
      kind: 'lua-predicate';
      source: string;
      additionalDependencies?: z.infer<typeof defaultedLuaExplicitDependenciesSchema>;
    };

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    strict({ kind: z.literal('always') }),
    strict({ kind: z.literal('all'), conditions: z.array(conditionSchema) }),
    strict({ kind: z.literal('any'), conditions: z.array(conditionSchema) }),
    strict({ kind: z.literal('not'), condition: conditionSchema }),
    strict({
      kind: z.literal('variable-comparison'),
      variable: variableRefSchema,
      operator: propertyComparisonOperatorSchema,
      value: runtimeScalarSchema.optional(),
    }),
    strict({
      kind: z.literal('property-comparison'),
      owner: gameplayIdentityOperandSchema,
      propertyId: entityIdSchema,
      operator: propertyComparisonOperatorSchema,
      value: runtimeScalarSchema.optional(),
    }),
    strict({
      kind: z.literal('trait-presence'),
      owner: gameplayIdentityOperandSchema,
      trait: traitRefSchema,
      present: z.boolean(),
    }),
    strict({
      kind: z.literal('location-comparison'),
      subject: locationSubjectOperandSchema,
      operator: z.enum(['equal', 'not-equal']),
      location: locationOperandSchema,
    }),
    strict({
      kind: z.literal('inventory-quantity-comparison'),
      inventory: inventoryOperandSchema,
      matcher: interactableMatcherSchema,
      operator: valueComparisonOperatorSchema,
      quantity: z.number().int().nonnegative().safe(),
    }),
    strict({
      kind: z.literal('lua-predicate'),
      source: z.string().min(1),
      additionalDependencies: defaultedLuaExplicitDependenciesSchema,
    }),
  ]),
);

export const effectSchema = z.discriminatedUnion('kind', [
  strict({
    kind: z.literal('set-variable'),
    variable: variableRefSchema,
    value: runtimeScalarSchema,
  }),
  strict({ kind: z.literal('run-lua-effect'), source: z.string().min(1) }),
]);

export const gameplayConfigurationSourceSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('archetype'), archetype: archetypeRefSchema }),
  strict({ kind: z.literal('compiled-instance'), instance: gameplayIdentityOperandSchema }),
  strict({ kind: z.literal('effective-instance'), instance: gameplayIdentityOperandSchema }),
]);

export type GameplayCommand =
  | {
      id: string;
      kind: 'set-global-property';
      variable: z.infer<typeof variableRefSchema>;
      value: z.infer<typeof runtimeScalarSchema>;
    }
  | { id: string; kind: 'unset-global-property'; variable: z.infer<typeof variableRefSchema> }
  | {
      id: string;
      kind: 'set-property';
      owner: z.infer<typeof gameplayIdentityOperandSchema>;
      propertyId: string;
      value: z.infer<typeof runtimeScalarSchema>;
    }
  | {
      id: string;
      kind: 'unset-property';
      owner: z.infer<typeof gameplayIdentityOperandSchema>;
      propertyId: string;
    }
  | {
      id: string;
      kind: 'add-trait';
      owner: z.infer<typeof gameplayIdentityOperandSchema>;
      trait: z.infer<typeof traitRefSchema>;
    }
  | {
      id: string;
      kind: 'remove-trait';
      owner: z.infer<typeof gameplayIdentityOperandSchema>;
      trait: z.infer<typeof traitRefSchema>;
    }
  | {
      id: string;
      kind: 'set-enabled';
      subject: z.infer<typeof locationSubjectOperandSchema>;
      enabled: boolean;
    }
  | {
      id: string;
      kind: 'set-visible';
      subject: z.infer<typeof locationSubjectOperandSchema>;
      visible: boolean;
    }
  | {
      id: string;
      kind: 'move-instance';
      subject: z.infer<typeof locationSubjectOperandSchema>;
      location: z.infer<typeof locationOperandSchema>;
    }
  | {
      id: string;
      kind: 'create-room';
      source: z.infer<typeof gameplayConfigurationSourceSchema>;
      result?: string;
    }
  | {
      id: string;
      kind: 'create-character';
      source: z.infer<typeof gameplayConfigurationSourceSchema>;
      location: z.infer<typeof locationOperandSchema>;
      enabled: boolean;
      visible: boolean;
      result?: string;
    }
  | {
      id: string;
      kind: 'create-interactable';
      source: z.infer<typeof gameplayConfigurationSourceSchema>;
      location: z.infer<typeof locationOperandSchema>;
      enabled: boolean;
      visible: boolean;
      result?: string;
    }
  | {
      id: string;
      kind: 'destroy-instance';
      instance: z.infer<typeof gameplayIdentityOperandSchema>;
    }
  | {
      id: string;
      kind: 'split-quantity';
      source: z.infer<typeof interactableOperandSchema>;
      quantity: number;
      result?: string;
    }
  | {
      id: string;
      kind: 'merge-quantity';
      receiver: z.infer<typeof interactableOperandSchema>;
      donor: z.infer<typeof interactableOperandSchema>;
    }
  | {
      id: string;
      kind: 'transfer-quantity';
      mode: 'exact';
      source: z.infer<typeof interactableOperandSchema>;
      quantity: number;
      location: z.infer<typeof locationOperandSchema>;
      result?: string;
    }
  | {
      id: string;
      kind: 'transfer-quantity';
      mode: 'aggregate';
      matcher: z.infer<typeof interactableMatcherSchema>;
      sourceInventory?: z.infer<typeof inventoryOperandSchema>;
      quantity: number;
      location: z.infer<typeof locationOperandSchema>;
    }
  | {
      id: string;
      kind: 'add-quantity';
      definition: z.infer<typeof interactableRefSchema>;
      quantity: number;
      location: z.infer<typeof locationOperandSchema>;
    }
  | {
      id: string;
      kind: 'consume-quantity';
      mode: 'exact';
      source: z.infer<typeof interactableOperandSchema>;
      quantity: number;
    }
  | {
      id: string;
      kind: 'consume-quantity';
      mode: 'aggregate';
      matcher: z.infer<typeof interactableMatcherSchema>;
      sourceInventory?: z.infer<typeof inventoryOperandSchema>;
      quantity: number;
    }
  | {
      id: string;
      kind: 'present-inventory';
      inventory: z.infer<typeof inventoryOperandSchema>;
      layout?: z.infer<typeof layoutRefSchema>;
    }
  | { id: string; kind: 'call-scene'; scene: z.infer<typeof sceneRefSchema> }
  | { id: string; kind: 'call-dialogue'; dialogue: z.infer<typeof dialogueRefSchema> }
  | { id: string; kind: 'notify'; message: z.infer<typeof textContentSchema> }
  | { id: string; kind: 'run-lua'; source: string }
  | {
      id: string;
      kind: 'if';
      condition: Condition;
      then: GameplayCommand[];
      else: GameplayCommand[];
    };

const quantitySchema = z.number().int().positive().safe();
export const gameplayCommandSchema: z.ZodType<GameplayCommand> = z.lazy(() =>
  z.union([
    strict({
      id: entityIdSchema,
      kind: z.literal('set-global-property'),
      variable: variableRefSchema,
      value: runtimeScalarSchema,
    }),
    strict({
      id: entityIdSchema,
      kind: z.literal('unset-global-property'),
      variable: variableRefSchema,
    }),
    strict({
      id: entityIdSchema,
      kind: z.literal('set-property'),
      owner: gameplayIdentityOperandSchema,
      propertyId: entityIdSchema,
      value: runtimeScalarSchema,
    }),
    strict({
      id: entityIdSchema,
      kind: z.literal('unset-property'),
      owner: gameplayIdentityOperandSchema,
      propertyId: entityIdSchema,
    }),
    strict({
      id: entityIdSchema,
      kind: z.literal('add-trait'),
      owner: gameplayIdentityOperandSchema,
      trait: traitRefSchema,
    }),
    strict({
      id: entityIdSchema,
      kind: z.literal('remove-trait'),
      owner: gameplayIdentityOperandSchema,
      trait: traitRefSchema,
    }),
    strict({
      id: entityIdSchema,
      kind: z.literal('set-enabled'),
      subject: locationSubjectOperandSchema,
      enabled: z.boolean(),
    }),
    strict({
      id: entityIdSchema,
      kind: z.literal('set-visible'),
      subject: locationSubjectOperandSchema,
      visible: z.boolean(),
    }),
    strict({
      id: entityIdSchema,
      kind: z.literal('move-instance'),
      subject: locationSubjectOperandSchema,
      location: locationOperandSchema,
    }),
    strict({
      id: entityIdSchema,
      kind: z.literal('create-room'),
      source: gameplayConfigurationSourceSchema,
      result: entityIdSchema.optional(),
    }),
    strict({
      id: entityIdSchema,
      kind: z.literal('create-character'),
      source: gameplayConfigurationSourceSchema,
      location: locationOperandSchema,
      enabled: z.boolean(),
      visible: z.boolean(),
      result: entityIdSchema.optional(),
    }),
    strict({
      id: entityIdSchema,
      kind: z.literal('create-interactable'),
      source: gameplayConfigurationSourceSchema,
      location: locationOperandSchema,
      enabled: z.boolean(),
      visible: z.boolean(),
      result: entityIdSchema.optional(),
    }),
    strict({
      id: entityIdSchema,
      kind: z.literal('destroy-instance'),
      instance: gameplayIdentityOperandSchema,
    }),
    strict({
      id: entityIdSchema,
      kind: z.literal('split-quantity'),
      source: interactableOperandSchema,
      quantity: quantitySchema,
      result: entityIdSchema.optional(),
    }),
    strict({
      id: entityIdSchema,
      kind: z.literal('merge-quantity'),
      receiver: interactableOperandSchema,
      donor: interactableOperandSchema,
    }),
    strict({
      id: entityIdSchema,
      kind: z.literal('transfer-quantity'),
      mode: z.literal('exact'),
      source: interactableOperandSchema,
      quantity: quantitySchema,
      location: locationOperandSchema,
      result: entityIdSchema.optional(),
    }),
    strict({
      id: entityIdSchema,
      kind: z.literal('transfer-quantity'),
      mode: z.literal('aggregate'),
      matcher: interactableMatcherSchema,
      sourceInventory: inventoryOperandSchema.optional(),
      quantity: quantitySchema,
      location: locationOperandSchema,
    }),
    strict({
      id: entityIdSchema,
      kind: z.literal('add-quantity'),
      definition: interactableRefSchema,
      quantity: quantitySchema,
      location: locationOperandSchema,
    }),
    strict({
      id: entityIdSchema,
      kind: z.literal('consume-quantity'),
      mode: z.literal('exact'),
      source: interactableOperandSchema,
      quantity: quantitySchema,
    }),
    strict({
      id: entityIdSchema,
      kind: z.literal('consume-quantity'),
      mode: z.literal('aggregate'),
      matcher: interactableMatcherSchema,
      sourceInventory: inventoryOperandSchema.optional(),
      quantity: quantitySchema,
    }),
    strict({
      id: entityIdSchema,
      kind: z.literal('present-inventory'),
      inventory: inventoryOperandSchema,
      layout: layoutRefSchema.optional(),
    }),
    strict({ id: entityIdSchema, kind: z.literal('call-scene'), scene: sceneRefSchema }),
    strict({ id: entityIdSchema, kind: z.literal('call-dialogue'), dialogue: dialogueRefSchema }),
    strict({ id: entityIdSchema, kind: z.literal('notify'), message: textContentSchema }),
    strict({ id: entityIdSchema, kind: z.literal('run-lua'), source: z.string().min(1) }),
    strict({
      id: entityIdSchema,
      kind: z.literal('if'),
      condition: conditionSchema,
      // oxlint-disable-next-line unicorn/no-thenable -- `then` is the canonical Gameplay Command authoring field.
      then: z.array(gameplayCommandSchema),
      else: z.array(gameplayCommandSchema),
    }),
  ]),
);

export type AssetRef = z.infer<typeof assetRefSchema>;
export type ArchetypeRef = z.infer<typeof archetypeRefSchema>;
export type MaterialRef = z.infer<typeof materialRefSchema>;
export type CharacterRef = z.infer<typeof characterRefSchema>;
export type DialogueRef = z.infer<typeof dialogueRefSchema>;
export type LayoutRef = z.infer<typeof layoutRefSchema>;
export type VariableRef = z.infer<typeof variableRefSchema>;
export type RoomRef = z.infer<typeof roomRefSchema>;
export type SceneRef = z.infer<typeof sceneRefSchema>;
export type ScriptRef = z.infer<typeof scriptRefSchema>;
export type InteractableRef = z.infer<typeof interactableRefSchema>;
export type VerbRef = z.infer<typeof verbRefSchema>;
export type TraitRef = z.infer<typeof traitRefSchema>;
export type InteractableInstanceRef = z.infer<typeof interactableInstanceRefSchema>;
export type InventoryOwner = z.infer<typeof inventoryOwnerSchema>;
export type InventoryReference = z.infer<typeof inventoryReferenceSchema>;
export type GameplayIdentityOperand = z.infer<typeof gameplayIdentityOperandSchema>;
export type InteractableOperand = z.infer<typeof interactableOperandSchema>;
export type LocationSubjectOperand = z.infer<typeof locationSubjectOperandSchema>;
export type RoomOperand = z.infer<typeof roomOperandSchema>;
export type InventoryOwnerOperand = z.infer<typeof inventoryOwnerOperandSchema>;
export type InventoryOperand = z.infer<typeof inventoryOperandSchema>;
export type LocationOperand = z.infer<typeof locationOperandSchema>;
export type InteractableMatcher = z.infer<typeof interactableMatcherSchema>;
export type RuntimeScalar = z.infer<typeof runtimeScalarSchema>;
export type FlowTarget = z.infer<typeof flowTargetSchema>;
export type TextSource = z.infer<typeof textSourceSchema>;
export type TextContent = z.infer<typeof textContentSchema>;
export type Effect = z.infer<typeof effectSchema>;
export type GameplayConfigurationSource = z.infer<typeof gameplayConfigurationSourceSchema>;

export const inlineTextContent = (
  text = '',
  markup: TextContent['markup'] = 'active-text',
): TextContent => ({
  source: { kind: 'inline', text },
  markup,
});
