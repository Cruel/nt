import { buildJsonPointer } from '../../shared/json-pointer';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';

export interface MessageReferenceRenamePatch {
  op: 'replace';
  path: string;
  value: string;
}

/** Rewrites only explicit typed Message values; ordinary strings are never treated as Message keys. */
export function renameMessageValueReferencePatches(
  project: AuthoringProject,
  fromKey: string,
  toKey: string,
): MessageReferenceRenamePatch[] {
  const patches: MessageReferenceRenamePatch[] = [];

  const visit = (value: unknown, segments: string[]) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...segments, String(index)]));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length === 1 && record.$message === fromKey) {
      patches.push({
        op: 'replace',
        path: buildJsonPointer([...segments, '$message']),
        value: toKey,
      });
      return;
    }
    for (const [key, item] of Object.entries(record)) visit(item, [...segments, key]);
  };

  visit(project, []);
  return patches;
}
