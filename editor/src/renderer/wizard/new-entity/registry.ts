import {
  authoringCollectionKeys,
  type AuthoringCollectionKey,
} from '../../../shared/project-schema/authoring-collections';
import { metadataWizardDefinitions } from './types/metadata';
import { typedWizardDefinitions } from './types/typed';
import type { NewEntityWizardTypeDefinition } from './types/common';

export const newEntityWizardExcludedCollections = ['assets', 'variables', 'tests'] as const satisfies readonly AuthoringCollectionKey[];

const excludedWizardCollections = new Set<AuthoringCollectionKey>(newEntityWizardExcludedCollections);

export const newEntityWizardCollectionKeys = authoringCollectionKeys.filter(
  (collection) => !excludedWizardCollections.has(collection),
);

export const newEntityWizardDefinitions = [
  ...typedWizardDefinitions,
  ...metadataWizardDefinitions,
]
  .filter((definition) => !excludedWizardCollections.has(definition.collection))
  .sort((left, right) => authoringCollectionKeys.indexOf(left.collection) - authoringCollectionKeys.indexOf(right.collection));

export const newEntityWizardDefinitionByCollection: Partial<Record<AuthoringCollectionKey, NewEntityWizardTypeDefinition>> = Object.fromEntries(
  newEntityWizardDefinitions.map((definition) => [definition.collection, definition]),
) as Partial<Record<AuthoringCollectionKey, NewEntityWizardTypeDefinition>>;

export function isNewEntityWizardCollection(collection: AuthoringCollectionKey) {
  return Boolean(newEntityWizardDefinitionByCollection[collection]);
}

export function defaultNewEntityWizardCollection(): AuthoringCollectionKey {
  if (newEntityWizardDefinitionByCollection.rooms) return 'rooms';
  return newEntityWizardDefinitions[0]?.collection ?? 'rooms';
}

export function newEntityWizardDefinition(collection: AuthoringCollectionKey): NewEntityWizardTypeDefinition {
  const definition = newEntityWizardDefinitionByCollection[collection];
  if (!definition) throw new Error(`No new entity wizard definition for collection: ${collection}`);
  return definition;
}

export function assertNewEntityWizardCoverage(): AuthoringCollectionKey[] {
  return newEntityWizardCollectionKeys.filter((collection) => !newEntityWizardDefinitionByCollection[collection]);
}
