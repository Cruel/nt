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

export const messageArgumentTypeSchema = z.enum([
  'printable',
  'string',
  'number',
  'integer',
  'plural-number',
]);
export const messageArgumentsSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/u, 'Message argument name is invalid.'),
  messageArgumentTypeSchema,
);

export function messagePlaceholderNames(source: string): readonly string[] {
  const names = new Set<string>();
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '{') continue;
    if (source[index + 1] === '{') {
      index += 1;
      continue;
    }
    const close = source.indexOf('}', index + 1);
    if (close < 0) continue;
    const name = source.slice(index + 1, close);
    if (/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(name)) names.add(name);
    index = close;
  }
  return Object.freeze([...names].sort());
}

const messageGuidanceFields = {
  context: z.string().optional(),
  translatorNote: z.string().optional(),
  arguments: messageArgumentsSchema.optional(),
};

const localMessageSchema = z
  .object({
    kind: z.literal('local'),
    source: z.string(),
    ...messageGuidanceFields,
  })
  .strict();

const namedMessageSchema = z
  .object({
    kind: z.literal('named'),
    key: namedMessageKeySchema,
    source: z.string(),
    ...messageGuidanceFields,
  })
  .strict();

export const authoringMessageSchema = z.discriminatedUnion('kind', [
  localMessageSchema,
  namedMessageSchema,
]);
const localizationWorkflowFingerprintSchema = z
  .string()
  .regex(/^fnv1a:[0-9a-f]{32}$/u, 'Localization workflow fingerprint is invalid.');

export const localizationTranslationRecordSchema = z
  .object({
    text: z.string(),
    sourceFingerprint: localizationWorkflowFingerprintSchema,
    origin: z.enum(['human', 'ai', 'imported', 'unknown']),
    review: z.enum(['needs-review', 'reviewed']),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    acknowledgedPresentationFingerprint: localizationWorkflowFingerprintSchema.optional(),
    acknowledgedGuidanceFingerprint: localizationWorkflowFingerprintSchema.optional(),
  })
  .strict();

export const localizationTranslationSchema = z.record(
  messageIdSchema,
  localizationTranslationRecordSchema,
);

const sourceTrackingFingerprintSchema = z
  .string()
  .regex(/^fnv1a:[0-9a-f]{32}$/u, 'Localization source tracking fingerprint is invalid.');

export const sourceMessageTrackingOccurrenceSchema = z
  .object({
    messageId: messageIdSchema,
    ordinal: z.number().int().nonnegative(),
    structuralFingerprint: sourceTrackingFingerprintSchema,
    anchorFingerprint: sourceTrackingFingerprintSchema,
    sourceFingerprint: sourceTrackingFingerprintSchema,
    sourceSnapshot: z.string(),
    contextSnapshot: z.string().optional(),
    translatorNoteSnapshot: z.string().optional(),
  })
  .strict();

export const sourceMessageTrackingEntrySchema = z
  .object({
    family: z.enum(['lua', 'rml']),
    ownerKey: z.string().min(1),
    sourcePath: z.string().min(1),
    sourceSnapshotFingerprint: sourceTrackingFingerprintSchema,
    occurrences: z.array(sourceMessageTrackingOccurrenceSchema),
  })
  .strict();

export const orphanedLocalizationMessageSchema = z
  .object({
    family: z.enum(['lua', 'rml']),
    ownerKey: z.string().min(1),
    sourcePath: z.string().min(1),
    sourceSnapshotFingerprint: sourceTrackingFingerprintSchema,
    occurrence: sourceMessageTrackingOccurrenceSchema,
    translations: z.record(localeIdSchema, localizationTranslationRecordSchema),
  })
  .strict();

export const authoringLocalizationSchema = z
  .object({
    sourceLocale: localeIdSchema,
    defaultLocale: localeIdSchema,
    locales: z.record(localeIdSchema, localeDefinitionSchema),
    messages: z.record(messageIdSchema, authoringMessageSchema),
    structuredMessageIds: z.record(z.string().min(1), messageIdSchema),
    sourceMessageTracking: z.record(z.string().min(1), sourceMessageTrackingEntrySchema),
    orphanedMessages: z.record(messageIdSchema, orphanedLocalizationMessageSchema),
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

    for (const [trackingKey, entry] of Object.entries(localization.sourceMessageTracking)) {
      const expectedKey = `${entry.family}:${entry.ownerKey}:${entry.sourcePath}`;
      if (trackingKey !== expectedKey)
        context.addIssue({
          code: 'custom',
          path: ['sourceMessageTracking', trackingKey],
          message: `Source Message tracking key must be '${expectedKey}'.`,
        });
    }

    for (const [messageId, orphan] of Object.entries(localization.orphanedMessages)) {
      if (orphan.occurrence.messageId !== messageId)
        context.addIssue({
          code: 'custom',
          path: ['orphanedMessages', messageId, 'occurrence', 'messageId'],
          message: `Orphaned Message key '${messageId}' must match its occurrence Message ID.`,
        });
      for (const locale of Object.keys(orphan.translations))
        if (!Object.hasOwn(localization.locales, locale) || locale === localization.sourceLocale)
          context.addIssue({
            code: 'custom',
            path: ['orphanedMessages', messageId, 'translations', locale],
            message: `Orphaned Message translation locale '${locale}' must be a declared target locale.`,
          });
    }

    const namedKeys = new Map<string, string>();
    for (const [messageId, message] of Object.entries(localization.messages)) {
      const argumentNames = new Set(Object.keys(message.arguments ?? {}));
      for (const placeholder of messagePlaceholderNames(message.source))
        if (!argumentNames.has(placeholder))
          context.addIssue({
            code: 'custom',
            path: ['messages', messageId, 'source'],
            message: `Message placeholder '{${placeholder}}' requires a declared argument.`,
          });
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

    for (const locale of Object.keys(localization.translations)) {
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
    }
  });

export type AuthoringMessage = z.infer<typeof authoringMessageSchema>;
export type LocalizationTranslation = z.infer<typeof localizationTranslationRecordSchema>;
export type SourceMessageTrackingOccurrence = z.infer<typeof sourceMessageTrackingOccurrenceSchema>;
export type SourceMessageTrackingEntry = z.infer<typeof sourceMessageTrackingEntrySchema>;
export type OrphanedLocalizationMessage = z.infer<typeof orphanedLocalizationMessageSchema>;
export type AuthoringLocalization = z.infer<typeof authoringLocalizationSchema>;

export function defaultAuthoringLocalization(): AuthoringLocalization {
  return {
    sourceLocale: 'en',
    defaultLocale: 'en',
    locales: { en: { supported: true, parentLocale: null } },
    messages: {},
    structuredMessageIds: {},
    sourceMessageTracking: {},
    orphanedMessages: {},
    translations: {},
  };
}
