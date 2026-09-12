import { describe, expect, it } from 'vite-plus/test';
import {
  createLocalizationTranslation,
  localizationMessageWorkflowViews,
} from '../../shared/authoring-localization-workflow';
import { localizationExchangeDocument } from '../../shared/localization-exchange';
import { minimalGoldenProject } from './fixtures/compiled-project-golden-projects';

describe('localization exchange seam', () => {
  it('exports the canonical workflow Message set rather than only explicit Message records', () => {
    const project = minimalGoldenProject();
    project.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
    const views = localizationMessageWorkflowViews(project);
    const structured = views.find((message) => message.sourcePath?.startsWith('/'));
    expect(structured).toBeDefined();
    if (!structured) return;

    project.localization.usageNotes[structured.id] = 'Shown during the opening interaction.';
    project.localization.translations.fr = {
      [structured.id]: createLocalizationTranslation(structured, 'Texte traduit'),
    };

    const document = localizationExchangeDocument(project, 'fr');
    expect(document.messages.map((message) => message.messageId)).toEqual(
      [...localizationMessageWorkflowViews(project)].map((message) => message.id).sort(),
    );
    expect(document.messages.find((message) => message.messageId === structured.id)).toMatchObject({
      source: structured.source,
      target: 'Texte traduit',
      usageNotes: ['Shown during the opening interaction.'],
    });
  });
});
