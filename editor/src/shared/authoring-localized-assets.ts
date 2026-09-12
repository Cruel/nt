import { localizationTrackingFingerprint } from './localization-source-tracking';
import { parseAssetData, type AssetKind } from './project-schema/authoring-assets';
import type {
  LocalizationAssetTarget,
  LocalizationAssetVariant,
} from './project-schema/authoring-localization';
import type { AuthoringProject } from './project-schema/authoring-project';

export const localizableAssetKinds = [
  'image',
  'audio',
  'video',
] as const satisfies readonly AssetKind[];
export type LocalizableAssetKind = (typeof localizableAssetKinds)[number];
export type LocalizationAssetFreshness = 'missing' | 'current' | 'outdated';

export interface EffectiveLocalizationAssetTarget {
  readonly locale: string | null;
  readonly inherited: boolean;
  readonly target: LocalizationAssetTarget | null;
}

export interface LocalizationAssetWorkflowView {
  readonly baseAssetId: string;
  readonly baseKind: LocalizableAssetKind;
  readonly locale: string;
  readonly effectiveLocale: string | null;
  readonly inherited: boolean;
  readonly target: LocalizationAssetTarget | null;
  readonly sourceFingerprint: string;
  readonly freshness: LocalizationAssetFreshness;
}

export function isLocalizableAssetKind(kind: AssetKind): kind is LocalizableAssetKind {
  return (localizableAssetKinds as readonly string[]).includes(kind);
}

export function localizationAssetSourceFingerprint(
  project: AuthoringProject,
  baseAssetId: string,
): string | null {
  const data = parseAssetData(project.assets[baseAssetId]?.data);
  if (!data || !isLocalizableAssetKind(data.kind)) return null;
  return localizationTrackingFingerprint(
    JSON.stringify([data.kind, data.contentHash ?? data.source.path]),
  );
}

export function effectiveLocalizationAssetTarget(
  project: AuthoringProject,
  locale: string,
  baseAssetId: string,
): EffectiveLocalizationAssetTarget {
  const visited = new Set<string>();
  let current: string | null = locale;
  while (current && current !== project.localization.sourceLocale && !visited.has(current)) {
    visited.add(current);
    const target = project.localization.assets[current]?.[baseAssetId];
    if (target) return { locale: current, inherited: current !== locale, target };
    current = project.localization.locales[current]?.parentLocale ?? null;
  }
  return { locale: null, inherited: false, target: null };
}

export function localizationAssetWorkflowView(
  project: AuthoringProject,
  locale: string,
  baseAssetId: string,
): LocalizationAssetWorkflowView | null {
  const data = parseAssetData(project.assets[baseAssetId]?.data);
  if (!data || !isLocalizableAssetKind(data.kind)) return null;
  const sourceFingerprint = localizationAssetSourceFingerprint(project, baseAssetId)!;
  const effective = effectiveLocalizationAssetTarget(project, locale, baseAssetId);
  const freshness: LocalizationAssetFreshness = !effective.target
    ? 'missing'
    : 'useSource' in effective.target || effective.target.sourceFingerprint === sourceFingerprint
      ? 'current'
      : 'outdated';
  return {
    baseAssetId,
    baseKind: data.kind,
    locale,
    effectiveLocale: effective.locale,
    inherited: effective.inherited,
    target: effective.target,
    sourceFingerprint,
    freshness,
  };
}

export function createLocalizedAssetVariant(
  project: AuthoringProject,
  baseAssetId: string,
  variantAssetId: string,
  origin: LocalizationAssetVariant['origin'] = 'human',
): LocalizationAssetVariant | null {
  const base = parseAssetData(project.assets[baseAssetId]?.data);
  const variant = parseAssetData(project.assets[variantAssetId]?.data);
  const sourceFingerprint = localizationAssetSourceFingerprint(project, baseAssetId);
  if (
    !base ||
    !variant ||
    !sourceFingerprint ||
    baseAssetId === variantAssetId ||
    !isLocalizableAssetKind(base.kind) ||
    variant.kind !== base.kind
  )
    return null;
  return {
    asset: { $ref: { collection: 'assets', id: variantAssetId } },
    sourceFingerprint,
    origin,
    review: 'needs-review',
  };
}
