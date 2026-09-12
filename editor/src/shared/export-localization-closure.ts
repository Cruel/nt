import {
  effectiveLocalizationAssetTarget,
  localizationAssetWorkflowView,
} from './authoring-localized-assets';
import {
  localizationMessageWorkflowViews,
  localizationTargetWorkflowView,
} from './authoring-localization-workflow';
import { packageMessageIds } from './authoring-message-lowering';
import type { ExportLocalizationPolicy } from './project-schema/authoring-export';
import type { AuthoringProject } from './project-schema/authoring-project';
import type { CompiledProjectWire } from './project-schema/compiled-project';
import {
  createProjectValidationDiagnostic,
  type ProjectValidationDiagnostic,
} from './project-schema/project-validation';

export interface PreparedLocalizationClosure {
  includedLocales: string[];
  defaultLocale: string;
  quality: ExportLocalizationPolicy['quality'];
  sourceFallback: {
    messageCount: number;
    assetCount: number;
  };
}

export interface ExportLocalizationClosureResult {
  project: CompiledProjectWire;
  diagnostics: ProjectValidationDiagnostic[];
  payloadAssetIds: ReadonlySet<string>;
  requiredLocalizationAssetIds: ReadonlySet<string>;
  closure: PreparedLocalizationClosure;
}

function diagnostic(
  code: string,
  severity: 'warning' | 'error',
  path: string,
  message: string,
): ProjectValidationDiagnostic {
  return createProjectValidationDiagnostic({
    code,
    severity,
    path,
    message,
    category: 'Localization export',
    boundaries: ['runtime-package', 'platform-export'],
    ownerPaths: [path],
  });
}

function shouldWarnOutdated(quality: ExportLocalizationPolicy['quality']): boolean {
  return quality === 'release' || quality === 'reviewed-release';
}

function shouldWarnReview(quality: ExportLocalizationPolicy['quality']): boolean {
  return quality === 'reviewed-release';
}

