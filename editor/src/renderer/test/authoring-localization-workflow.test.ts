import { describe, expect, it } from 'vite-plus/test';
import {
  createLocalizationTranslation,
  createUseSourceLocalizationTarget,
  effectiveLocalizationTarget,
  localizationMessageWorkflowView,
  localizationTargetWorkflowView,
} from '../../shared/authoring-localization-workflow';
import { synchronizeLocalizationMessageTracking } from '../../shared/authoring-localization-sync';
import { structuredMessageForPath } from '../../shared/authoring-structured-messages';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { inlineTextContent } from '../../shared/project-schema/authoring-flow';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import {
  defaultDialogueBlock,
  defaultDialogueData,
  defaultDialogueSegment,
} from '../../shared/project-schema/authoring-dialogues';

describe('localization workflow state', () => {
  it('derives linguistic freshness separately from guidance attention', () => {
    const project = createAuthoringProject();
    const messageId = '018f4f8c-9b5d-7ae2-9b36-4c8af613f031';
    project.localization.locales.fr = { supported: false, parentLocale: null, fontStack: null };
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
    project.localization.locales.fr = { supported: false, parentLocale: null, fontStack: null };
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

  it('treats source Dialogue Cue movement as presentation attention while preserving target placement', () => {
    const project = createAuthoringProject();
    project.localization.locales.fr = { supported: false, parentLocale: null, fontStack: null };
    const dialogue = defaultDialogueData('Localized cues');
    const line = defaultDialogueSegment('line', 'line');
    line.text = { source: { kind: 'inline', text: 'ABCDE' }, markup: 'active-text' };
    line.cues = [
      {
        id: 'camera',
        kind: 'camera',
        position: { offset: 4, order: 0 },
        emphasis: {
          kind: 'flash',
          color: '#ffffff',
          opacity: 1,
          durationMs: 100,
          skippable: true,
          waitForCompletion: false,
        },
      },
    ];
    dialogue.blocks = [{ ...defaultDialogueBlock('sequence', 'start'), segments: [line] }];
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: dialogue };
    const messageId = structuredMessageForPath(
      project,
      '/dialogues/intro/data/blocks/@start/segments/@line/text',
    )!.id;
    const original = localizationMessageWorkflowView(project, messageId)!;
    project.localization.translations.fr = {
      [messageId]: {
        ...createLocalizationTranslation(original, 'ABCDEFGHIJ'),
        dialogueCues: [{ id: 'camera', position: { offset: 2, order: 0 } }],
      },
    };

    const changed = structuredClone(project);
    const changedLine = changed.dialogues.intro!.data.blocks[0]!;
    if (changedLine.type !== 'sequence' || changedLine.segments[0]?.type !== 'line') return;
    changedLine.segments[0].cues[0]!.position.offset = 3;
    const updated = localizationMessageWorkflowView(changed, messageId)!;
    const target = localizationTargetWorkflowView(changed, 'fr', updated);
    expect(target.freshness).toBe('current');
    expect(target.attention).toEqual(['presentation']);
    expect(target.translation?.dialogueCues).toEqual([
      { id: 'camera', position: { offset: 2, order: 0 } },
    ]);
  });

  it('projects Dialogue Cue contracts onto named Messages and rejects incompatible reuse', () => {
    const project = createAuthoringProject();
    const messageId = '018f4f8c-9b5d-7ae2-9b36-4c8af613f039';
    project.localization.messages[messageId] = {
      kind: 'named',
      key: 'dialogue.shared.line',
      source: 'ABCDE',
    };
    const dialogue = defaultDialogueData('Named cues');
    const first = defaultDialogueSegment('line', 'first');
    first.text = {
      source: { kind: 'localized', key: 'dialogue.shared.line' },
      markup: 'active-text',
    };
    first.cues = [
      {
        id: 'camera',
        kind: 'camera',
        position: { offset: 2, order: 0 },
        emphasis: {
          kind: 'flash',
          color: '#ffffff',
          opacity: 1,
          durationMs: 100,
          skippable: true,
          waitForCompletion: false,
        },
      },
    ];
    const second = structuredClone(first);
    second.id = 'second';
    second.cues[0]!.position.offset = 3;
    dialogue.blocks = [{ ...defaultDialogueBlock('sequence', 'start'), segments: [first, second] }];
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: dialogue };

    const view = localizationMessageWorkflowView(project, messageId)!;
    expect(view.dialogueCues).toEqual([{ id: 'camera', position: { offset: 2, order: 0 } }]);
    expect(createLocalizationTranslation(view, 'Traduit').dialogueCues).toEqual([
      { id: 'camera', position: { offset: 2, order: 0 } },
    ]);
    expect(validateAuthoringProject(project)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'localization.dialogue-message.cue-contract-conflict' }),
      ]),
    );
  });

  it('inherits sparse whole-Message targets across locale chains and preserves explicit use-source intent', () => {
    const project = createAuthoringProject();
    const messageId = '018f4f8c-9b5d-7ae2-9b36-4c8af613f032';
    project.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
    project.localization.locales['fr-CA'] = {
      supported: true,
      parentLocale: 'fr',
      fontStack: null,
    };
    project.localization.locales['fr-CA-QC'] = {
      supported: false,
      parentLocale: 'fr-CA',
      fontStack: null,
    };
    project.localization.locales['fr-BE'] = {
      supported: true,
      parentLocale: null,
      fontStack: null,
    };
    project.localization.messages[messageId] = {
      kind: 'named',
      key: 'ui.confirm',
      source: 'Confirm',
    };
    const view = localizationMessageWorkflowView(project, messageId)!;
    project.localization.translations.fr = {
      [messageId]: createLocalizationTranslation(view, 'Confirmer', 'human', {
        review: 'reviewed',
      }),
    };

    expect(effectiveLocalizationTarget(project, 'fr-CA-QC', messageId)).toMatchObject({
      locale: 'fr',
      inherited: true,
      target: { text: 'Confirmer', review: 'reviewed' },
    });
    expect(localizationTargetWorkflowView(project, 'fr-CA-QC', view)).toMatchObject({
      freshness: 'current',
      translation: { text: 'Confirmer', review: 'reviewed' },
    });
    expect(project.localization.translations['fr-CA']).toBeUndefined();
    expect(project.localization.translations['fr-CA-QC']).toBeUndefined();
    expect(localizationTargetWorkflowView(project, 'fr-BE', view).freshness).toBe('missing');

    project.localization.translations['fr-CA'] = {
      [messageId]: createUseSourceLocalizationTarget(view),
    };
    const inheritedSource = effectiveLocalizationTarget(project, 'fr-CA-QC', messageId);
    expect(inheritedSource).toMatchObject({
      locale: 'fr-CA',
      inherited: true,
      target: { useSource: true },
    });
    expect(localizationTargetWorkflowView(project, 'fr-CA-QC', view).freshness).toBe('current');
  });

  it('derives presentation-only RML attention without marking the target linguistically outdated', () => {
    const project = createAuthoringProject();
    project.localization.locales.fr = { supported: false, parentLocale: null, fontStack: null };
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
