import { isAlias, isMap, isScalar, isSeq, parseAllDocuments, type Node } from 'yaml';

function ambiguousPlainScalar(value: string): boolean {
  return (
    /^(yes|no|on|off|y|n|~|true|false|null)$/iu.test(value) ||
    /^(?:[-+]?0[0-9]+|\.inf|\.nan)$/iu.test(value)
  );
}

function inspectNode(node: Node | null | undefined, mappingKey = false): void {
  if (!node) return;
  if (isAlias(node) || node.anchor || (node.tag && node.tag !== 'tag:yaml.org,2002:str'))
    throw new Error('YAML aliases, anchors and explicit tags are not supported.');
  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string')
        throw new Error('YAML mapping keys must be strings. Quote numeric keys.');
      inspectNode(pair.key, true);
      if (pair.key.value === '<<' || pair.key.value === '__proto__')
        throw new Error('YAML merge and prototype keys are not supported.');
      inspectNode(pair.value as Node | null);
    }
  } else if (isSeq(node)) {
    // YAML places a note before the first dash on the sequence, unlike later item notes.
    // Our source contract attaches preceding notes to the following item, even when it moves.
    const first = node.items[0] as Node | undefined;
    if (first && node.commentBefore) {
      first.commentBefore = [node.commentBefore, first.commentBefore].filter(Boolean).join('\n');
      node.commentBefore = undefined;
    }
    for (const item of node.items) inspectNode(item as Node | null);
  } else if (isScalar(node)) {
    if (mappingKey && node.type === 'PLAIN' && typeof node.value !== 'string')
      throw new Error('YAML mapping keys must be strings.');
    if (node.type !== 'PLAIN') return;
    const spelling = node.source;
    if (typeof spelling !== 'string') return;
    if (
      ambiguousPlainScalar(spelling) &&
      !(typeof node.value !== 'string' && ['true', 'false', 'null'].includes(spelling))
    )
      throw new Error(`Ambiguous YAML scalar '${spelling}' must be quoted.`);
    if (
      typeof node.value === 'number' &&
      !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(spelling)
    )
      throw new Error(`YAML numeric scalar '${spelling}' is not a JSON number.`);
  }
}

export function parseRestrictedYamlDocument(text: string) {
  const docs = parseAllDocuments(text, { uniqueKeys: true, version: '1.2', strict: true });
  if (docs.length !== 1 || docs[0]!.errors.length > 0)
    throw new Error(docs[0]?.errors[0]?.message ?? 'Expected one valid YAML document.');
  const doc = docs[0]!;
  inspectNode(doc.contents);
  return doc;
}
