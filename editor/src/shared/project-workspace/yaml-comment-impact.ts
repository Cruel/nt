import { isMap, isScalar, isSeq, type Node } from 'yaml';
import { parseRestrictedYamlDocument } from './restricted-yaml-source';

export interface YamlCommentImpact {
  /** Physical source JSON Pointer, not the expanded AuthoringProject pointer. */
  readonly path: string;
  readonly comment: string;
  readonly kind: 'changed' | 'deleted';
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const pointer = (path: string, key: string | number) =>
  `${path}/${String(key).replace(/~/gu, '~0').replace(/\//gu, '~1')}`;
const identity = (value: unknown) =>
  object(value) && typeof value.id === 'string'
    ? value.id
    : typeof value === 'string'
      ? value
      : undefined;

/** Compare only changed source subtrees; pure reorder keeps annotations with stable identities. */
export function yamlCommentImpacts(beforeText: string, afterText?: string): YamlCommentImpact[] {
  const before = parseRestrictedYamlDocument(beforeText);
  const after = afterText === undefined ? undefined : parseRestrictedYamlDocument(afterText).toJS();
  const impacts: YamlCommentImpact[] = [];
  const comments = (
    node: Node | null | undefined,
    path: string,
    deleted: boolean,
    header = false,
  ) => {
    if (!node) return;
    for (const comment of [header ? undefined : node.commentBefore, node.comment]) {
      if (comment) impacts.push({ path, comment, kind: deleted ? 'deleted' : 'changed' });
    }
  };
  const visit = (node: Node | null | undefined, old: unknown, next: unknown, path: string) => {
    if (!node || same(old, next)) return;
    const deleted = next === undefined;
    comments(node, path, deleted);
    if (isMap(node)) {
      for (const [index, pair] of node.items.entries()) {
        const key = String(isScalar(pair.key) ? pair.key.value : '');
        const oldChild = object(old) ? old[key] : undefined;
        const nextChild = object(next) ? next[key] : undefined;
        if (same(oldChild, nextChild)) continue;
        const childPath = pointer(path, key);
        comments(
          pair.key as Node,
          childPath,
          nextChild === undefined,
          path === '' && index === 0 && afterText !== undefined,
        );
        visit(pair.value as Node, oldChild, nextChild, childPath);
      }
    } else if (isSeq(node) && Array.isArray(old)) {
      const nextItems = Array.isArray(next) ? next : [];
      const oldIds = old.map(identity);
      const nextIds = nextItems.map(identity);
      const keyed =
        oldIds.every((id) => id !== undefined) &&
        nextIds.every((id) => id !== undefined) &&
        new Set(oldIds).size === oldIds.length &&
        new Set(nextIds).size === nextIds.length;
      node.items.forEach((item, index) => {
        const nextIndex = keyed ? nextIds.indexOf(oldIds[index]) : index;
        visit(item as Node, old[index], nextItems[nextIndex], pointer(path, index));
      });
    }
  };
  visit(before.contents, before.toJS(), after, '');
  if (afterText === undefined) {
    for (const comment of [before.commentBefore, before.comment])
      if (comment) impacts.push({ path: '', comment, kind: 'deleted' });
  }
  return impacts;
}
