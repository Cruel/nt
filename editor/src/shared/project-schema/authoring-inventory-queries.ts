import { resolveGameplayInstanceRecord } from './authoring-archetypes';
import { parseCharacterData } from './authoring-characters';
import { parseInteractableData } from './authoring-interactables';
import type { InventoryReferenceData } from './authoring-inventories';
import type { AuthoringProject } from './authoring-project';
import { parseRoomData } from './authoring-rooms';

export interface AuthoringInventoryOption {
  key: string;
  label: string;
  reference: InventoryReferenceData;
}

function inventoryKey(reference: InventoryReferenceData): string {
  const owner = reference.owner;
  if (owner.kind === 'project') return `project:${reference.inventoryId}`;
  if (owner.kind === 'character')
    return `character:${owner.character.$ref.id}:${reference.inventoryId}`;
  if (owner.kind === 'interactable')
    return `interactable:${owner.interactable.$ref.id}:${reference.inventoryId}`;
  if (owner.kind === 'room-feature')
    return `room-feature:${owner.room.$ref.id}:${owner.featureId}:${reference.inventoryId}`;
  return `interactable-feature:${owner.interactable.$ref.id}:${owner.featureId}:${reference.inventoryId}`;
}

export function authoringInventoryKey(reference: InventoryReferenceData): string {
  return inventoryKey(reference);
}

export function enumerateAuthoringInventories(
  project: AuthoringProject,
): AuthoringInventoryOption[] {
  const values: AuthoringInventoryOption[] = project.inventories.map((inventory) => {
    const reference: InventoryReferenceData = {
      owner: { kind: 'project' },
      inventoryId: inventory.id,
    };
    return { key: inventoryKey(reference), label: `Project / ${inventory.label}`, reference };
  });

  for (const [id, record] of Object.entries(project.characters)) {
    const effective = resolveGameplayInstanceRecord(project, 'character', record);
    const data = parseCharacterData(effective?.data);
    if (!data) continue;
    for (const inventory of data.inventories) {
      const reference: InventoryReferenceData = {
        owner: {
          kind: 'character',
          character: { $ref: { collection: 'characters', id } },
        },
        inventoryId: inventory.id,
      };
      values.push({
        key: inventoryKey(reference),
        label: `${record.label} / ${inventory.label}`,
        reference,
      });
    }
  }

  for (const [id, record] of Object.entries(project.rooms)) {
    const effective = resolveGameplayInstanceRecord(project, 'room', record);
    const data = parseRoomData(effective?.data);
    if (!data) continue;
    for (const feature of data.features) {
      for (const inventory of feature.inventories) {
        const reference: InventoryReferenceData = {
          owner: {
            kind: 'room-feature',
            room: { $ref: { collection: 'rooms', id } },
            featureId: feature.id,
          },
          inventoryId: inventory.id,
        };
        values.push({
          key: inventoryKey(reference),
          label: `${record.label} / ${feature.label} / ${inventory.label}`,
          reference,
        });
      }
    }
  }

  for (const [instanceId, instance] of Object.entries(project.interactableInstances)) {
    const definitionId = instance.definition.$ref.id;
    const record = project.interactables[definitionId];
    if (!record) continue;
    const effective = resolveGameplayInstanceRecord(project, 'interactable', record);
    const data = parseInteractableData(effective?.data);
    if (!data) continue;
    const instanceLabel = instance.editorLabel ?? instanceId;
    for (const inventory of data.inventories) {
      const reference: InventoryReferenceData = {
        owner: {
          kind: 'interactable',
          interactable: { $ref: { registry: 'interactableInstances', id: instanceId } },
        },
        inventoryId: inventory.id,
      };
      values.push({
        key: inventoryKey(reference),
        label: `${instanceLabel} (${record.label}) / ${inventory.label}`,
        reference,
      });
    }
    for (const feature of data.features) {
      for (const inventory of feature.inventories) {
        const reference: InventoryReferenceData = {
          owner: {
            kind: 'interactable-feature',
            interactable: { $ref: { registry: 'interactableInstances', id: instanceId } },
            featureId: feature.id,
          },
          inventoryId: inventory.id,
        };
        values.push({
          key: inventoryKey(reference),
          label: `${instanceLabel} (${record.label}) / ${feature.label} / ${inventory.label}`,
          reference,
        });
      }
    }
  }

  return values.sort((left, right) => left.key.localeCompare(right.key));
}
