import type { TextContent } from './project-schema/authoring-flow';
import type { AuthoringLocalization } from './project-schema/authoring-localization';
import type { CompiledProjectWire, CompiledText } from './project-schema/compiled-project';

function sortedEntries<T>(record: Readonly<Record<string, T>>): [string, T][] {
  return Object.entries(record).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

export function packageMessageIds(
  localization: AuthoringLocalization,
): ReadonlyMap<string, number> {
  return new Map(
    sortedEntries(localization.messages).map(([stableId], index) => [stableId, index] as const),
  );
}

export function packageMessageIdForNamedKey(
  localization: AuthoringLocalization,
  key: string,
): number | null {
  const ids = packageMessageIds(localization);
  for (const [stableId, message] of Object.entries(localization.messages))
    if (message.kind === 'named' && message.key === key) return ids.get(stableId) ?? null;
  return null;
}

export function compileMessageText(
  localization: AuthoringLocalization,
  text: TextContent,
): CompiledText {
  const source = text.source;
  if (source.kind === 'inline')
    return { markup: text.markup, source: { kind: 'inline', text: source.text } };
  if (source.kind === 'lua-expression')
    return { markup: text.markup, source: { kind: 'lua-expression', source: source.source } };

  const id = packageMessageIdForNamedKey(localization, source.key);
  if (id === null) throw new Error(`Validated named Message '${source.key}' could not be lowered.`);
  return { markup: text.markup, source: { kind: 'message', id } };
}

export function compileLocalization(
  localization: AuthoringLocalization,
): CompiledProjectWire['localization'] {
  const ids = packageMessageIds(localization);
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
          ? sortedEntries(localization.messages).map(([stableId, message]) => ({
              messageId: ids.get(stableId)!,
              value: message.source,
            }))
          : sortedEntries(localization.translations[locale] ?? {}).map(([stableId, value]) => ({
              messageId: ids.get(stableId)!,
              value,
            })),
    })),
  };
}