export function applyExportLocalizationClosure(
  authoringProject: AuthoringProject,
  compiledProject: CompiledProjectWire,
  policy: ExportLocalizationPolicy,
  includedBaseAssetIds: ReadonlySet<string> | null = null,
): ExportLocalizationClosureResult {
  const diagnostics: ProjectValidationDiagnostic[] = [];
  const includedLocales = [...new Set(policy.locales)];
  if (includedLocales.length !== policy.locales.length)
    diagnostics.push(
      diagnostic(
        'localization.export.duplicate_locale',
        'error',
        '/export/localization/locales',
        'Export locale selections must not contain duplicates.',
      ),
    );
  if (!includedLocales.includes(policy.defaultLocale))
    diagnostics.push(
      diagnostic(
        'localization.export.default_not_included',
        'error',
        '/export/localization/defaultLocale',
        `Export default locale '${policy.defaultLocale}' must be included in the export locale set.`,
      ),
    );
  for (const locale of includedLocales) {
    const definition = authoringProject.localization.locales[locale];
    if (!definition || !definition.supported)
      diagnostics.push(
        diagnostic(
          'localization.export.locale_not_supported',
          'error',
          '/export/localization/locales',
          `Export locale '${locale}' must be a declared Supported locale.`,
        ),
      );
  }

  const compiledCatalogs = new Map(
    compiledProject.localization.catalogs.map((catalog) => [catalog.locale, catalog] as const),
  );
  const sourceCatalog = compiledCatalogs.get(compiledProject.localization.sourceLocale);
  const sourceEntries = new Map(
    (sourceCatalog?.entries ?? []).map((entry) => [entry.messageId, entry] as const),
  );
  const packageIds = packageMessageIds(authoringProject);
  const fallbackMessageIds = new Set<number>();
  const preparedCatalogs: CompiledProjectWire['localization']['catalogs'] = [];

  for (const locale of includedLocales) {
    const existing = new Map(
      (compiledCatalogs.get(locale)?.entries ?? []).map(
        (entry) => [entry.messageId, entry] as const,
      ),
    );
    const entries = [...sourceEntries.keys()]
      .sort((left, right) => left - right)
      .flatMap((messageId) => {
        const localized = existing.get(messageId);
        if (localized) return [structuredClone(localized)];
        const source = sourceEntries.get(messageId);
        if (!source) return [];
        fallbackMessageIds.add(messageId);
        return [structuredClone(source)];
      });
    preparedCatalogs.push({ locale, entries });
  }

  for (const message of localizationMessageWorkflowViews(authoringProject)) {
    const messageId = packageIds.get(message.id);
    if (messageId === undefined) continue;
    for (const locale of includedLocales) {
      if (locale === authoringProject.localization.sourceLocale) continue;
      const target = localizationTargetWorkflowView(authoringProject, locale, message);
      if (target.translation?.useSource) {
        fallbackMessageIds.add(messageId);
        continue;
      }
      if (target.freshness === 'missing') {
        fallbackMessageIds.add(messageId);
        diagnostics.push(
          diagnostic(
            'localization.export.message_missing',
            'warning',
            `/localization/translations/${locale}/${message.id}`,
            `Locale '${locale}' is missing Message '${message.id}'; the source realization will be packaged as fallback.`,
          ),
        );
      } else if (target.freshness === 'outdated' && shouldWarnOutdated(policy.quality)) {
        diagnostics.push(
          diagnostic(
            'localization.export.message_outdated',
            'warning',
            `/localization/translations/${locale}/${message.id}`,
            `Locale '${locale}' has an outdated translation for Message '${message.id}'.`,
          ),
        );
      }
      if (
        target.translation &&
        !target.translation.useSource &&
        target.translation.review === 'needs-review' &&
        shouldWarnReview(policy.quality)
      )
        diagnostics.push(
          diagnostic(
            'localization.export.message_needs_review',
            'warning',
            `/localization/translations/${locale}/${message.id}`,
            `Locale '${locale}' has a translation needing review for Message '${message.id}'.`,
          ),
        );
    }
  }

  const selectedMappings = new Map<
    string,
    Array<{ locale: string; state: 'source' | 'variant'; asset?: { kind: 'asset'; id: string } }>
  >();
  const fallbackAssetIds = new Set<string>();
  const selectedVariantIds = new Set<string>();
  const allVariantIds = new Set<string>();
  for (const targets of Object.values(authoringProject.localization.assets))
    for (const target of Object.values(targets))
      if (!('useSource' in target)) allVariantIds.add(target.asset.$ref.id);

  for (const asset of compiledProject.resources.assets) {
    if (allVariantIds.has(asset.id) && !includedBaseAssetIds?.has(asset.id)) continue;
    if (includedBaseAssetIds && !includedBaseAssetIds.has(asset.id)) continue;
    const mappings: Array<{
      locale: string;
      state: 'source' | 'variant';
      asset?: { kind: 'asset'; id: string };
    }> = [];
    for (const locale of includedLocales) {
      const view = localizationAssetWorkflowView(authoringProject, locale, asset.id);
      if (!view) continue;
      if (locale === authoringProject.localization.sourceLocale) {
        mappings.push({ locale, state: 'source' });
        continue;
      }
      const effective = effectiveLocalizationAssetTarget(authoringProject, locale, asset.id);
      if (effective.target && !('useSource' in effective.target)) {
        const variantId = effective.target.asset.$ref.id;
        selectedVariantIds.add(variantId);
        mappings.push({ locale, state: 'variant', asset: { kind: 'asset', id: variantId } });
        if (view.freshness === 'outdated' && shouldWarnOutdated(policy.quality))
          diagnostics.push(
            diagnostic(
              'localization.export.asset_outdated',
              'warning',
              `/localization/assets/${locale}/${asset.id}`,
              `Locale '${locale}' has an outdated localized Asset variant for '${asset.id}'.`,
            ),
          );
        if (effective.target.review === 'needs-review' && shouldWarnReview(policy.quality))
          diagnostics.push(
            diagnostic(
              'localization.export.asset_needs_review',
              'warning',
              `/localization/assets/${locale}/${asset.id}`,
              `Locale '${locale}' has a localized Asset variant needing review for '${asset.id}'.`,
            ),
          );
      } else {
        mappings.push({ locale, state: 'source' });
        fallbackAssetIds.add(asset.id);
        if (!effective.target)
          diagnostics.push(
            diagnostic(
              'localization.export.asset_missing',
              'warning',
              `/localization/assets/${locale}/${asset.id}`,
              `Locale '${locale}' is missing a localized realization for Asset '${asset.id}'; the source Asset will be packaged as fallback.`,
            ),
          );
      }
    }
    if (mappings.length > 0) selectedMappings.set(asset.id, mappings);
  }

  const payloadAssetIds = new Set(compiledProject.resources.assets.map((asset) => asset.id));
  for (const [baseId, mappings] of selectedMappings)
    if (mappings.length > 0 && mappings.every((mapping) => mapping.state === 'variant'))
      payloadAssetIds.delete(baseId);
  const requiredLocalizationAssetIds = new Set<string>([
    ...selectedVariantIds,
    ...fallbackAssetIds,
  ]);
  for (const variantId of selectedVariantIds) payloadAssetIds.add(variantId);
  for (const baseId of fallbackAssetIds) payloadAssetIds.add(baseId);
  for (const locale of includedLocales) {
    const compiledLocale = compiledProject.localization.locales.find(
      (item) => item.locale === locale,
    );
    for (const font of compiledLocale?.fontStack ?? []) {
      payloadAssetIds.add(font.id);
      requiredLocalizationAssetIds.add(font.id);
    }
  }

  const preparedAssets = compiledProject.resources.assets.map((asset) => {
    const mappings = selectedMappings.get(asset.id);
    if (!mappings) {
      const { localized: _localized, ...rest } = asset;
      return rest;
    }
    return { ...asset, localized: mappings };
  }) as CompiledProjectWire['resources']['assets'];
  const preparedLocales = includedLocales.flatMap((locale) => {
    const definition = compiledProject.localization.locales.find((item) => item.locale === locale);
    return definition ? [{ ...definition, parentLocale: null, supported: true }] : [];
  });

  return {
    project: {
      ...compiledProject,
      localization: {
        sourceLocale: policy.defaultLocale,
        defaultLocale: policy.defaultLocale,
        locales: preparedLocales,
        catalogs: preparedCatalogs,
      },
      resources: { ...compiledProject.resources, assets: preparedAssets },
    },
    diagnostics,
    payloadAssetIds,
    requiredLocalizationAssetIds,
    closure: {
      includedLocales,
      defaultLocale: policy.defaultLocale,
      quality: policy.quality,
      sourceFallback: {
        messageCount: fallbackMessageIds.size,
        assetCount: fallbackAssetIds.size,
      },
    },
  };
}

export function localizationWarningDiagnostics(
  diagnostics: readonly ProjectValidationDiagnostic[],
): ProjectValidationDiagnostic[] {
  return diagnostics.filter(
    (item) => item.severity === 'warning' && item.code.startsWith('localization.export.'),
  );
}
