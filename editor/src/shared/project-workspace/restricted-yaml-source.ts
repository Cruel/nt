import { isAlias, isMap, isScalar, isSeq, parseAllDocuments, type Node } from 'yaml';

/** Physical source offset retained through the restricted YAML profile boundary. */
export class RestrictedYamlSourceError extends Error {
  constructor(
    message: string,
    readonly offset: number | undefined,
  ) {
    super(message);
    this.name = 'RestrictedYamlSourceError';
  }
}

function invalid(message: string, node?: Node | null): never {
  throw new RestrictedYamlSourceError(message, node?.range?.[0]);
}

function ambiguousPlainScalar(value: string): boolean {
  return (
    /^(yes|no|on|off|y|n|~|true|false|null)$/iu.test(value) ||
    /^(?:[-+]?0[0-9]+|\.inf|\.nan)$/iu.test(value)
  );
}

function inspectNode(node: Node | null | undefined, mappingKey = false): void {
  if (!node) return;
  if (isAlias(node) || node.anchor || (node.tag && node.tag !== 'tag:yaml.org,2002:str'))
    invalid('YAML aliases, anchors and explicit tags are not supported.', node);
  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string')
        invalid('YAML mapping keys must be strings. Quote numeric keys.', pair.key as Node);
      inspectNode(pair.key, true);
      if (pair.key.value === '<<' || pair.key.value === '__proto__')
        invalid('YAML merge and prototype keys are not supported.', pair.key);
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
    if (
      node.value !== null &&
      typeof node.value !== 'string' &&
      typeof node.value !== 'boolean' &&
      !(typeof node.value === 'number' && Number.isFinite(node.value))
    )
      invalid('YAML scalars must be finite JSON-compatible values.', node);
    if (mappingKey && node.type === 'PLAIN' && typeof node.value !== 'string')
      invalid('YAML mapping keys must be strings.', node);
    if (node.type !== 'PLAIN') return;
    const spelling = node.source;
    if (typeof spelling !== 'string') return;
    if (
      ambiguousPlainScalar(spelling) &&
      node.tag !== 'tag:yaml.org,2002:str' &&
      !(typeof node.value !== 'string' && ['true', 'false', 'null'].includes(spelling))
    )
      invalid(`Ambiguous YAML scalar '${spelling}' must be quoted.`, node);
    if (
      typeof node.value === 'number' &&
      !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(spelling)
    )
      invalid(`YAML numeric scalar '${spelling}' is not a JSON number.`, node);
  }
}

export function parseRestrictedYamlDocument(text: string) {
  const docs = parseAllDocuments(text, { uniqueKeys: true, version: '1.2', strict: true });
  if (docs.length !== 1 || docs[0]!.errors.length > 0)
    throw new RestrictedYamlSourceError(
      docs[0]?.errors[0]?.message ?? 'Expected one valid YAML document.',
      docs[0]?.errors[0]?.pos[0],
    );
  const doc = docs[0]!;
  if (doc.directives?.yaml?.version !== '1.2')
    throw new RestrictedYamlSourceError('Only YAML 1.2 documents are supported.', 0);
  inspectNode(doc.contents);
  return doc;
}
