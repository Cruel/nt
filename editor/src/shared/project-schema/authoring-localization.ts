import { z } from 'zod';

export const localeIdSchema = z.string().trim().min(1, 'Locale is required.');
export const localizationKeySchema = z.string().min(1, 'Localization key is required.');
export const localizationCatalogSchema = z.record(localizationKeySchema, z.string());

export const authoringLocalizationSchema = z
  .object({
    defaultLocale: localeIdSchema,
    fallbackLocale: localeIdSchema.nullable(),
    catalogs: z.record(localeIdSchema, localizationCatalogSchema),
  })
  .strict()
  .superRefine((localization, context) => {
    if (!Object.hasOwn(localization.catalogs, localization.defaultLocale)) {
      context.addIssue({
        code: 'custom',
        path: ['catalogs', localization.defaultLocale],
        message: `Default locale '${localization.defaultLocale}' requires a catalog.`,
      });
    }
    if (
      localization.fallbackLocale !== null &&
      !Object.hasOwn(localization.catalogs, localization.fallbackLocale)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['catalogs', localization.fallbackLocale],
        message: `Fallback locale '${localization.fallbackLocale}' requires a catalog.`,
      });
    }
  });

export type AuthoringLocalization = z.infer<typeof authoringLocalizationSchema>;

export function defaultAuthoringLocalization(): AuthoringLocalization {
  return { defaultLocale: 'en', fallbackLocale: null, catalogs: { en: {} } };
}
