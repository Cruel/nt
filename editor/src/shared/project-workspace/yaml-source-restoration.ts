import { isMap, isScalar, isSeq, type Node } from 'yaml';
import { parseRestrictedYamlDocument } from './restricted-yaml-source';

function itemIdentity(node: unknown): string | undefined {
  if (isScalar(node) && typeof node.value === 'string') return node.value;
  if (isMap(node)) {
    const id = node.get('id');
    if (typeof id === 'string') return id;
  }
  return undefined;
}

/** Seed only recreated nodes from Undo history; existing live source always owns its annotations. */
export function restoreMissingYamlSource(
  currentText: string,
  nextText: string,
  historyText: string,
): string {
  const current = parseRestrictedYamlDocument(currentText);
  const next = parseRestrictedYamlDocument(nextText);
  const history = parseRestrictedYamlDocument(historyText);
  const restore = (
    live: Node | null | undefined,
    target: Node | null | undefined,
    old: Node | null | undefined,
  ) => {
    if (isMap(live) && isMap(target) && isMap(old)) {
      for (const pair of target.items) {
        if (!isScalar(pair.key)) continue;
        const key = pair.key.value;
        const prior = old.items.find((item) => isScalar(item.key) && item.key.value === key);
        if (!prior) continue;
        if (!live.has(key)) live.items.push(prior.clone());
        else restore(live.get(key, true) as Node, pair.value as Node, prior.value as Node);
      }
    } else if (isSeq(live) && isSeq(target) && isSeq(old)) {
      const ids = (node: typeof live) => node.items.map(itemIdentity);
      if (
        [live, target, old].some(
          (node) =>
            ids(node).some((id) => id === undefined) ||
            new Set(ids(node)).size !== node.items.length,
        )
      )
        return;
      for (const item of target.items) {
        const id = itemIdentity(item);
        const prior = old.items.find((entry) => itemIdentity(entry) === id) as Node | undefined;
        if (!prior) continue;
        const existing = live.items.find((entry) => itemIdentity(entry) === id) as Node | undefined;
        if (!existing) live.items.push(prior.clone());
        else restore(existing, item as Node, prior);
      }
    }
  };
  restore(current.contents, next.contents, history.contents);
  return current.toString({ indent: 2, lineWidth: 0 });
}
