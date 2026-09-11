import type { LocalizationTranslation } from '../../../shared/project-schema/authoring-localization';

export function testTranslation(
  text: string,
  patch: Partial<LocalizationTranslation> = {},
): LocalizationTranslation {
  return {
    text,
    sourceFingerprint: 'fnv1a:00000000000000000000000000000000',
    origin: 'human',
    review: 'needs-review',
    ...patch,
  };
}
