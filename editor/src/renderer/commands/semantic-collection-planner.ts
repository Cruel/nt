import { jsonValuesEqual, isJsonObject, type JsonValue } from '@/project/json-value';

/** List controls address items by a semantic ID, never a stale JSON Pointer index.
 * The operation resolves its index against the latest native acknowledgment. */
export type SemanticCollectionOperation =
  | { kind: 'replace'; id: string; before: JsonValue; after: JsonValue }
  | { kind: 'insert'; item: JsonValue; beforeId?: string }
  | { kind: 'remove'; id: string; before: JsonValue }
  | { kind: 'move'; id: string; beforeId?: string };

function idOf(item: JsonValue): string {
  if (!isJsonObject(item) || typeof item.id !== 'string' || !item.id)
    throw new Error('Semantic collection items must have a nonempty string ID.');
  return item.id;
}

export function applySemanticCollectionOperation(
  latest: JsonValue,
  action: SemanticCollectionOperation,
): JsonValue[] {
  if (!Array.isArray(latest)) throw new Error('Semantic operation target is not a collection.');
  const next = [...latest];
  const ids = next.map(idOf);
  if (new Set(ids).size !== ids.length)
    throw new Error('Semantic collection has duplicate item IDs.');
  const id = action.kind === 'insert' ? idOf(action.item) : action.id;
  const index = ids.indexOf(id);
  if (action.kind === 'insert') {
    if (index !== -1) throw new Error(`Collection item '${id}' already exists.`);
    const before = action.beforeId === undefined ? next.length : ids.indexOf(action.beforeId);
    if (before === -1) throw new Error(`Collection anchor '${action.beforeId}' was removed.`);
    next.splice(before, 0, action.item);
  } else {
    if (index === -1) throw new Error(`Collection item '${id}' was removed.`);
    if (action.kind === 'replace' || action.kind === 'remove') {
      if (idOf(action.before) !== id || !jsonValuesEqual(next[index], action.before))
        throw new Error(`Collection item '${id}' changed before this edit was applied.`);
      if (action.kind === 'replace') {
        const newId = idOf(action.after);
        if (newId !== id && ids.includes(newId))
          throw new Error(`Collection item '${newId}' already exists.`);
        next[index] = action.after;
      } else next.splice(index, 1);
    } else {
      if (action.beforeId === id) return next;
      const anchor = action.beforeId;
      if (anchor !== undefined && !ids.includes(anchor))
        throw new Error(`Collection anchor '${anchor}' was removed.`);
      const [item] = next.splice(index, 1);
      const before =
        anchor === undefined
          ? next.length
          : next.findIndex((candidate) => idOf(candidate) === anchor);
      next.splice(before, 0, item!);
    }
  }
  return next;
}
