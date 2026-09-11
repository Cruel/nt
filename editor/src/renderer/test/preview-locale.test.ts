import { describe, expect, it } from 'vite-plus/test';
import { effectivePreviewLocale, projectWithPreviewLocale } from '../../shared/preview-locale';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

describe('Preview Locale', () => {
  it('overrides runtime preview default without mutating the authored Project Default', () => {
    const project = createAuthoringProject();
    project.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
    project.editor.previewLocale = 'fr';

    const preview = projectWithPreviewLocale(project);

    expect(effectivePreviewLocale(project)).toBe('fr');
    expect(preview.localization.defaultLocale).toBe('fr');
    expect(project.localization.defaultLocale).toBe('en');
    expect(preview.localization.sourceLocale).toBe(project.localization.sourceLocale);
  });

  it('allows a declared work-in-progress locale for preview without changing Project support', () => {
    const project = createAuthoringProject();
    project.localization.locales.fr = { supported: false, parentLocale: null, fontStack: null };
    project.editor.previewLocale = 'fr';

    const preview = projectWithPreviewLocale(project);
    expect(effectivePreviewLocale(project)).toBe('fr');
    expect(preview.localization.defaultLocale).toBe('fr');
    expect(preview.localization.locales.fr?.supported).toBe(true);
    expect(project.localization.locales.fr?.supported).toBe(false);
  });

  it('falls back to the Project Default when the editor selection is no longer declared', () => {
    const project = createAuthoringProject();
    project.editor.previewLocale = 'fr';

    expect(effectivePreviewLocale(project)).toBe('en');
    expect(projectWithPreviewLocale(project)).toBe(project);
  });
});
