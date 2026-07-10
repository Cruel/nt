import { DEFAULT_PROJECT_DISPLAY_SETTINGS, normalizeProjectDisplaySettings, type ProjectDisplaySettings } from './project-schema/authoring-project-settings';

export type PreviewScalingMode = 'responsive' | 'reference';
export interface PreviewScalingPreference { play: PreviewScalingMode; pooled: PreviewScalingMode; referenceLongAxis: number }
export type PreviewDisplayPreference =
  | { mode: 'project'; scaling: PreviewScalingPreference }
  | { mode: 'custom'; aspectRatio: { width: number; height: number }; orientation: 'landscape' | 'portrait'; scaling: PreviewScalingPreference };

export const DEFAULT_PREVIEW_SCALING: PreviewScalingPreference = { play: 'responsive', pooled: 'reference', referenceLongAxis: 1280 };
export const DEFAULT_PREVIEW_DISPLAY_PREFERENCE: PreviewDisplayPreference = { mode: 'project', scaling: DEFAULT_PREVIEW_SCALING };

export function normalizePreviewDisplayPreference(value: unknown): PreviewDisplayPreference {
  const record = value && typeof value === 'object' ? value as Partial<PreviewDisplayPreference> : {};
  const rawScaling = record.scaling && typeof record.scaling === 'object' ? record.scaling : DEFAULT_PREVIEW_SCALING;
  const scaling: PreviewScalingPreference = {
    play: rawScaling.play === 'reference' ? 'reference' : 'responsive',
    pooled: rawScaling.pooled === 'responsive' ? 'responsive' : 'reference',
    referenceLongAxis: Number.isInteger(rawScaling.referenceLongAxis) ? Math.min(4096, Math.max(320, rawScaling.referenceLongAxis!)) : 1280,
  };
  if (record.mode !== 'custom') return { mode: 'project', scaling };
  try {
    const normalized = normalizeProjectDisplaySettings({ aspectRatio: record.aspectRatio, orientation: record.orientation, barColor: '#000000' });
    return { mode: 'custom', aspectRatio: normalized.aspectRatio, orientation: normalized.orientation, scaling };
  } catch {
    return { mode: 'project', scaling };
  }
}

export function effectivePreviewDisplay(preference: PreviewDisplayPreference, projectDisplay?: ProjectDisplaySettings): ProjectDisplaySettings {
  if (preference.mode === 'custom') return { aspectRatio: preference.aspectRatio, orientation: preference.orientation, barColor: projectDisplay?.barColor ?? '#000000' };
  return projectDisplay ?? { ...DEFAULT_PROJECT_DISPLAY_SETTINGS };
}

export function effectiveAspectRatio(profile: ProjectDisplaySettings) {
  return profile.orientation === 'portrait'
    ? { width: profile.aspectRatio.height, height: profile.aspectRatio.width }
    : profile.aspectRatio;
}

export function fitPreviewRect(width: number, height: number, profile: ProjectDisplaySettings) {
  const ratio = effectiveAspectRatio(profile);
  const fittedWidth = Math.min(width, Math.floor(height * ratio.width / ratio.height));
  const fittedHeight = Math.min(height, Math.floor(width * ratio.height / ratio.width));
  const useWidth = Math.max(1, fittedWidth);
  const useHeight = Math.max(1, fittedHeight);
  return { x: Math.floor((width - useWidth) / 2), y: Math.floor((height - useHeight) / 2), width: useWidth, height: useHeight };
}

export function referencePreviewSize(profile: ProjectDisplaySettings, longAxis: number) {
  const ratio = effectiveAspectRatio(profile);
  return ratio.width >= ratio.height
    ? { width: longAxis, height: Math.max(1, Math.round(longAxis * ratio.height / ratio.width)) }
    : { width: Math.max(1, Math.round(longAxis * ratio.width / ratio.height)), height: longAxis };
}
