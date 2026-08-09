import type { AuthoringDependencyEdge } from './authoring-dependency-contracts';

export interface ExactSourceRewriteUsage {
  readonly sourceReferenceClassification?:
    | 'exact-rewriteable'
    | 'exact-manual'
    | 'possible-lexical';
  readonly edge: AuthoringDependencyEdge;
}

export type ExactSourceRewriteResult =
  | Readonly<{
      ok: true;
      patches: readonly Readonly<{ op: 'replace'; path: string; value: string }>[];
    }>
  | Readonly<{ ok: false; path: string; message: string }>;

export function exactSourceRewritePatches(
  document: unknown,
  usages: readonly ExactSourceRewriteUsage[],
  replacementId: string,
): ExactSourceRewriteResult {
  const byPath = new Map<
    string,
    Array<{ startUtf16: number; endUtf16: number; expectedText: string }>
  >();
  for (const usage of usages) {
    if (usage.sourceReferenceClassification !== 'exact-rewriteable') continue;
    const ranges = byPath.get(usage.edge.sourcePath) ?? [];
    for (const evidence of usage.edge.evidence ?? []) {
      if (
        evidence.kind !== 'lua-occurrence' ||
        evidence.classification !== 'exact-rewriteable' ||
        !evidence.rewriteRange
      )
        continue;
      ranges.push(evidence.rewriteRange);
    }
    byPath.set(usage.edge.sourcePath, ranges);
  }

  const patches: Array<Readonly<{ op: 'replace'; path: string; value: string }>> = [];
  for (const [path, ranges] of byPath) {
    const value = valueAtJsonPointer(document, path);
    if (typeof value !== 'string') {
      return { ok: false, path, message: 'Recognized source rewrite target is not text.' };
    }
    let rewritten = value;
    const ordered = [...ranges].sort((a, b) => b.startUtf16 - a.startUtf16);
    let previousStart = rewritten.length + 1;
    for (const range of ordered) {
      if (
        range.startUtf16 < 0 ||
        range.endUtf16 < range.startUtf16 ||
        range.endUtf16 > rewritten.length ||
        range.endUtf16 > previousStart ||
        rewritten.slice(range.startUtf16, range.endUtf16) !== range.expectedText
      ) {
        return {
          ok: false,
          path,
          message: 'Recognized source rewrite range no longer matches the analyzed source.',
        };
      }
      rewritten =
        rewritten.slice(0, range.startUtf16) + replacementId + rewritten.slice(range.endUtf16);
      previousStart = range.startUtf16;
    }
    if (rewritten !== value) patches.push({ op: 'replace', path, value: rewritten });
  }
  return { ok: true, patches };
}

function valueAtJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '/') return document;
  if (!pointer.startsWith('/')) return undefined;
  let value = document;
  for (const encoded of pointer.slice(1).split('/')) {
    const segment = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(value)) {
      if (!/^\d+$/.test(segment)) return undefined;
      value = value[Number(segment)];
      continue;
    }
    if (!value || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}
