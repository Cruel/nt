import { z } from 'zod';
import { cldrCardinalCategories } from '../cldr-cardinal-rules';
import { isReservedSystemMessageKey, systemMessageDefinitionForKey } from './system-messages';

function isAsciiAlpha(character: string): boolean {
  if (character.length !== 1) return false;
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(character: string): boolean {
  if (character.length !== 1) return false;
  const code = character.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function everyAscii(value: string, predicate: (character: string) => boolean): boolean {
  for (let index = 0; index < value.length; index += 1) if (!predicate(value[index]!)) return false;
  return true;
}

function isAlphaSubtag(value: string, minimum: number, maximum: number): boolean {
  return value.length >= minimum && value.length <= maximum && everyAscii(value, isAsciiAlpha);
}

function isAlphanumericSubtag(value: string, minimum: number, maximum: number): boolean {
  return (
    value.length >= minimum &&
    value.length <= maximum &&
    everyAscii(value, (character) => isAsciiAlpha(character) || isAsciiDigit(character))
  );
}

export function canonicalBcp47Locale(locale: string): string | null {
  const subtags = locale.split('-');
  if (subtags.length === 0 || subtags.some((subtag) => subtag.length === 0)) return null;
  let index = 0;
  const canonical: string[] = [];
  const language = subtags[index++];
  if (!language || !isAlphaSubtag(language, 2, 8)) return null;
  canonical.push(language.toLowerCase());

  if (language.length <= 3) {
    for (let count = 0; count < 3 && isAlphaSubtag(subtags[index] ?? '', 3, 3); count += 1)
      canonical.push(subtags[index++]!.toLowerCase());
  }
  if (isAlphaSubtag(subtags[index] ?? '', 4, 4)) {
    const script = subtags[index++]!;
    canonical.push(`${script[0]!.toUpperCase()}${script.slice(1).toLowerCase()}`);
  }
  const region = subtags[index] ?? '';
  if (isAlphaSubtag(region, 2, 2) || (region.length === 3 && everyAscii(region, isAsciiDigit))) {
    index += 1;
    canonical.push(isAsciiAlpha(region[0] ?? '') ? region.toUpperCase() : region);
  }

  const variants = new Set<string>();
  while (true) {
    const variantCandidate = subtags[index] ?? '';
    const variant =
      isAlphanumericSubtag(variantCandidate, 5, 8) ||
      (variantCandidate.length === 4 &&
        isAsciiDigit(variantCandidate[0] ?? '') &&
        isAlphanumericSubtag(variantCandidate, 4, 4));
    if (!variant) break;
    const normalized = variantCandidate.toLowerCase();
    if (variants.has(normalized)) return null;
    variants.add(normalized);
    canonical.push(normalized);
    index += 1;
  }

  const extensions = new Set<string>();
  while (true) {
    const singletonCandidate = subtags[index] ?? '';
    if (
      singletonCandidate.length !== 1 ||
      (!isAsciiAlpha(singletonCandidate) && !isAsciiDigit(singletonCandidate)) ||
      singletonCandidate.toLowerCase() === 'x'
    )
      break;
    const singleton = singletonCandidate.toLowerCase();
    if (extensions.has(singleton)) return null;
    extensions.add(singleton);
    canonical.push(singleton);
    index += 1;
    let extensionCount = 0;
    while (isAlphanumericSubtag(subtags[index] ?? '', 2, 8)) {
      canonical.push(subtags[index++]!.toLowerCase());
      extensionCount += 1;
    }
    if (extensionCount === 0) return null;
  }

  if ((subtags[index] ?? '').toLowerCase() === 'x') {
    canonical.push('x');
    index += 1;
    let privateCount = 0;
    while (isAlphanumericSubtag(subtags[index] ?? '', 1, 8)) {
      canonical.push(subtags[index++]!.toLowerCase());
      privateCount += 1;
    }
    if (privateCount === 0) return null;
  }
  return index === subtags.length ? canonical.join('-') : null;
}

export const localeIdSchema = z
  .string()
  .check(z.trim(), z.minLength(1, 'Locale is required.'))
  .superRefine((locale, context) => {
    const canonical = canonicalBcp47Locale(locale);
    if (canonical === null)
      context.addIssue({
        code: 'custom',
        message: `Locale '${locale}' is not a valid BCP 47 locale tag.`,
      });
    else if (canonical !== locale)
      context.addIssue({
        code: 'custom',
        message: `Locale '${locale}' must be a canonical BCP 47 locale tag ('${canonical}').`,
      });
  });
export const messageIdSchema = z.string().uuid('Message ID must be a UUID.');
export const namedMessageKeySchema = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/,
    'Named Message key must use semantic identifier segments.',
  );

const assetRefSchema = z
  .object({
    $ref: z.object({ collection: z.literal('assets'), id: z.string().min(1) }).strict(),
  })
  .strict();
const fontAssetRefSchema = assetRefSchema;

export const localeDefinitionSchema = z
  .object({
    supported: z.boolean(),
    parentLocale: localeIdSchema.nullable(),
    fontStack: z.array(fontAssetRefSchema).nullable(),
    displayName: z.string().trim().min(1).optional(),
  })
  .strict();

export const messageArgumentTypeSchema = z.enum([
  'printable',
  'string',
  'number',
  'integer',
  'plural-number',
]);
export type MessageArgumentType = z.infer<typeof messageArgumentTypeSchema>;
export const messageArgumentsSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/u, 'Message argument name is invalid.'),
  messageArgumentTypeSchema,
);

const messageSelectorArgumentSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/u, 'Message selector argument name is invalid.');
const pluralCaseKeySchema = z.enum(['zero', 'one', 'two', 'few', 'many', 'other']);

export type MessagePattern =
  | { kind: 'text'; text: string }
  | { kind: 'plural'; argument: string; cases: Record<string, MessagePattern> }
  | { kind: 'select'; argument: string; cases: Record<string, MessagePattern> };

export const messagePatternSchema: z.ZodType<MessagePattern> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), text: z.string() }).strict(),
    z
      .object({
        kind: z.literal('plural'),
        argument: messageSelectorArgumentSchema,
        cases: z.partialRecord(pluralCaseKeySchema, messagePatternSchema),
      })
      .strict()
      .superRefine((pattern, context) => {
        if (!Object.hasOwn(pattern.cases, 'other'))
          context.addIssue({
            code: 'custom',
            path: ['cases', 'other'],
            message: "Plural Message selector requires an 'other' case.",
          });
      }),
    z
      .object({
        kind: z.literal('select'),
        argument: messageSelectorArgumentSchema,
        cases: z.record(z.string().min(1), messagePatternSchema),
      })
      .strict()
      .superRefine((pattern, context) => {
        if (!Object.hasOwn(pattern.cases, 'other'))
          context.addIssue({
            code: 'custom',
            path: ['cases', 'other'],
            message: "Select Message selector requires an 'other' fallback.",
          });
      }),
  ]),
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

export function messagePatternPlaceholderNames(pattern: MessagePattern): readonly string[] {
  const names = new Set<string>();
  const visit = (node: MessagePattern) => {
    if (node.kind === 'text') {
      messagePlaceholderNames(node.text).forEach((name) => names.add(name));
      return;
    }
    Object.values(node.cases).forEach(visit);
  };
  visit(pattern);
  return Object.freeze([...names].sort());
}

export type MessageSelectorContract = {
  argument: string;
  kind: 'plural' | 'select';
  selectCases?: readonly string[];
};

export function requiredPluralCategories(locale: string): readonly string[] {
  return Object.freeze([...cldrCardinalCategories(locale)].sort());
}

export type MessagePluralCategoryGap = { argument: string; category: string };

export function messagePatternPluralCategoryGaps(
  pattern: MessagePattern,
  locale: string,
): readonly MessagePluralCategoryGap[] {
  const gaps: MessagePluralCategoryGap[] = [];
  const required = requiredPluralCategories(locale);
  const visit = (node: MessagePattern) => {
    if (node.kind === 'text') return;
    if (node.kind === 'plural')
      for (const category of required)
        if (!Object.hasOwn(node.cases, category)) gaps.push({ argument: node.argument, category });
    Object.values(node.cases).forEach(visit);
  };
  visit(pattern);
  return Object.freeze(gaps);
}

export function messagePatternSelectorSignatures(pattern: MessagePattern): readonly string[] {
  const signatures: string[] = [];
  const visit = (node: MessagePattern) => {
    if (node.kind === 'text') return;
    const keys = node.kind === 'select' ? Object.keys(node.cases).sort() : [];
    signatures.push(`${node.kind}:${node.argument}${keys.map((key) => `:${key}`).join('')}`);
    Object.values(node.cases).forEach(visit);
  };
  visit(pattern);
  return Object.freeze(signatures.sort());
}

