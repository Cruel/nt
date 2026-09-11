import { describe, expect, it } from 'vite-plus/test';
import {
  createLocalizationTranslation,
  localizationMessageWorkflowView,
  localizationTargetWorkflowView,
} from '../../shared/authoring-localization-workflow';
import { synchronizeLocalizationMessageTracking } from '../../shared/authoring-localization-sync';
import { structuredMessageForPath } from '../../shared/authoring-structured-messages';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { inlineTextContent } from '../../shared/project-schema/authoring-flow';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';

describe('localization workflow state', () => {
  it('derives linguistic freshness separately from guidance attention', () => {
    const project = createAuthoringProject();
    const messageId = '018f4f8c-9b5d-7ae2-9b36-4c8af613f031';
    project.localization.locales.fr = { supported: false, parentLocale: null };
    project.localization.messages[messageId] = {
      kind: 'named',
      key: 'ui.continue',
      source: 'Continue',
      context: 'Button label',
    };
    const original = localizationMessageWorkflowView(project, messageId)!;
    project.localization.translations.fr = {
      [messageId]: createLocalizationTranslation(original, 'Continuer', 'ai', {
        provider: 'provider',
        model: 'model',
        review: 'reviewed',
      }),
    };

    project.localization.messages[messageId]!.context = 'Pause menu button label';
    const guidanceChanged = localizationTargetWorkflowView(
      project,
      'fr',
      localizationMessageWorkflowView(project, messageId)!,
    );
    expect(guidanceChanged.freshness).toBe('current');
    expect(guidanceChanged.attention).toEqual(['guidance']);
    expect(guidanceChanged.translation).toMatchObject({ origin: 'ai', review: 'reviewed' });

    project.localization.messages[messageId]!.source = 'Keep going';
    const sourceChanged = localizationTargetWorkflowView(
      project,
      'fr',
      localizationMessageWorkflowView(project, messageId)!,
    );
    expect(sourceChanged.freshness).toBe('outdated');
    expect(sourceChanged.translation?.text).toBe('Continuer');
  });

  it('derives structured presentation attention without linguistic staleness', () => {
    const project = createAuthoringProject();
    project.localization.locales.fr = { supported: false, parentLocale: null };
    const room = defaultRoomData('Foyer');
    room.description = inlineTextContent('Welcome', 'plain');
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    const messageId = structuredMessageForPath(project, '/rooms/foyer/data/description')!.id;
    const original = localizationMessageWorkflowView(project, messageId)!;
    project.localization.translations.fr = {
      [original.id]: createLocalizationTranslation(original, 'Bienvenue'),
    };

    const changed = structuredClone(project);
    changed.rooms.foyer!.data.description.markup = 'active-text';
    const updated = localizationMessageWorkflowView(changed, original.id)!;
    const target = localizationTargetWorkflowView(changed, 'fr', updated);
    expect(target.freshness).toBe('current');
    expect(target.attention).toEqual(['presentation']);
  });

  it('derives presentation-only RML attention without marking the target linguistically outdated', () => {
    const project = createAuthoringProject();
    project.localization.locales.fr = { supported: false, parentLocale: null };
    const layout = defaultLayoutData('HUD', 'document');
    layout.rml.sourceText = '<rml><body><nt-tr>Hello <em>traveler</em>.</nt-tr></body></rml>';
    project.layouts.hud = { id: 'hud', label: 'HUD', data: layout };
    const firstSync = synchronizeLocalizationMessageTracking(project).project;
    const trackingEntry = Object.values(firstSync.localization.sourceMessageTracking)[0]!;
    const messageId = trackingEntry.occurrences[0]!.messageId;
    const original = localizationMessageWorkflowView(firstSync, messageId)!;
    expect(original.sourceEditPath).toBeNull();
    firstSync.localization.translations.fr = {
      [messageId]: createLocalizationTranslation(original, 'Bonjour voyageur.'),
    };

    firstSync.layouts.hud!.data.rml.sourceText =
      '<rml><body><nt-tr>Hello <strong>traveler</strong>.</nt-tr></body></rml>';
    const secondSync = synchronizeLocalizationMessageTracking(firstSync).project;
    const updated = localizationMessageWorkflowView(secondSync, messageId);
    expect(updated).not.toBeNull();
    const target = localizationTargetWorkflowView(secondSync, 'fr', updated!);
    expect(target.freshness).toBe('current');
    expect(target.attention).toEqual(['presentation']);
  });
});
