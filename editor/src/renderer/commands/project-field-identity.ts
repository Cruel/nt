import { buildJsonPointer, parseJsonPointer } from '@/project/json-pointer';
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
