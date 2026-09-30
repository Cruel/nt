import type { TFunction } from 'i18next';

type DiagnosticMessageSource = {
  code?: string;
  message: string;
};

const diagnosticMessageKeys = {
  'hotspot.authoring.target.none': 'diagnosticMessages.hotspotAuthoringTargetNone',
  AUTHORING_HOTSPOT_AUTHORING_TARGET_NONE: 'diagnosticMessages.hotspotAuthoringTargetNone',
} as const;

export function localizedDiagnosticMessage(
  diagnostic: DiagnosticMessageSource,
  t: TFunction<'workspace'>,
): string {
  const key = diagnostic.code
    ? diagnosticMessageKeys[diagnostic.code as keyof typeof diagnosticMessageKeys]
    : undefined;
  return key ? t(key) : diagnostic.message;
}
