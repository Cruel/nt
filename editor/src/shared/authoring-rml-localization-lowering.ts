import { structuredMessageId } from './authoring-structured-messages';
import type { AuthoringProject } from './project-schema/authoring-project';

export interface RmlMessageOccurrence {
  id: string;
  layoutId: string;
  ordinal: number;
  source: string;
}

export interface RmlLocalizationDiagnostic {
  code: string;
  path: string;
  message: string;
}

export interface LoweredRmlLocalization {
  text: string;
  diagnostics: readonly RmlLocalizationDiagnostic[];
}

interface AttributeSpan {
  name: string;
  value: string | null;
  start: number;
  end: number;
}

interface NtTrNode {
  start: number;
  openEnd: number;
  contentStart: number;
  contentEnd: number;
  end: number;
  selfClosing: boolean;
  openTag: string;
  content: string;
  attributes: readonly AttributeSpan[];
  nested: boolean;
}

const inlinePresentationTags = new Set(['span', 'em', 'strong', 'b', 'i', 'u', 's', 'br']);
const inlinePresentationAttributes = new Set(['class', 'style']);

function tagEnd(source: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index + 1;
  }
  return -1;
}

function parseAttributes(openTag: string): readonly AttributeSpan[] {
  const attributes: AttributeSpan[] = [];
  const nameEnd = openTag.search(/[\s/>]/u);
  if (nameEnd < 0) return attributes;
  let cursor = nameEnd;
  while (cursor < openTag.length) {
    while (/\s/u.test(openTag[cursor] ?? '')) cursor += 1;
    if (cursor >= openTag.length || openTag[cursor] === '>' || openTag[cursor] === '/') break;
    const start = cursor;
    while (cursor < openTag.length && !/[\s=/>]/u.test(openTag[cursor] ?? '')) cursor += 1;
    const name = openTag.slice(start, cursor);
    while (/\s/u.test(openTag[cursor] ?? '')) cursor += 1;
    let value: string | null = null;
    if (openTag[cursor] === '=') {
      cursor += 1;
      while (/\s/u.test(openTag[cursor] ?? '')) cursor += 1;
      const quote = openTag[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        const valueStart = cursor;
        while (cursor < openTag.length && openTag[cursor] !== quote) cursor += 1;
        value = openTag.slice(valueStart, cursor);
        if (cursor < openTag.length) cursor += 1;
      } else {
        const valueStart = cursor;
        while (cursor < openTag.length && !/[\s/>]/u.test(openTag[cursor] ?? '')) cursor += 1;
        value = openTag.slice(valueStart, cursor);
      }
    }
    attributes.push({ name, value, start, end: cursor });
  }
  return attributes;
}

function findNtTrNodes(source: string): { nodes: readonly NtTrNode[]; malformed: boolean } {
  const nodes: NtTrNode[] = [];
  const pattern = /<\/?nt-tr(?=[\s/>])/giu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    if (match[0].startsWith('</')) continue;
    const start = match.index;
    const openEnd = tagEnd(source, pattern.lastIndex);
    if (openEnd < 0) return { nodes, malformed: true };
    const openTag = source.slice(start, openEnd);
    const selfClosing = /\/\s*>$/u.test(openTag);
    if (selfClosing) {
      nodes.push({
        start,
        openEnd,
        contentStart: openEnd,
        contentEnd: openEnd,
        end: openEnd,
        selfClosing: true,
        openTag,
        content: '',
        attributes: parseAttributes(openTag),
        nested: false,
      });
      pattern.lastIndex = openEnd;
      continue;
    }

    const innerPattern = /<\/?nt-tr(?=[\s/>])/giu;
    innerPattern.lastIndex = openEnd;
    let depth = 1;
    let nested = false;
    let closeStart = -1;
    let closeEnd = -1;
    let inner: RegExpExecArray | null;
    while ((inner = innerPattern.exec(source))) {
      const closing = inner[0].startsWith('</');
      if (closing) {
        depth -= 1;
        if (depth === 0) {
          closeStart = inner.index;
          closeEnd = tagEnd(source, innerPattern.lastIndex);
          break;
        }
      } else {
        nested = true;
        const nestedOpenEnd = tagEnd(source, innerPattern.lastIndex);
        if (nestedOpenEnd < 0) return { nodes, malformed: true };
        if (!/\/\s*>$/u.test(source.slice(inner.index, nestedOpenEnd))) depth += 1;
        innerPattern.lastIndex = nestedOpenEnd;
      }
    }
    if (closeStart < 0 || closeEnd < 0) return { nodes, malformed: true };
    nodes.push({
      start,
      openEnd,
      contentStart: openEnd,
      contentEnd: closeStart,
      end: closeEnd,
      selfClosing: false,
      openTag,
      content: source.slice(openEnd, closeStart),
      attributes: parseAttributes(openTag),
      nested,
    });
    pattern.lastIndex = closeEnd;
  }
  return { nodes, malformed: false };
}

function attribute(node: NtTrNode, name: string): AttributeSpan | undefined {
  return node.attributes.find((candidate) => candidate.name.toLowerCase() === name);
}

function validateInlineMarkup(
  content: string,
  path: string,
  diagnostics: RmlLocalizationDiagnostic[],
): void {
  const tagPattern = /<\/?([A-Za-z_][A-Za-z0-9_.:-]*)([^>]*)>/gu;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(content))) {
    const tag = match[1]!.toLowerCase();
    if (!inlinePresentationTags.has(tag)) {
      diagnostics.push({
        code: 'authoring.localization.rml_unsupported_content',
        path,
        message: `<nt-tr> supports inline presentation markup only; '${tag}' is not allowed.`,
      });
      continue;
    }
    if (match[0].startsWith('</')) continue;
    const openTag = match[0];
    for (const candidate of parseAttributes(openTag)) {
      if (!inlinePresentationAttributes.has(candidate.name.toLowerCase())) {
        diagnostics.push({
          code: 'authoring.localization.rml_unsupported_content',
          path,
          message: `<${tag}> attribute '${candidate.name}' is not part of the translatable inline presentation subset.`,
        });
      }
    }
  }
}

