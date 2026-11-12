import { buildJsonPointer, parseJsonPointer } from '../project/json-pointer';
import { jsonValuesEqual, type JsonValue } from '../project/json-value';
import type { JsonPatchOperation } from '../project/json-patch';

/** Emit native leaf patches rather than serializing the normalized form of an
 * untouched sibling. Existing YAML can have abbreviated references/defaults;
 * replacing the whole normalized array changes their source representation
 * and can fail the native Save projection preflight. Numeric indices are
 * derived only at command dispatch, never used as optimistic field identity. */
export function nativeFieldJsonPatches(
  before: JsonValue,
  after: JsonValue,
  path: string,
): JsonPatchOperation[] {
  if (jsonValuesEqual(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    const oldIds = before.map(memberId);
    const newIds = after.map(memberId);
    if (
      oldIds.every(Boolean) &&
      newIds.every(Boolean) &&
      new Set(oldIds).size === oldIds.length &&
      new Set(newIds).size === newIds.length
    ) {
      const commonBefore = oldIds.filter((id) => newIds.includes(id));
      const commonAfter = newIds.filter((id) => oldIds.includes(id));
      // A same-length membership change may be a rename. Removing and
      // re-inserting a normalized member would persist expanded shorthand
      // references and fail the native sparse-YAML Save projection. Such
      // replacements use the index-relative leaf-diff transaction below.
      if (
        (before.length !== after.length || oldIds.every((id, i) => id === newIds[i])) &&
        commonBefore.every((id, i) => id === commonAfter[i])
      ) {
        const patches: JsonPatchOperation[] = [];
        const kept = new Set(newIds);
        for (let index = before.length - 1; index >= 0; index--)
          if (!kept.has(oldIds[index])) patches.push({ op: 'remove', path: `${path}/${index}` });
        let ids = oldIds.filter((id) => kept.has(id));
        for (let index = 0; index < after.length; index++) {
          const id = newIds[index]!;
          if (!ids.includes(id)) {
            patches.push({ op: 'add', path: `${path}/${index}`, value: after[index]! });
            ids = [...ids.slice(0, index), id, ...ids.slice(index)];
          } else {
            const originalIndex = oldIds.indexOf(id);
            patches.push(
              ...nativeFieldJsonPatches(before[originalIndex]!, after[index]!, `${path}/${index}`),
            );
          }
        }
        return patches;
      }
    }
    // Reorder/identity changes are submitted in one native patch transaction.
    // Updating their positional leaves (including IDs) preserves sparse YAML
    // shorthand: a replacement of the entire normalized array does not.
    const patches: JsonPatchOperation[] = [];
    const overlap = Math.min(before.length, after.length);
    for (let index = 0; index < overlap; index++)
      patches.push(...nativeFieldJsonPatches(before[index]!, after[index]!, `${path}/${index}`));
    for (let index = before.length - 1; index >= after.length; index--)
      patches.push({ op: 'remove', path: `${path}/${index}` });
    for (let index = before.length; index < after.length; index++)
      patches.push({ op: 'add', path: `${path}/${index}`, value: after[index]! });
    return patches;
  }
  if (
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const old = before as Record<string, JsonValue>;
    const next = after as Record<string, JsonValue>;
    const patches: JsonPatchOperation[] = [];
    for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
      const child = buildJsonPointer([...parseJsonPointer(path), key]);
      if (!(key in next)) patches.push({ op: 'remove', path: child });
      else if (!(key in old)) patches.push({ op: 'add', path: child, value: next[key]! });
      else patches.push(...nativeFieldJsonPatches(old[key]!, next[key]!, child));
    }
    return patches;
  }
  return [{ op: 'replace', path, value: after }];
}

function memberId(item: unknown): string | null {
  return item &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    typeof (item as { id?: unknown }).id === 'string'
    ? (item as { id: string }).id
    : null;
}
