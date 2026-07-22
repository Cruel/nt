import {
  DEFAULT_PROJECT_ACCESSIBILITY_SETTINGS,
  DEFAULT_PROJECT_DISPLAY_SETTINGS,
  deriveProjectDisplayGeometry,
  type ProjectAccessibilitySettings,
  type ProjectDisplaySettings,
} from './project-schema/authoring-project-settings';
import type { AuthoredPreviewEnvironment, PreviewDocument } from './preview-protocol';

export interface PreviewDisplayProfile {
  name: string;
  nativeResolution: { width: number; height: number };
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

function customNativeResolution(
  aspectRatio: { width: number; height: number },
  orientation: 'landscape' | 'portrait',
  projectDisplay?: ProjectDisplaySettings,
) {
  const longAxis = Math.max(
    projectDisplay?.referenceResolution.width ??
      DEFAULT_PROJECT_DISPLAY_SETTINGS.referenceResolution.width,
    projectDisplay?.referenceResolution.height ??
      DEFAULT_PROJECT_DISPLAY_SETTINGS.referenceResolution.height,
  );
  const ratioLong = Math.max(aspectRatio.width, aspectRatio.height);
  const ratioShort = Math.min(aspectRatio.width, aspectRatio.height);
  const shortAxis = Math.max(1, Math.round((longAxis * ratioShort) / ratioLong));
  return orientation === 'portrait'
    ? { width: shortAxis, height: longAxis }
    : { width: longAxis, height: shortAxis };
}

export function effectivePreviewDisplay(
  preference: PreviewDisplayPreference,
  projectDisplay?: ProjectDisplaySettings,
): PreviewDisplayProfile {
  if (preference.mode === 'custom')
    return {
      name: `custom-${preference.aspectRatio.width}x${preference.aspectRatio.height}-${preference.orientation}`,
      nativeResolution: customNativeResolution(
        preference.aspectRatio,
        preference.orientation,
        projectDisplay,
      ),
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
  return {
    name: 'project',
    nativeResolution: display.referenceResolution,
    aspectRatio,
    orientation: derived.orientation,
    barColor: display.barColor,
  };
}

export function authoredPreviewEnvironment(
  document: PreviewDocument,
  profile: PreviewDisplayProfile,
  projectDisplay?: ProjectDisplaySettings,
  projectAccessibility?: ProjectAccessibilitySettings,
): AuthoredPreviewEnvironment | undefined {
  if (document.kind !== 'layout-preview') return undefined;
  const scalePolicy = document.data.scalePolicy;
  if (
    !scalePolicy ||
    typeof scalePolicy !== 'object' ||
    !('ui' in scalePolicy) ||
    !('text' in scalePolicy) ||
    (scalePolicy.ui !== 'inherit' && scalePolicy.ui !== 'ignore') ||
    (scalePolicy.text !== 'inherit' && scalePolicy.text !== 'ignore')
  ) {
    return undefined;
  }
  const display = projectDisplay ?? DEFAULT_PROJECT_DISPLAY_SETTINGS;
  return {
    profile: {
      name: profile.name,
      nativeResolution: profile.nativeResolution,
      scalePolicy: { ui: scalePolicy.ui, text: scalePolicy.text },
    },
    project: {
      referenceResolution: display.referenceResolution,
      worldRasterPolicy: display.worldRasterPolicy,
      barColor: display.barColor,
      accessibility: projectAccessibility ?? DEFAULT_PROJECT_ACCESSIBILITY_SETTINGS,
    },
  };
}
