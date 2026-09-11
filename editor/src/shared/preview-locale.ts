import type { AuthoringProject } from './project-schema/authoring-project';

export function effectivePreviewLocale(project: AuthoringProject): string {
  const requested = project.editor.previewLocale;
  if (requested && project.localization.locales[requested]) return requested;
  return project.localization.defaultLocale;
}

export function projectWithPreviewLocale(project: AuthoringProject): AuthoringProject {
  const locale = effectivePreviewLocale(project);
  if (locale === project.localization.defaultLocale) return project;
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
