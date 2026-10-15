import type { TestExpectationType, TestInputType } from './authoring-tests';

/** Source-only requirements. Normalized defaults initialize editor forms, not Test commands. */
export const testSourceStepPayloads: Partial<
  Record<TestInputType, { readonly key: string; readonly fields: readonly string[] }>
> = {
  'dialogue-choice': { key: 'dialogueChoice', fields: ['edgeId'] },
  'scene-choice': { key: 'sceneChoice', fields: ['optionId'] },
  navigate: { key: 'navigate', fields: ['exitId'] },
  'ui-click': { key: 'uiClick', fields: ['selector'] },
  save: { key: 'saveSlot', fields: ['slotId'] },
  load: { key: 'saveSlot', fields: ['slotId'] },
  'run-interaction': { key: 'runInteraction', fields: ['verb', 'bindings'] },
  'primary-activate': { key: 'subjectAction', fields: ['subject'] },
  'open-verb-menu': { key: 'subjectAction', fields: ['subject'] },
};

export const testSourceExpectationPayloads: Record<
  TestExpectationType,
  { readonly key: string; readonly fields: readonly string[] }
> = {
  property: { key: 'property', fields: ['scope', 'propertyId'] },
  'current-room': { key: 'currentRoom', fields: ['roomId'] },
  location: { key: 'location', fields: ['entityKind', 'entityId', 'locationKind'] },
  quantity: { key: 'quantity', fields: ['interactableId'] },
  trait: { key: 'trait', fields: ['ownerKind', 'ownerId', 'traitId'] },
  'entity-state': { key: 'entityState', fields: ['entityKind', 'entityId', 'field'] },
  'active-flow': { key: 'activeFlow', fields: ['kind', 'flowId'] },
  layout: { key: 'layout', fields: ['layoutId', 'field'] },
  'ui-element': { key: 'uiElement', fields: ['selector', 'field'] },
  event: { key: 'event', fields: ['kind'] },
  diagnostic: { key: 'diagnostic', fields: ['code'] },
};

export const testSourceComparisonOperators = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const;
export const testSourceValueExpectations = [
  'property',
  'quantity',
  'entity-state',
  'event',
] as const;
