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
        // Changed surviving items are located at their new source index. Use that
        // physical path for both the warning and the subsequent Remove action.
        // Deleted entries have no new index, so report their original location.
        visit(
          item as Node,
          old[index],
          nextItems[nextIndex],
          pointer(path, nextIndex >= 0 ? nextIndex : index),
        );
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

/** Physical YAML source paths with attached notes, including notes on mapping keys. */
export function annotatedYamlPaths(text: string): ReadonlySet<string> {
  const doc = parseRestrictedYamlDocument(text);
  const paths = new Set<string>();
  const visit = (node: Node | null | undefined, path: string) => {
    if (!node) return;
    if (node.comment || node.commentBefore) paths.add(path);
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key)) continue;
        const childPath = path ? `${path}.${String(pair.key.value)}` : String(pair.key.value);
        if (pair.key.comment || pair.key.commentBefore) paths.add(childPath);
        visit(pair.value as Node, childPath);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) visit(item as Node, `${path}.*`);
    }
  };
  visit(doc.contents, '');
  return paths;
}

/** Remove only explicitly reviewed changed annotations; unaffected prose stays attached. */
export function removeChangedYamlComments(
  text: string,
  impacts: readonly YamlCommentImpact[],
): string {
  const doc = parseRestrictedYamlDocument(text);
  for (const impact of impacts) {
    if (impact.kind !== 'changed') continue;
    const parts = impact.path
      .split('/')
      .slice(1)
      .map((part) => part.replace(/~1/gu, '/').replace(/~0/gu, '~'));
    let node: Node | null | undefined = doc.contents;
    let keyNode: Node | null | undefined;
    for (const part of parts) {
      if (isMap(node)) {
        const pair = node.items.find((entry) => isScalar(entry.key) && entry.key.value === part);
        keyNode = pair?.key as Node | undefined;
        node = pair?.value as Node | undefined;
      } else if (isSeq(node)) {
        keyNode = undefined;
        node = node.items[Number(part)] as Node | undefined;
      } else {
        node = undefined;
        break;
      }
    }
    for (const target of [node, keyNode]) {
      if (target?.comment === impact.comment) target.comment = undefined;
      if (target?.commentBefore === impact.comment) target.commentBefore = undefined;
    }
  }
  return doc.toString({ indent: 2, lineWidth: 0 });
}