export function messagePatternSelectorContracts(
  pattern: MessagePattern,
): readonly MessageSelectorContract[] {
  const contracts = new Map<string, MessageSelectorContract>();
  const visit = (node: MessagePattern) => {
    if (node.kind === 'text') return;
    const current: MessageSelectorContract = {
      argument: node.argument,
      kind: node.kind,
      ...(node.kind === 'select' ? { selectCases: Object.keys(node.cases).sort() } : {}),
    };
    const existing = contracts.get(node.argument);
    if (!existing) contracts.set(node.argument, current);
    else if (
      existing.kind !== current.kind ||
      JSON.stringify(existing.selectCases ?? []) !== JSON.stringify(current.selectCases ?? [])
    )
      contracts.set(node.argument, { argument: node.argument, kind: 'select', selectCases: [] });
    Object.values(node.cases).forEach(visit);
  };
  visit(pattern);
  return Object.freeze(
    [...contracts.values()].sort((a, b) => a.argument.localeCompare(b.argument)),
  );
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
    pattern: messagePatternSchema.optional(),
    ...messageGuidanceFields,
  })
  .strict();

const namedMessageSchema = z
  .object({
    kind: z.literal('named'),
    key: namedMessageKeySchema,
    source: z.string(),
    pattern: messagePatternSchema.optional(),
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

export const dialogueCuePlacementSchema = z
  .object({
    id: z.string().min(1),
    position: z
      .object({
        offset: z.number().int().nonnegative(),
        order: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const localizationTranslationRecordSchema = z
  .object({
    text: z.string(),
    pattern: messagePatternSchema.optional(),
    dialogueCues: z.array(dialogueCuePlacementSchema).optional(),
    sourceFingerprint: localizationWorkflowFingerprintSchema,
    origin: z.enum(['human', 'ai', 'imported', 'unknown']),
    review: z.enum(['needs-review', 'reviewed']),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    acknowledgedPresentationFingerprint: localizationWorkflowFingerprintSchema.optional(),
    acknowledgedGuidanceFingerprint: localizationWorkflowFingerprintSchema.optional(),
    useSource: z.literal(true).optional(),
  })
  .strict();

export const localizationTranslationSchema = z.record(
  messageIdSchema,
  localizationTranslationRecordSchema,
);

export const localizationAssetVariantSchema = z
  .object({
    asset: assetRefSchema,
    sourceFingerprint: localizationWorkflowFingerprintSchema,
    origin: z.enum(['human', 'ai', 'imported', 'unknown']),
    review: z.enum(['needs-review', 'reviewed']),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  })
  .strict();

export const localizationAssetTargetSchema = z.union([
  z.object({ useSource: z.literal(true) }).strict(),
  localizationAssetVariantSchema,
]);

export const localizationAssetTargetsSchema = z.record(
  localeIdSchema,
  z.record(z.string().min(1), localizationAssetTargetSchema),
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

export function hasSubstantiveLocalizationWork(localization: {
  translations: Record<string, Record<string, unknown>>;
  assets: Record<string, Record<string, unknown>>;
}): boolean {
  return (
    Object.values(localization.translations).some((entries) => Object.keys(entries).length > 0) ||
    Object.values(localization.assets).some((entries) => Object.keys(entries).length > 0)
  );
}

export const authoringLocalizationSchema = z
  .object({
    sourceLocale: localeIdSchema,
    sourceLocaleLock: localeIdSchema.nullable().default(null),
    defaultLocale: localeIdSchema,
    locales: z.record(localeIdSchema, localeDefinitionSchema),
    messages: z.record(messageIdSchema, authoringMessageSchema),
    structuredMessageIds: z.record(z.string().min(1), messageIdSchema),
    usageNotes: z.record(z.string().min(1), z.string()),
    sourceMessageTracking: z.record(z.string().min(1), sourceMessageTrackingEntrySchema),
    orphanedMessages: z.record(messageIdSchema, orphanedLocalizationMessageSchema),
    translations: z.record(localeIdSchema, localizationTranslationSchema),
    assets: localizationAssetTargetsSchema,
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
    if (localization.sourceLocaleLock !== null) {
      if (!Object.hasOwn(localization.locales, localization.sourceLocaleLock))
        context.addIssue({
          code: 'custom',
          path: ['sourceLocaleLock'],
          message: `Source locale lock '${localization.sourceLocaleLock}' must be a declared locale.`,
        });
      if (localization.sourceLocaleLock !== localization.sourceLocale)
        context.addIssue({
          code: 'custom',
          path: ['sourceLocale'],
          message: `Source locale cannot change from locked locale '${localization.sourceLocaleLock}' after substantive localization work exists.`,
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
      const placeholders = new Set(messagePlaceholderNames(message.source));
      if (message.pattern)
        messagePatternPlaceholderNames(message.pattern).forEach((name) => placeholders.add(name));
      for (const placeholder of placeholders)
        if (!argumentNames.has(placeholder))
          context.addIssue({
            code: 'custom',
            path: ['messages', messageId, message.pattern ? 'pattern' : 'source'],
            message: `Message placeholder '{${placeholder}}' requires a declared argument.`,
          });
      if (message.pattern) {
        for (const selector of messagePatternSelectorContracts(message.pattern)) {
          const expectedType = selector.kind === 'plural' ? 'plural-number' : 'string';
          if (message.arguments?.[selector.argument] !== expectedType)
            context.addIssue({
              code: 'custom',
              path: ['messages', messageId, 'arguments', selector.argument],
              message: `Message ${selector.kind} selector '${selector.argument}' requires argument type '${expectedType}'.`,
            });
        }
        for (const gap of messagePatternPluralCategoryGaps(
          message.pattern,
          localization.sourceLocale,
        ))
          context.addIssue({
            code: 'custom',
            path: ['messages', messageId, 'pattern'],
            message: `Plural selector '${gap.argument}' requires '${gap.category}' for locale '${localization.sourceLocale}'.`,
          });
      }
      if (message.kind !== 'named') continue;
      const systemMessage = systemMessageDefinitionForKey(message.key);
      if (isReservedSystemMessageKey(message.key) && !systemMessage) {
        context.addIssue({
          code: 'custom',
          path: ['messages', messageId, 'key'],
          message: `Named Message key '${message.key}' is reserved for engine-owned NovelTea Messages.`,
        });
      }
      if (systemMessage) {
        const authoredArguments = Object.entries(message.arguments ?? {}).sort(([left], [right]) =>
          left.localeCompare(right),
        );
        const systemArguments = Object.entries(systemMessage.arguments).sort(([left], [right]) =>
          left.localeCompare(right),
        );
        if (JSON.stringify(authoredArguments) !== JSON.stringify(systemArguments))
          context.addIssue({
            code: 'custom',
            path: ['messages', messageId, 'arguments'],
            message: `System Message '${message.key}' must preserve its engine-owned argument contract.`,
          });
      }
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

    for (const locale of Object.keys(localization.assets)) {
      if (!Object.hasOwn(localization.locales, locale))
        context.addIssue({
          code: 'custom',
          path: ['assets', locale],
          message: `Localized Asset locale '${locale}' must be declared.`,
        });
      if (locale === localization.sourceLocale)
        context.addIssue({
          code: 'custom',
          path: ['assets', locale],
          message: 'Source locale uses semantic base Assets directly.',
        });
    }
  })
  .transform((localization) =>
    localization.sourceLocaleLock === null && hasSubstantiveLocalizationWork(localization)
      ? { ...localization, sourceLocaleLock: localization.sourceLocale }
      : localization,
  );

export type AuthoringMessage = z.infer<typeof authoringMessageSchema>;
export type DialogueCuePlacement = z.infer<typeof dialogueCuePlacementSchema>;
export type LocalizationTranslation = z.infer<typeof localizationTranslationRecordSchema>;
export type LocalizationAssetVariant = z.infer<typeof localizationAssetVariantSchema>;
export type LocalizationAssetTarget = z.infer<typeof localizationAssetTargetSchema>;
export type SourceMessageTrackingOccurrence = z.infer<typeof sourceMessageTrackingOccurrenceSchema>;
export type SourceMessageTrackingEntry = z.infer<typeof sourceMessageTrackingEntrySchema>;
export type OrphanedLocalizationMessage = z.infer<typeof orphanedLocalizationMessageSchema>;
export type AuthoringLocalization = z.infer<typeof authoringLocalizationSchema>;

export function defaultAuthoringLocalization(): AuthoringLocalization {
  return {
    sourceLocale: 'en',
    sourceLocaleLock: null,
    defaultLocale: 'en',
    locales: { en: { supported: true, parentLocale: null, fontStack: null } },
    messages: {},
    structuredMessageIds: {},
    usageNotes: {},
    sourceMessageTracking: {},
    orphanedMessages: {},
    translations: {},
    assets: {},
  };
}
