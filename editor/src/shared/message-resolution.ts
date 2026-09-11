import type { AuthoringLocalization } from './project-schema/authoring-localization';

export type MessageLocalizationSource = AuthoringLocalization;

export interface MessageResolutionRequest {
  readonly key?: string;
  readonly messageId?: string;
  readonly locale?: string | null;
}

export interface ResolvedMessage {
  readonly messageId: string;
  readonly text: string;
  readonly locale: string;
}

export interface MessageResolution {
  readonly resolved: ResolvedMessage | null;
  readonly consultedLocales: readonly string[];
}

function resolveMessageId(
  localization: MessageLocalizationSource,
  request: MessageResolutionRequest,
): string | null {
  if (request.messageId && Object.hasOwn(localization.messages, request.messageId))
    return request.messageId;
  if (!request.key) return null;
  for (const [messageId, message] of Object.entries(localization.messages))
    if (message.kind === 'named' && message.key === request.key) return messageId;
  return null;
}

export function resolveMessage(
  localization: MessageLocalizationSource,
  request: MessageResolutionRequest,
): MessageResolution {
  const messageId = resolveMessageId(localization, request);
  if (!messageId) return { resolved: null, consultedLocales: Object.freeze([]) };

  const message = localization.messages[messageId]!;
  const consultedLocales: string[] = [];
  const firstLocale = request.locale || localization.defaultLocale;
  let locale: string | null = firstLocale;
  while (locale && locale !== localization.sourceLocale && !consultedLocales.includes(locale)) {
    consultedLocales.push(locale);
    const translation = localization.translations[locale]?.[messageId];
    if (translation !== undefined)
      return {
        resolved: translation.useSource
          ? { messageId, text: message.source, locale: localization.sourceLocale }
          : { messageId, text: translation.text, locale },
        consultedLocales: Object.freeze(consultedLocales),
      };
    locale = localization.locales[locale]?.parentLocale ?? null;
  }

  if (!consultedLocales.includes(localization.sourceLocale))
    consultedLocales.push(localization.sourceLocale);
  return {
    resolved: { messageId, text: message.source, locale: localization.sourceLocale },
    consultedLocales: Object.freeze(consultedLocales),
  };
}
