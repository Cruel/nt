import {
  DEFAULT_PROJECT_DISPLAY_SETTINGS,
  deriveProjectDisplayGeometry,
  type ProjectDisplaySettings,
} from './project-schema/authoring-project-settings';

export interface PreviewDisplayProfile {
  aspectRatio: { width: number; height: number };
  orientation: 'landscape' | 'portrait';
  barColor: string;
}

export type PreviewScalingMode = 'responsive' | 'reference';
export interface PreviewScalingPreference {
  play: PreviewScalingMode;
  pooled: PreviewScalingMode;
  referenceLongAxis: number;
}
export type PreviewDisplayPreference =
  | { mode: 'project'; scaling: PreviewScalingPreference }
  | {
      mode: 'custom';
      aspectRatio: { width: number; height: number };
      orientation: 'landscape' | 'portrait';
      scaling: PreviewScalingPreference;
    };

export const DEFAULT_PREVIEW_SCALING: PreviewScalingPreference = {
  play: 'responsive',
  pooled: 'reference',
  referenceLongAxis: 1280,
};
export const DEFAULT_PREVIEW_DISPLAY_PREFERENCE: PreviewDisplayPreference = {
  mode: 'project',
  scaling: DEFAULT_PREVIEW_SCALING,
};

export function normalizePreviewDisplayPreference(value: unknown): PreviewDisplayPreference {
  const record =
    value && typeof value === 'object' ? (value as Partial<PreviewDisplayPreference>) : {};
  const rawScaling =
    record.scaling && typeof record.scaling === 'object' ? record.scaling : DEFAULT_PREVIEW_SCALING;
  const scaling: PreviewScalingPreference = {
    play: rawScaling.play === 'reference' ? 'reference' : 'responsive',
    pooled: rawScaling.pooled === 'responsive' ? 'responsive' : 'reference',
    referenceLongAxis: Number.isInteger(rawScaling.referenceLongAxis)
      ? Math.min(4096, Math.max(320, rawScaling.referenceLongAxis!))
      : 1280,
  };
  if (record.mode !== 'custom') return { mode: 'project', scaling };
  const width = record.aspectRatio?.width;
  const height = record.aspectRatio?.height;
  if (
    Number.isSafeInteger(width) &&
    Number(width) > 0 &&
    Number.isSafeInteger(height) &&
    Number(height) > 0 &&
    (record.orientation === 'landscape' || record.orientation === 'portrait')
  ) {
    const divisor = greatestCommonDivisor(Number(width), Number(height));
    return {
      mode: 'custom',
      aspectRatio: { width: Number(width) / divisor, height: Number(height) / divisor },
      orientation: record.orientation,
      scaling,
    };
  }
  return { mode: 'project', scaling };
}

function greatestCommonDivisor(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

export function effectivePreviewDisplay(
  preference: PreviewDisplayPreference,
  projectDisplay?: ProjectDisplaySettings,
): PreviewDisplayProfile {
  if (preference.mode === 'custom')
    return {
      aspectRatio: preference.aspectRatio,
      orientation: preference.orientation,
      barColor: projectDisplay?.barColor ?? '#000000',
    };
  const display = projectDisplay ?? DEFAULT_PROJECT_DISPLAY_SETTINGS;
  const derived =
    deriveProjectDisplayGeometry(display.referenceResolution) ??
    deriveProjectDisplayGeometry(DEFAULT_PROJECT_DISPLAY_SETTINGS.referenceResolution)!;
  const aspectRatio =
    derived.orientation === 'portrait'
      ? { width: derived.aspectRatio.height, height: derived.aspectRatio.width }
      : derived.aspectRatio;
  return { aspectRatio, orientation: derived.orientation, barColor: display.barColor };
}

export function effectiveAspectRatio(profile: PreviewDisplayProfile) {
  return profile.orientation === 'portrait'
    ? { width: profile.aspectRatio.height, height: profile.aspectRatio.width }
    : profile.aspectRatio;
}

export function fitPreviewRect(width: number, height: number, profile: PreviewDisplayProfile) {
  const ratio = effectiveAspectRatio(profile);
  const fittedWidth = Math.min(width, Math.floor((height * ratio.width) / ratio.height));
  const fittedHeight = Math.min(height, Math.floor((width * ratio.height) / ratio.width));
  const useWidth = Math.max(1, fittedWidth);
  const useHeight = Math.max(1, fittedHeight);
  return {
    x: Math.floor((width - useWidth) / 2),
    y: Math.floor((height - useHeight) / 2),
    width: useWidth,
    height: useHeight,
  };
}

export function referencePreviewSize(profile: PreviewDisplayProfile, longAxis: number) {
  const ratio = effectiveAspectRatio(profile);
  return ratio.width >= ratio.height
    ? { width: longAxis, height: Math.max(1, Math.round((longAxis * ratio.height) / ratio.width)) }
    : { width: Math.max(1, Math.round((longAxis * ratio.width) / ratio.height)), height: longAxis };
}
