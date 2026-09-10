export interface MessageLocalizationSource {
  readonly defaultLocale: string;
  readonly fallbackLocale: string | null;
  readonly catalogs: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>;
}

export interface MessageResolutionRequest {
  readonly key: string;
  readonly locale?: string | null;
}

export interface ResolvedMessage {
  readonly text: string;
  readonly locale: string;
}

export interface MessageResolution {
  readonly resolved: ResolvedMessage | null;
  readonly consultedLocales: readonly string[];
}

export function resolveMessage(
  localization: MessageLocalizationSource,
  request: MessageResolutionRequest,
): MessageResolution {
  const consultedLocales: string[] = [];
  const candidates = [request.locale, localization.defaultLocale, localization.fallbackLocale];

  for (const locale of candidates) {
    if (!locale || consultedLocales.includes(locale)) continue;
    consultedLocales.push(locale);
    const text = localization.catalogs[locale]?.[request.key];
    if (text !== undefined)
      return { resolved: { text, locale }, consultedLocales: Object.freeze(consultedLocales) };
  }

  return { resolved: null, consultedLocales: Object.freeze(consultedLocales) };
}
