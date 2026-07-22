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

export type PreviewDisplayPreference =
  | { mode: 'project' }
  | {
      mode: 'custom';
      aspectRatio: { width: number; height: number };
      orientation: 'landscape' | 'portrait';
    };

export const DEFAULT_PREVIEW_DISPLAY_PREFERENCE: PreviewDisplayPreference = {
  mode: 'project',
};

export function normalizePreviewDisplayPreference(value: unknown): PreviewDisplayPreference {
  const record =
    value && typeof value === 'object' ? (value as Partial<PreviewDisplayPreference>) : {};
  if (record.mode !== 'custom') return { mode: 'project' };
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
    };
  }
  return { mode: 'project' };
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
