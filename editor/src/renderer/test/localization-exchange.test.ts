import { describe, expect, it } from 'vite-plus/test';
import {
  createLocalizationTranslation,
  localizationMessageWorkflowViews,
} from '../../shared/authoring-localization-workflow';
import { localizationExchangeDocument } from '../../shared/localization-exchange';
import { namedMessageUsages } from '../../shared/authoring-named-message-usages';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
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

  it('exports occurrence-specific notes for every named Message usage', () => {
    const project = createAuthoringProject();
    const messageId = '11111111-1111-4111-8111-111111111111';
    project.localization.messages[messageId] = {
      kind: 'named',
      key: 'ui.shared',
      source: 'Shared',
    };
    const first = defaultRoomData('First');
    first.description = { markup: 'plain', source: { kind: 'localized', key: 'ui.shared' } };
    const second = defaultRoomData('Second');
    second.description = { markup: 'plain', source: { kind: 'localized', key: 'ui.shared' } };
    project.rooms.first = { id: 'first', label: 'First', data: first };
    project.rooms.second = { id: 'second', label: 'Second', data: second };
    project.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };

    const usages = namedMessageUsages(project, messageId);
    expect(usages).toHaveLength(2);
    project.localization.usageNotes[usages[0]!.id] = 'First occurrence guidance';
    project.localization.usageNotes[usages[1]!.id] = 'Second occurrence guidance';

    const document = localizationExchangeDocument(project, 'fr');
    expect(
      document.messages.find((message) => message.messageId === messageId)?.usageNotes,
    ).toEqual(['First occurrence guidance', 'Second occurrence guidance']);
  });
});
