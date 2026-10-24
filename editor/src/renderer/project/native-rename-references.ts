import type { NativeSemanticGraph } from '../../main/services/native-authoring-worker-contract';
import type { ReferenceTarget } from '../../shared/project-schema/authoring-project';
import { getJsonAtPointer, hasJsonAtPointer } from './json-pointer';
import { isJsonObject, type JsonValue } from './json-value';
import type { JsonPatchOperation } from './json-patch';

/** Native edges determine which references are real. The admitted source
 * value supplies the exact reference encoding, without whole-Project TS
 * validation or inferring relationships from text. */
export function nativeRenameReferencePatches(
  document: JsonValue,
  graph: NativeSemanticGraph,
  from: ReferenceTarget,
  toId: string,
): { ok: true; patches: JsonPatchOperation[] } | { ok: false; reason: string } {
  const patches: JsonPatchOperation[] = [];
  const visited = new Set<string>();
  for (const edge of graph.edges) {
    if (
      edge.target.kind !== 'record' ||
      edge.target.collection !== from.collection ||
      edge.target.id !== from.id ||
      !edge.facets.includes('reference-integrity') ||
      edge.role === 'source-recognized-reference'
    )
      continue;
    const originalPath = edge.sourcePath;
    if (visited.has(originalPath)) continue;
    visited.add(originalPath);
    if (!hasJsonAtPointer(document, originalPath))
      return { ok: false, reason: `Native reference is missing at ${originalPath}.` };
    const old = getJsonAtPointer(document, originalPath);
    let value: JsonValue;
    if (isJsonObject(old) && old.collection === from.collection && old.id === from.id) {
      value = { ...old, id: toId };
    } else if (
      isJsonObject(old) &&
      old.id === from.id &&
      old.kind === from.collection.slice(0, -1)
    ) {
      value = { ...old, id: toId };
    } else if (typeof old === 'string' && old === from.id) {
      value = toId;
    } else {
      return {
        ok: false,
        reason: `Native reference at ${originalPath} has no proven safe rename encoding.`,
      };
    }
    // The new record is added before reference replacements. Preserve any
    // outgoing references from the record being renamed at its new path.
    const oldRoot = `/${from.collection}/${from.id}`;
    const path = originalPath.startsWith(`${oldRoot}/`)
      ? `/${from.collection}/${toId}${originalPath.slice(oldRoot.length)}`
      : originalPath;
    patches.push({ op: 'replace', path, value });
  }
  return { ok: true, patches };
}
