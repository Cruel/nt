import { resolveGameplayInstanceRecord } from './authoring-archetypes';
import { parseCharacterData } from './authoring-characters';
import { parseInteractableData, type InteractableInstanceData } from './authoring-interactables';
import type { InventoryReferenceData } from './authoring-inventories';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';
import { parseRoomData } from './authoring-rooms';

export interface InventorySchemaDiagnostic {
  severity: 'error';
  path: string;
  message: string;
  category: 'Inventories';
  code: string;
}

const diagnostic = (path: string, message: string, code: string): InventorySchemaDiagnostic => ({
  severity: 'error',
  path,
  message,
  category: 'Inventories',
  code,
});

function escapePathSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function effectiveRecord(
  project: AuthoringProject,
  kind: 'character' | 'interactable' | 'room',
  record: AuthoringRecordBase | undefined,
): AuthoringRecordBase | null {
  return record ? resolveGameplayInstanceRecord(project, kind, record) : null;
}

function inventoryIds(inventories: readonly { id: string }[]): Set<string> {
  return new Set(inventories.map((inventory) => inventory.id));
}

function targetInventoryIds(
  project: AuthoringProject,
  reference: InventoryReferenceData,
): { ids: Set<string> | null; ownerError?: string } {
  const owner = reference.owner;
  if (owner.kind === 'project') return { ids: inventoryIds(project.inventories) };

  if (owner.kind === 'character') {
    const id = owner.character.$ref.id;
    const record = effectiveRecord(project, 'character', project.characters[id]);
    const data = record ? parseCharacterData(record.data) : null;
    return data
      ? { ids: inventoryIds(data.inventories) }
      : { ids: null, ownerError: `Character inventory owner '${id}' does not exist.` };
  }

  if (owner.kind === 'interactable') {
    const id = owner.interactable.$ref.id;
    const record = effectiveRecord(project, 'interactable', project.interactables[id]);
    const data = record ? parseInteractableData(record.data) : null;
    return data
      ? { ids: inventoryIds(data.inventories) }
      : { ids: null, ownerError: `Interactable inventory owner '${id}' does not exist.` };
  }

  if (owner.kind === 'room-feature') {
    const roomId = owner.room.$ref.id;
    const record = effectiveRecord(project, 'room', project.rooms[roomId]);
    const room = record ? parseRoomData(record.data) : null;
    const feature = room?.features.find((candidate) => candidate.id === owner.featureId);
    return feature
      ? { ids: inventoryIds(feature.inventories) }
      : {
          ids: null,
          ownerError: `Room Feature inventory owner '${roomId}.${owner.featureId}' does not exist.`,
        };
  }

  const interactableId = owner.interactable.$ref.id;
  const record = effectiveRecord(project, 'interactable', project.interactables[interactableId]);
  const interactable = record ? parseInteractableData(record.data) : null;
  const feature = interactable?.features.find((candidate) => candidate.id === owner.featureId);
  return feature
    ? { ids: inventoryIds(feature.inventories) }
    : {
        ids: null,
        ownerError: `Interactable Feature inventory owner '${interactableId}.${owner.featureId}' does not exist.`,
      };
}

export function validateInventoryReference(
  project: AuthoringProject,
  reference: InventoryReferenceData,
  path: string,
): InventorySchemaDiagnostic[] {
  const target = targetInventoryIds(project, reference);
  if (!target.ids)
    return [
      diagnostic(
        `${path}/owner`,
        target.ownerError ?? 'Inventory owner does not exist.',
        'authoring.inventory.owner-missing',
      ),
    ];
  if (!target.ids.has(reference.inventoryId))
    return [
      diagnostic(
        `${path}/inventoryId`,
        `Inventory '${reference.inventoryId}' does not exist on the selected owner.`,
        'authoring.inventory.missing',
      ),
    ];
  return [];
}

