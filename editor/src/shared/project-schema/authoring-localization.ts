import { z } from 'zod';

export const localeIdSchema = z.string().check(z.trim(), z.minLength(1, 'Locale is required.'));
export const messageIdSchema = z.string().uuid('Message ID must be a UUID.');
export const namedMessageKeySchema = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/,
    'Named Message key must use semantic identifier segments.',
  );

const localeDefinitionSchema = z
  .object({
    supported: z.boolean(),
    parentLocale: localeIdSchema.nullable(),
  })
  .strict();

const localMessageSchema = z
  .object({
    kind: z.literal('local'),
    source: z.string(),
  })
  .strict();

const namedMessageSchema = z
  .object({
    kind: z.literal('named'),
    key: namedMessageKeySchema,
    source: z.string(),
  })
  .strict();

export const authoringMessageSchema = z.discriminatedUnion('kind', [
  localMessageSchema,
  namedMessageSchema,
]);
export const localizationTranslationSchema = z.record(messageIdSchema, z.string());

export const authoringLocalizationSchema = z
  .object({
    sourceLocale: localeIdSchema,
    defaultLocale: localeIdSchema,
    locales: z.record(localeIdSchema, localeDefinitionSchema),
    messages: z.record(messageIdSchema, authoringMessageSchema),
    translations: z.record(localeIdSchema, localizationTranslationSchema),
  })
  .strict()
  .superRefine((localization, context) => {
    if (!Object.hasOwn(localization.locales, localization.sourceLocale)) {
      context.addIssue({
        code: 'custom',
        path: ['locales', localization.sourceLocale],
        message: `Source locale '${localization.sourceLocale}' must be declared.`,
      });
    }
    if (!Object.hasOwn(localization.locales, localization.defaultLocale)) {
      context.addIssue({
        code: 'custom',
        path: ['locales', localization.defaultLocale],
        message: `Default locale '${localization.defaultLocale}' must be declared.`,
      });
    } else if (!localization.locales[localization.defaultLocale]?.supported) {
      context.addIssue({
        code: 'custom',
        path: ['locales', localization.defaultLocale, 'supported'],
        message: `Default locale '${localization.defaultLocale}' must be Supported.`,
      });
    }

    const namedKeys = new Map<string, string>();
    for (const [messageId, message] of Object.entries(localization.messages)) {
      if (message.kind !== 'named') continue;
      const previous = namedKeys.get(message.key);
      if (previous) {
        context.addIssue({
          code: 'custom',
          path: ['messages', messageId, 'key'],
          message: `Named Message key '${message.key}' is already used by Message '${previous}'.`,
        });
      } else namedKeys.set(message.key, messageId);
    }

    for (const [locale, definition] of Object.entries(localization.locales)) {
      if (definition.parentLocale !== null) {
        if (!Object.hasOwn(localization.locales, definition.parentLocale)) {
          context.addIssue({
            code: 'custom',
            path: ['locales', locale, 'parentLocale'],
            message: `Parent locale '${definition.parentLocale}' must be declared.`,
          });
        } else if (definition.parentLocale === locale) {
          context.addIssue({
            code: 'custom',
            path: ['locales', locale, 'parentLocale'],
            message: 'A locale cannot inherit from itself.',
          });
        }
      }
    }

    for (const locale of Object.keys(localization.locales)) {
      const visited = new Set<string>();
      let current: string | null = locale;
      while (current !== null && Object.hasOwn(localization.locales, current)) {
        if (visited.has(current)) {
          context.addIssue({
            code: 'custom',
            path: ['locales', locale, 'parentLocale'],
            message: `Locale inheritance for '${locale}' contains a cycle.`,
          });
          break;
        }
        visited.add(current);
        current = localization.locales[current]?.parentLocale ?? null;
      }
    }

    for (const [locale, translations] of Object.entries(localization.translations)) {
      if (!Object.hasOwn(localization.locales, locale)) {
        context.addIssue({
          code: 'custom',
          path: ['translations', locale],
          message: `Translation locale '${locale}' must be declared.`,
        });
      }
      if (locale === localization.sourceLocale) {
        context.addIssue({
          code: 'custom',
          path: ['translations', locale],
          message: 'Source locale text is stored on Messages, not as target translations.',
        });
      }
      for (const messageId of Object.keys(translations)) {
        if (!Object.hasOwn(localization.messages, messageId))
          context.addIssue({
            code: 'custom',
            path: ['translations', locale, messageId],
            message: `Translation references unknown Message '${messageId}'.`,
          });
      }
    }
  });

export type AuthoringMessage = z.infer<typeof authoringMessageSchema>;
export type AuthoringLocalization = z.infer<typeof authoringLocalizationSchema>;

export function defaultAuthoringLocalization(): AuthoringLocalization {
  return {
    sourceLocale: 'en',
    defaultLocale: 'en',
    locales: { en: { supported: true, parentLocale: null } },
    messages: {},
    translations: {},
  };
}
