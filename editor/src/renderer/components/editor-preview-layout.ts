import type { ProjectDisplaySettings } from '../../shared/project-schema/authoring-project-settings';

export const editorPreviewLayoutPreferenceValues = ['automatic', 'vertical', 'horizontal'] as const;

export type EditorPreviewLayoutPreference = (typeof editorPreviewLayoutPreferenceValues)[number];

export type EditorPreviewSplitOrientation = 'vertical' | 'horizontal';

export function normalizeEditorPreviewLayoutPreference(
  value: unknown,
): EditorPreviewLayoutPreference {
  return editorPreviewLayoutPreferenceValues.includes(value as EditorPreviewLayoutPreference)
    ? (value as EditorPreviewLayoutPreference)
    : 'automatic';
}

export function resolveEditorPreviewSplitOrientation(
  preference: EditorPreviewLayoutPreference,
  display: ProjectDisplaySettings,
): EditorPreviewSplitOrientation {
  if (preference !== 'automatic') return preference;
  return display.referenceResolution.width >= display.referenceResolution.height
    ? 'vertical'
    : 'horizontal';
}