function validateInventoryIds(
  inventories: readonly { id: string }[],
  path: string,
  diagnostics: InventorySchemaDiagnostic[],
) {
  const seen = new Set<string>();
  inventories.forEach((inventory, index) => {
    if (seen.has(inventory.id))
      diagnostics.push(
        diagnostic(
          `${path}/${index}/id`,
          `Duplicate Inventory ID '${inventory.id}' on the same owner.`,
          'authoring.inventory.duplicate-id',
        ),
      );
    seen.add(inventory.id);
  });
}

function validateFeatureInventoryIds(
  features: readonly { id: string; inventories: readonly { id: string }[] }[],
  path: string,
  diagnostics: InventorySchemaDiagnostic[],
) {
  features.forEach((feature, index) =>
    validateInventoryIds(feature.inventories, `${path}/${index}/inventories`, diagnostics),
  );
}

function owningInteractable(reference: InventoryReferenceData): string | null {
  if (reference.owner.kind === 'interactable') return reference.owner.interactable.$ref.id;
  if (reference.owner.kind === 'interactable-feature') return reference.owner.interactable.$ref.id;
  return null;
}

export function validateAuthoringInventories(
  project: AuthoringProject,
): InventorySchemaDiagnostic[] {
  const diagnostics: InventorySchemaDiagnostic[] = [];
  validateInventoryIds(project.inventories, '/inventories', diagnostics);

  const interactableLocations = new Map<string, InteractableInstanceData['location']>();

  for (const [id, rawRecord] of Object.entries(project.characters)) {
    const record = effectiveRecord(project, 'character', rawRecord);
    const data = record ? parseCharacterData(record.data) : null;
    if (!data) continue;
    const base = `/characters/${escapePathSegment(id)}/data`;
    validateInventoryIds(data.inventories, `${base}/inventories`, diagnostics);
  }

  for (const [id, rawRecord] of Object.entries(project.rooms)) {
    const record = effectiveRecord(project, 'room', rawRecord);
    const data = record ? parseRoomData(record.data) : null;
    if (!data) continue;
    validateFeatureInventoryIds(
      data.features,
      `/rooms/${escapePathSegment(id)}/data/features`,
      diagnostics,
    );
  }

  for (const [id, rawRecord] of Object.entries(project.interactables)) {
    const record = effectiveRecord(project, 'interactable', rawRecord);
    const data = record ? parseInteractableData(record.data) : null;
    if (!data) continue;
    const base = `/interactables/${escapePathSegment(id)}/data`;
    validateInventoryIds(data.inventories, `${base}/inventories`, diagnostics);
    validateFeatureInventoryIds(data.features, `${base}/features`, diagnostics);
  }

  for (const [id, instance] of Object.entries(project.interactableInstances)) {
    const base = `/interactableInstances/${escapePathSegment(id)}`;
    interactableLocations.set(id, instance.location);
    if (instance.location.kind === 'inventory')
      diagnostics.push(
        ...validateInventoryReference(
          project,
          instance.location.inventory,
          `${base}/location/inventory`,
        ),
      );
  }

  for (const [id, location] of interactableLocations) {
    if (location.kind !== 'inventory') continue;
    const visited = new Set<string>([id]);
    let currentReference: InventoryReferenceData | null = location.inventory;
    while (currentReference) {
      const ownerId = owningInteractable(currentReference);
      if (!ownerId) break;
      if (visited.has(ownerId)) {
        diagnostics.push(
          diagnostic(
            `/interactableInstances/${escapePathSegment(id)}/location/inventory`,
            `Inventory containment cycle reaches Interactable '${ownerId}'.`,
            'authoring.inventory.containment-cycle',
          ),
        );
        break;
      }
      visited.add(ownerId);
      const ownerLocation = interactableLocations.get(ownerId);
      currentReference = ownerLocation?.kind === 'inventory' ? ownerLocation.inventory : null;
    }
  }

  return diagnostics;
}
