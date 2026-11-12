import { buildJsonPointer, parseJsonPointer } from '@/project/json-pointer';
import type { JsonValue } from '@/project/json-value';
import { isAuthoringProjectView } from '../../shared/project-schema/authoring-project-view';
import { PROJECT_INVENTORY_ID } from '../../shared/project-schema/authoring-inventories';
import { resolveGameplayInstanceRecord } from '../../shared/project-schema/authoring-archetypes';
import { parseRoomData } from '../../shared/project-schema/authoring-rooms';
import {
  PROJECT_SETTINGS_OWNED_PATHS,
  PROJECT_SETTINGS_SAVE_UNIT_ID,
  RECORD_SAVE_UNIT_COLLECTIONS,
  recordSaveUnitId,
} from '@/project/save-unit-registry';

/** A field owner is independent of the tab currently presenting it. */
export interface ProjectFieldIdentity {
  readonly projectSessionId: string;
  readonly projectInstanceId: string;
  readonly saveUnitId: string;
  readonly path: string;
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** Only stable, explicitly owned JSON fields can use the scalar draft scheduler.
 * Array positions and multi-owner operations require semantic commands instead. */
export function fieldSaveUnitForPath(path: string): string | null {
  const segments = parseJsonPointer(path);
  if (!segments.length || segments.some((segment) => /^(0|[1-9]\d*)$/u.test(segment))) return null;
  if (PROJECT_SETTINGS_OWNED_PATHS.some((root) => under(path, root)))
    return PROJECT_SETTINGS_SAVE_UNIT_ID;
  if (
    segments[0] === 'editor' &&
    segments[1] === 'recordMetadata' &&
    segments.length >= 4 &&
    RECORD_SAVE_UNIT_COLLECTIONS.has(segments[2]!)
  )
    return recordSaveUnitId(segments[2]!, segments[3]!);
  if (segments.length >= 3 && RECORD_SAVE_UNIT_COLLECTIONS.has(segments[0]!))
    return recordSaveUnitId(segments[0]!, segments[1]!);
  return null;
}

export function resolveProjectFieldIdentity(input: ProjectFieldIdentity): ProjectFieldIdentity {
  if (!input.projectSessionId || !input.projectInstanceId || !input.saveUnitId)
    throw new Error('A Project field requires an active Project and logical Save owner.');
  const canonicalPath = buildJsonPointer(parseJsonPointer(input.path));
  if (canonicalPath !== input.path)
    throw new Error(`Noncanonical Project field path: ${input.path}`);
  const expectedOwner = fieldSaveUnitForPath(canonicalPath);
  if (!expectedOwner || expectedOwner !== input.saveUnitId)
    throw new Error(`Project field '${canonicalPath}' does not belong to '${input.saveUnitId}'.`);
  return { ...input, path: canonicalPath };
}

/** The registry is not a Save unit. An exact Instance field can only be
 * edited by a concrete Room which contains it, or its Definition editor.
 * This is deliberately separate from fieldSaveUnitForPath: ordinary record
 * fields must never gain a general /interactableInstances ownership bypass. */
export function resolveExactInstanceFieldIdentity(
  input: ProjectFieldIdentity,
  document: JsonValue | null,
): ProjectFieldIdentity {
  if (!input.projectSessionId || !input.projectInstanceId || !input.saveUnitId)
    throw new Error('An exact Instance edit requires an active Project and Save owner.');
  const segments = parseJsonPointer(input.path);
  if (
    buildJsonPointer(segments) !== input.path ||
    segments[0] !== 'interactableInstances' ||
    segments.length !== 3 ||
    segments.some((segment) => /^(0|[1-9]\d*)$/u.test(segment)) ||
    ![
      'editorLabel',
      'quantity',
      'location',
      'materialApplication',
      'localProperties',
      'traits',
      'featureOverrides',
    ].includes(segments[2]!)
  )
    throw new Error(`Invalid exact Interactable Instance field: ${input.path}`);
  if (!isAuthoringProjectView(document))
    throw new Error('No valid Project is open for this exact Instance edit.');
  const instance = document.interactableInstances[segments[1]!];
  if (!instance) throw new Error('The exact Interactable Instance no longer exists.');
  const owner = input.saveUnitId;
  // Project Settings owns its embedded starting Inventory. This is not a
  // general registry Save unit: only items currently in that Inventory can
  // author its location or quantity here.
  if (
    owner === PROJECT_SETTINGS_SAVE_UNIT_ID &&
    (segments[2] === 'location' || segments[2] === 'quantity') &&
    instance.location.kind === 'inventory' &&
    instance.location.inventory.owner.kind === 'project' &&
    instance.location.inventory.inventoryId === PROJECT_INVENTORY_ID
  )
    return input;
  const definitionOwner = recordSaveUnitId('interactables', instance.definition.$ref.id);
  if (owner === definitionOwner && document.interactables[instance.definition.$ref.id])
    return input;
  for (const [roomId, record] of Object.entries(document.rooms)) {
    if (owner !== recordSaveUnitId('rooms', roomId)) continue;
    const effective = resolveGameplayInstanceRecord(document, 'room', record);
    const data = parseRoomData(effective?.data);
    if (data?.interactables.some((item) => item.interactable.$ref.id === segments[1])) return input;
  }
  throw new Error(`Exact Instance '${segments[1]}' is not editable from '${owner}'.`);
}
