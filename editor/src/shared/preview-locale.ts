import { localizationMessageWorkflowViews } from './authoring-localization-workflow';
import { synchronizeLocalizationMessageTracking } from './authoring-localization-sync';
import {
  PSEUDO_PREVIEW_LOCALE,
  pseudoLocalizationTranslation,
  pseudoPreviewRuntimeLocale,
} from './pseudo-localization';
import type { AuthoringProject } from './project-schema/authoring-project';

export function effectivePreviewLocale(project: AuthoringProject): string {
  const requested = project.editor.previewLocale;
  if (requested === PSEUDO_PREVIEW_LOCALE) return requested;
  if (requested && project.localization.locales[requested]) return requested;
  return project.localization.defaultLocale;
}

export function projectWithPreviewLocale(project: AuthoringProject): AuthoringProject {
  const locale = effectivePreviewLocale(project);
  if (locale === project.localization.defaultLocale) return project;
  if (locale === PSEUDO_PREVIEW_LOCALE) {
    const synchronized = synchronizeLocalizationMessageTracking(project).project;
    const runtimeLocale = pseudoPreviewRuntimeLocale(synchronized.localization.sourceLocale);
    const sourceDefinition =
      synchronized.localization.locales[synchronized.localization.sourceLocale]!;
    const translations = Object.fromEntries(
      localizationMessageWorkflowViews(synchronized).map((message) => [
        message.id,
        pseudoLocalizationTranslation(message),
      ]),
    );
    return {
      ...synchronized,
      localization: {
        ...synchronized.localization,
        defaultLocale: runtimeLocale,
        locales: {
          ...synchronized.localization.locales,
          [runtimeLocale]: {
            supported: true,
            parentLocale: synchronized.localization.sourceLocale,
            fontStack:
              sourceDefinition.fontStack === null
                ? null
                : sourceDefinition.fontStack.map((font) => structuredClone(font)),
          },
        },
        translations: {
          ...synchronized.localization.translations,
          [runtimeLocale]: translations,
        },
      },
    };
  }
  return {
    ...project,
    localization: {
      ...project.localization,
      defaultLocale: locale,
      locales: {
        ...project.localization.locales,
        [locale]: { ...project.localization.locales[locale]!, supported: true },
      },
    },
  };
}
