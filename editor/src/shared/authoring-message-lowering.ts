import type { TextContent } from './project-schema/authoring-flow';
import type { AuthoringProject } from './project-schema/authoring-project';
import type { CompiledProjectWire, CompiledText } from './project-schema/compiled-project';
import {
  structuredMessageForPath,
  structuredMessageForText,
  structuredMessages,
} from './authoring-structured-messages';
import { collectRmlLocalMessages } from './authoring-rml-localization-lowering';

function sortedEntries<T>(record: Readonly<Record<string, T>>): [string, T][] {
  return Object.entries(record).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
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
  return new Map(allMessageIds(project).map((stableId, index) => [stableId, index] as const));
}

export function packageMessageIdForNamedKey(project: AuthoringProject, key: string): number | null {
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
  const sourceValues = new Map<string, string>([
    ...sortedEntries(localization.messages).map(
      ([stableId, message]) => [stableId, message.source] as const,
    ),
    ...structuredMessages(project).map((message) => [message.id, message.source] as const),
    ...collectRmlLocalMessages(project).map((message) => [message.id, message.source] as const),
  ]);
  const sourceMessages = allMessageIds(project).map((stableId) => ({
    stableId,
    value: sourceValues.get(stableId)!,
  }));
  return {
    sourceLocale: localization.sourceLocale,
    defaultLocale: localization.defaultLocale,
    locales: sortedEntries(localization.locales).map(([locale, definition]) => ({
      locale,
      parentLocale: definition.parentLocale,
      supported: definition.supported,
    })),
    catalogs: sortedEntries(localization.locales).map(([locale]) => ({
      locale,
      entries:
        locale === localization.sourceLocale
          ? sourceMessages.map(({ stableId, value }) => ({
              messageId: ids.get(stableId)!,
              value,
            }))
          : sortedEntries(localization.translations[locale] ?? {}).map(([stableId, value]) => ({
              messageId: ids.get(stableId)!,
              value,
            })),
    })),
  };
}