function localOccurrenceId(layoutId: string, ordinal: number): string {
  return structuredMessageId(`/layouts/${layoutId}/data/rml/nt-tr/${ordinal}`);
}

export function collectRmlLocalMessages(
  project: AuthoringProject,
): readonly RmlMessageOccurrence[] {
  const occurrences: RmlMessageOccurrence[] = [];
  for (const [layoutId, record] of Object.entries(project.layouts).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const data = record.data;
    if (!data || typeof data !== 'object' || !('rml' in data)) continue;
    const rml = (data as { rml?: { sourceMode?: string; sourceText?: string } }).rml;
    if (rml?.sourceMode !== 'inline' || typeof rml.sourceText !== 'string') continue;
    const parsed = findNtTrNodes(rml.sourceText);
    let ordinal = 0;
    for (const node of parsed.nodes) {
      const key = attribute(node, 'key')?.value?.trim();
      if (key) continue;
      occurrences.push({
        id: localOccurrenceId(layoutId, ordinal),
        layoutId,
        ordinal,
        source: node.content,
      });
      ordinal += 1;
    }
  }
  return Object.freeze(occurrences);
}

function compiledOpenTag(node: NtTrNode, messageId: number): string {
  const key = attribute(node, 'key');
  let body = node.openTag.slice(0, -1);
  if (key) body = body.slice(0, key.start) + body.slice(key.end);
  body = body.replace(/\/\s*$/u, '').trimEnd();
  return `${body} message="${messageId}">`;
}

export function lowerRmlLocalization(
  project: AuthoringProject,
  layoutId: string,
  source: string,
  packageIds: ReadonlyMap<string, number>,
): LoweredRmlLocalization {
  const diagnostics: RmlLocalizationDiagnostic[] = [];
  const parsed = findNtTrNodes(source);
  const basePath = `/layouts/${layoutId}/data/rml/sourceText`;
  if (parsed.malformed) {
    diagnostics.push({
      code: 'authoring.localization.rml_parse',
      path: basePath,
      message: 'Malformed <nt-tr> markup could not be lowered.',
    });
    return { text: source, diagnostics };
  }

  let localOrdinal = 0;
  const replacements: { start: number; end: number; value: string }[] = [];
  for (const node of parsed.nodes) {
    const key = attribute(node, 'key')?.value?.trim();
    const localStableId = key ? null : localOccurrenceId(layoutId, localOrdinal++);
    if (node.nested) {
      diagnostics.push({
        code: 'authoring.localization.rml_nested_message',
        path: basePath,
        message: 'Nested <nt-tr> localization nodes are not supported.',
      });
      continue;
    }
    if (/<\s*nt-case(?=[\s/>])/iu.test(node.content)) {
      diagnostics.push({
        code: 'authoring.localization.rml_inline_case_unsupported',
        path: basePath,
        message: 'Inline <nt-case> plural/select grammar is not supported; use a named Message.',
      });
      continue;
    }

    let stableId: string | null = null;
    if (key) {
      const match = Object.entries(project.localization.messages).find(
        ([, message]) => message.kind === 'named' && message.key === key,
      );
      if (!match) {
        diagnostics.push({
          code: 'authoring.localization.rml_named_message_missing',
          path: basePath,
          message: `Named Message '${key}' does not exist.`,
        });
        continue;
      }
      stableId = match[0];
      if (node.content.trim().length > 0) {
        diagnostics.push({
          code: 'authoring.localization.rml_named_content',
          path: basePath,
          message: 'Named <nt-tr key="…"> references cannot also contain local source content.',
        });
        continue;
      }
    } else {
      if (node.selfClosing) {
        diagnostics.push({
          code: 'authoring.localization.rml_local_source_missing',
          path: basePath,
          message: 'Local <nt-tr> requires source content.',
        });
        continue;
      }
      stableId = localStableId;
      validateInlineMarkup(node.content, basePath, diagnostics);
    }

    for (const candidate of node.attributes) {
      const name = candidate.name.toLowerCase();
      if (name === 'key' || name === 'id' || name === 'class' || name === 'style') continue;
      if (name.startsWith('data-')) continue;
      if (!/^arg-[A-Za-z_][A-Za-z0-9_-]*$/u.test(candidate.name)) {
        diagnostics.push({
          code: 'authoring.localization.rml_argument_attribute_invalid',
          path: basePath,
          message: `Localization argument binding '${candidate.name}' must use arg-<name>.`,
        });
      }
    }

    if (stableId === null) continue;
    const packageId = packageIds.get(stableId);
    if (packageId === undefined) {
      diagnostics.push({
        code: 'authoring.localization.rml_message_lowering_failed',
        path: basePath,
        message: `Managed RML Message '${stableId}' could not be assigned a package Message ID.`,
      });
      continue;
    }
    replacements.push({
      start: node.start,
      end: node.end,
      value: `${compiledOpenTag(node, packageId)}</nt-tr>`,
    });
  }

  if (diagnostics.length > 0) return { text: source, diagnostics };
  let text = source;
  for (const replacement of replacements.sort((left, right) => right.start - left.start))
    text = text.slice(0, replacement.start) + replacement.value + text.slice(replacement.end);
  return { text, diagnostics };
}
