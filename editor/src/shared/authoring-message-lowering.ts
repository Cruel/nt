import type { TextContent } from './project-schema/authoring-flow';
import type { AuthoringProject } from './project-schema/authoring-project';
import type { CompiledProjectWire, CompiledText } from './project-schema/compiled-project';
import {
  structuredMessageForPath,
  structuredMessageForText,
  structuredMessages,
} from './authoring-structured-messages';
import { collectRmlLocalMessages } from './authoring-rml-localization-lowering';
import {
  messagePlaceholderNames,
  type MessagePattern,
} from './project-schema/authoring-localization';
import { systemMessageDefinitionForKey } from './project-schema/system-messages';

function sortedEntries<T>(record: Readonly<Record<string, T>>): [string, T][] {
  return Object.entries(record).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

type CompiledPattern = NonNullable<
  CompiledProjectWire['localization']['catalogs'][number]['entries'][number]['pattern']
>;

function compileMessagePattern(pattern: MessagePattern): CompiledPattern {
  const nodes: CompiledPattern['nodes'] = [];
  const append = (current: MessagePattern): number => {
    const index = nodes.length;
    nodes.push({ kind: 'text', text: '' });
    if (current.kind === 'text') {
      nodes[index] = { kind: 'text', text: current.text };
      return index;
    }
    const cases = Object.entries(current.cases)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, branch]) => ({ key, node: append(branch) }));
    nodes[index] = { kind: current.kind, argument: current.argument, cases };
    return index;
  };
  return { root: append(pattern), nodes };
}

function allMessageIds(project: AuthoringProject): string[] {
  const structured = structuredMessages(project);
  const settingsMessages = structured
    .filter((message) => message.path.startsWith('/settings/'))
    .map((message) => message.id)
    .sort();
  const existingFamilies = [
    ...Object.keys(project.localization.messages),
    ...structured
      .filter((message) => !message.path.startsWith('/settings/'))
      .map((message) => message.id),
    ...collectRmlLocalMessages(project).map((message) => message.id),
  ].sort();
  return [...existingFamilies, ...settingsMessages];
}

export function packageMessageIds(project: AuthoringProject): ReadonlyMap<string, number> {
  const ids = new Map<string, number>();
  let nextProjectId = 0;
  for (const stableId of allMessageIds(project)) {
    const message = project.localization.messages[stableId];
    const system = message?.kind === 'named' ? systemMessageDefinitionForKey(message.key) : null;
    ids.set(stableId, system?.id ?? nextProjectId++);
  }
  return ids;
}

export function packageMessageIdForNamedKey(project: AuthoringProject, key: string): number | null {
  const system = systemMessageDefinitionForKey(key);
  if (system) return system.id;
  const ids = packageMessageIds(project);
  for (const [stableId, message] of Object.entries(project.localization.messages))
    if (message.kind === 'named' && message.key === key) return ids.get(stableId) ?? null;
  return null;
}

export function compileMessageText(
  project: AuthoringProject,
  text: TextContent,
  semanticPath?: string,
): CompiledText {
  const source = text.source;
  if (source.kind === 'inline') {
    const structured = semanticPath
      ? structuredMessageForPath(project, semanticPath)
      : structuredMessageForText(project, text);
    if (!structured)
      throw new Error('Validated structured Message could not be assigned semantic identity.');
    const id = packageMessageIds(project).get(structured.id);
    if (id === undefined)
      throw new Error(`Structured Message '${structured.id}' could not be lowered.`);
    return { markup: text.markup, source: { kind: 'message', id } };
  }
  if (source.kind === 'lua-expression')
    return { markup: text.markup, source: { kind: 'lua-expression', source: source.source } };

  const id = packageMessageIdForNamedKey(project, source.key);
  if (id === null) throw new Error(`Validated named Message '${source.key}' could not be lowered.`);
  return { markup: text.markup, source: { kind: 'message', id } };
}

export function compileLocalization(
  project: AuthoringProject,
): CompiledProjectWire['localization'] {
  const localization = project.localization;
  const ids = packageMessageIds(project);
  const rmlLocalIds = new Set(collectRmlLocalMessages(project).map((message) => message.id));
  const sourceValues = new Map<string, string>([
    ...sortedEntries(localization.messages).map(
      ([stableId, message]) => [stableId, message.source] as const,
    ),
    ...structuredMessages(project).map((message) => [message.id, message.source] as const),
    ...collectRmlLocalMessages(project).map((message) => [message.id, message.source] as const),
  ]);
  const sourceMessages = allMessageIds(project).map((stableId) => {
    const value = sourceValues.get(stableId)!;
    const authoredMessage = localization.messages[stableId];
    const explicitArguments = authoredMessage?.arguments;
    const arguments_ = explicitArguments
      ? sortedEntries(explicitArguments).map(([name, type]) => ({ name, type }))
      : rmlLocalIds.has(stableId)
        ? messagePlaceholderNames(value).map((name) => ({ name, type: 'printable' as const }))
        : [];
    return {
      stableId,
      value,
      arguments: arguments_,
      ...(authoredMessage?.pattern
        ? { pattern: compileMessagePattern(authoredMessage.pattern) }
        : {}),
    };
  });
  const sourceArgumentContracts = new Map(
    sourceMessages.map((message) => [message.stableId, message.arguments] as const),
  );
  const effectiveTarget = (locale: string, stableId: string) => {
    const visited = new Set<string>();
    let current: string | null = locale;
    while (current && current !== localization.sourceLocale && !visited.has(current)) {
      visited.add(current);
      const target = localization.translations[current]?.[stableId];
      if (target) return target;
      current = localization.locales[current]?.parentLocale ?? null;
    }
    return null;
  };
  return {
    sourceLocale: localization.sourceLocale,
    defaultLocale: localization.defaultLocale,
    locales: sortedEntries(localization.locales).map(([locale, definition]) => ({
      locale,
      parentLocale: definition.parentLocale,
      supported: definition.supported,
      fontStack: (definition.fontStack ?? project.settings.text.fontStack).map((ref) => ({
        kind: 'asset' as const,
        id: ref.$ref.id,
      })),
    })),
    catalogs: sortedEntries(localization.locales).map(([locale]) => ({
      locale,
      entries:
        locale === localization.sourceLocale
          ? sourceMessages.map(({ stableId, value, arguments: arguments_, ...patternFields }) => ({
              messageId: ids.get(stableId)!,
              value,
              ...patternFields,
              ...(arguments_.length === 0 ? {} : { arguments: arguments_ }),
            }))
          : allMessageIds(project).flatMap((stableId) => {
              const target = effectiveTarget(locale, stableId);
              if (!target) return [];
              const arguments_ = sourceArgumentContracts.get(stableId) ?? [];
              if (target.useSource) return [];
              return [
                {
                  messageId: ids.get(stableId)!,
                  value: target.text,
                  ...(target.pattern ? { pattern: compileMessagePattern(target.pattern) } : {}),
                  ...(arguments_.length === 0 ? {} : { arguments: arguments_ }),
                },
              ];
            }),
    })),
  };
}
