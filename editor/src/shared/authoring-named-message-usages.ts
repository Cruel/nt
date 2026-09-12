import { collectManagedLuaLocalizationSources } from './authoring-lua-localization-lowering';
import { collectRmlLocalizationSources } from './authoring-rml-localization-lowering';
import { analyzeManagedLuaLocalization } from './authoring-source-analysis';
import { buildJsonPointer } from './json-pointer';
import { localizationTrackingFingerprint } from './localization-source-tracking';
import type { AuthoringProject } from './project-schema/authoring-project';

export interface NamedMessageUsage {
  readonly id: string;
  readonly path: string;
  readonly rewriteable: boolean;
}

export type NamedMessageUsageDetail = NamedMessageUsage &
  (
    | { family: 'structured'; messagePath: string }
    | { family: 'typed' }
    | { family: 'lua'; sourceKey: string; start: number }
    | { family: 'rml'; sourceKey: string; start: number; end: number }
  );

function stableFreeFormUsageId(
  family: 'lua' | 'rml',
  sourceKey: string,
  structuralFingerprint: string,
  anchorFingerprint: string,
): string {
  return `${family}:${sourceKey}:${localizationTrackingFingerprint(
    `${structuralFingerprint}\u0000${anchorFingerprint}`,
  )}`;
}

export function namedMessageUsageDetails(
  project: AuthoringProject,
  messageId: string,
): NamedMessageUsageDetail[] {
  const message = project.localization.messages[messageId];
  if (!message || message.kind !== 'named') return [];
  const usages: NamedMessageUsageDetail[] = [];
  const visit = (value: unknown, segments: string[]) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...segments, String(index)]));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const source = record.source;
    if (
      source &&
      typeof source === 'object' &&
      !Array.isArray(source) &&
      (source as Record<string, unknown>).kind === 'localized' &&
      (source as Record<string, unknown>).key === message.key &&
      (record.markup === 'plain' || record.markup === 'active-text')
    ) {
      const messagePath = buildJsonPointer(segments);
      const path = `${messagePath}/source`;
      usages.push({
        id: `structured:${path}`,
        path,
        rewriteable: true,
        family: 'structured',
        messagePath,
      });
      return;
    }
    if (Object.keys(record).length === 1 && record.$message === message.key) {
      const path = buildJsonPointer([...segments, '$message']);
      usages.push({ id: `typed:${path}`, path, rewriteable: false, family: 'typed' });
      return;
    }
    for (const [childKey, child] of Object.entries(record)) visit(child, [...segments, childKey]);
  };
  visit(project, []);

  for (const source of collectManagedLuaLocalizationSources(project)) {
    analyzeManagedLuaLocalization(source.text).occurrences.forEach((occurrence, ordinal) => {
      if (occurrence.kind !== 'named' || occurrence.source !== message.key) return;
      const candidate = source.source.occurrences[ordinal];
      if (!candidate) return;
      usages.push({
        id: stableFreeFormUsageId(
          'lua',
          source.sourceKey,
          candidate.structuralFingerprint,
          candidate.anchorFingerprint,
        ),
        path: source.source.sourcePath,
        rewriteable: true,
        family: 'lua',
        sourceKey: source.sourceKey,
        start: occurrence.callStartUtf16,
      });
    });
  }

  const rmlPattern =
    /<nt-tr\b[^>]*\bkey\s*=\s*(["'])([^"']*)\1[^>]*(?:\/\s*>|>[\s\S]*?<\/nt-tr\s*>)/giu;
  for (const source of collectRmlLocalizationSources(project)) {
    for (const match of source.text.matchAll(rmlPattern)) {
      if ((match[2] ?? '').trim() !== message.key || match.index === undefined) continue;
      const normalizedMarkup = match[0]
        .replace(/\bkey\s*=\s*(["'])[^"']*\1/iu, 'key=<message>')
        .replace(/\s+/gu, ' ')
        .trim();
      const before = source.text
        .slice(Math.max(0, match.index - 128), match.index)
        .replace(/\s+/gu, ' ')
        .trim();
      const end = match.index + match[0].length;
      const after = source.text
        .slice(end, Math.min(source.text.length, end + 128))
        .replace(/\s+/gu, ' ')
        .trim();
      usages.push({
        id: stableFreeFormUsageId(
          'rml',
          source.sourceKey,
          localizationTrackingFingerprint(normalizedMarkup),
          localizationTrackingFingerprint(`${before}|<nt-tr>|${after}`),
        ),
        path: source.source.sourcePath,
        rewriteable: true,
        family: 'rml',
        sourceKey: source.sourceKey,
        start: match.index,
        end,
      });
    }
  }
  return usages.sort((left, right) => left.id.localeCompare(right.id));
}

export function namedMessageUsages(
  project: AuthoringProject,
  messageId: string,
): readonly NamedMessageUsage[] {
  return Object.freeze(
    namedMessageUsageDetails(project, messageId).map(({ id, path, rewriteable }) => ({
      id,
      path,
      rewriteable,
    })),
  );
}
