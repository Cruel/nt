import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocalizationEditor } from '@/editors/localization/LocalizationEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { inlineTextContent } from '../../shared/project-schema/authoring-flow';
import {
  createAuthoringProject,
  type AuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import {
  defaultDialogueBlock,
  defaultDialogueData,
  defaultDialogueSegment,
} from '../../shared/project-schema/authoring-dialogues';
import {
  createLocalizationTranslation,
  localizationMessageWorkflowView,
  localizationMessageWorkflowViews,
} from '../../shared/authoring-localization-workflow';
import { synchronizeLocalizationMessageTracking } from '../../shared/authoring-localization-sync';
import { structuredMessageForPath } from '../../shared/authoring-structured-messages';
import { PSEUDO_PREVIEW_LOCALE } from '../../shared/pseudo-localization';
import { testTranslation } from './fixtures/localization-workflow';

const tab = {
  id: 'tab:localization',
  title: 'Localization',
  editorType: 'localization',
  resource: { kind: 'project' as const, stableId: 'project:localization' },
};

beforeEach(() => {
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
});

function loadProject() {
  const project = createAuthoringProject();
  useProjectStore.getState().loadProjectDocument({
    document: project,
    projectPath: '/mock',
    projectFilePath: '/mock/project.json',
  });
  return project;
}

describe('LocalizationEditor', () => {
  it('selects the virtual pseudo locale through editor-local Preview Locale state only', async () => {
    const user = userEvent.setup();
    loadProject();
    render(<LocalizationEditor tab={tab} />);

    await user.click(screen.getByRole('combobox', { name: 'Preview locale' }));
    await user.click(screen.getByRole('option', { name: /Pseudo-localized/u }));

    const project = useProjectStore.getState().document as AuthoringProject;
    expect(project.editor.previewLocale).toBe(PSEUDO_PREVIEW_LOCALE);
    expect(project.localization.defaultLocale).toBe('en');
    expect(Object.keys(project.localization.locales)).toEqual(['en']);
    expect(project.localization.translations).toEqual({});
  });

  it('exposes the localization work surfaces and manages locale lifecycle through project commands', async () => {
    const user = userEvent.setup();
    loadProject();
    render(<LocalizationEditor tab={tab} />);

    expect(screen.getByRole('button', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Translations' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assets' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Languages' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Messages' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconciliation' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Languages' }));
    await user.type(screen.getByLabelText('New locale'), 'fr-ca');
    await user.click(screen.getByRole('button', { name: 'Add language' }));

    expect(useProjectStore.getState().document).toMatchObject({
      localization: {
        locales: {
          en: { supported: true },
          'fr-CA': { supported: false, parentLocale: null },
        },
      },
    });

    const row = screen.getByTestId('locale-row-fr-CA');
    const displayName = within(row).getByLabelText('Display name override for fr-CA');
    await user.type(displayName, 'Français canadien');
    await user.tab();
    await user.click(within(row).getByRole('switch', { name: 'Supported' }));
    expect(useProjectStore.getState().document).toMatchObject({
      localization: {
        locales: { 'fr-CA': { supported: true, displayName: 'Français canadien' } },
      },
    });
    expect(within(row).getByRole('button', { name: 'Remove fr-CA' })).toBeDisabled();
  });

  it('assigns localized physical Asset variants while preserving the semantic base Asset', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    project.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
    project.assets.logo = {
      id: 'logo',
      label: 'Logo',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/logo.png' },
        aliases: [],
        contentHash: 'sha256:logo',
        imageMetadata: { width: 640, height: 360, hasAlpha: true, orientation: 1 },
      },
    };
    project.assets['logo-fr'] = {
      id: 'logo-fr',
      label: 'Logo French',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/logo-fr.png' },
        aliases: [],
        contentHash: 'sha256:logo-fr',
        imageMetadata: { width: 640, height: 360, hasAlpha: true, orientation: 1 },
      },
    };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    render(<LocalizationEditor tab={tab} />);

    await user.click(screen.getByRole('button', { name: 'Assets' }));
    const realization = screen.getByRole('combobox', { name: 'Localized Asset for Logo' });
    await user.click(realization);
    await user.click(await screen.findByRole('option', { name: /Logo French/ }));

    expect(useProjectStore.getState().document).toMatchObject({
      localization: {
        assets: {
          fr: {
            logo: {
              asset: { $ref: { collection: 'assets', id: 'logo-fr' } },
              origin: 'human',
              review: 'needs-review',
            },
          },
        },
      },
    });
    expect(screen.getByText(/Localized · Human · Needs review/)).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Localized Asset for Logo' }));
    await user.click(await screen.findByRole('option', { name: 'Use source intentionally' }));
    expect(useProjectStore.getState().document).toMatchObject({
      localization: { assets: { fr: { logo: { useSource: true } } } },
    });
  });

  it('creates named Messages, edits metadata, and stores target text sparsely', async () => {
    const user = userEvent.setup();
    loadProject();
    render(<LocalizationEditor tab={tab} />);

    await user.click(screen.getByRole('button', { name: 'Languages' }));
    await user.type(screen.getByLabelText('New locale'), 'es');
    await user.click(screen.getByRole('button', { name: 'Add language' }));

    await user.click(screen.getByRole('button', { name: 'Messages' }));
    await user.click(screen.getByRole('button', { name: 'New named message' }));
    await user.type(screen.getByLabelText('Semantic key'), 'ui.menu.play');
    await user.type(screen.getByLabelText('Source content'), 'Play');
    await user.type(screen.getByLabelText('Context'), 'Main menu button');
    await user.type(screen.getByLabelText('Translator note'), 'Short verb');
    await user.click(screen.getByRole('button', { name: 'Create message' }));

    const document = useProjectStore.getState().document as {
      localization: {
        messages: Record<
          string,
          { key?: string; source: string; context?: string; translatorNote?: string }
        >;
      };
    };
    const [messageId, message] = Object.entries(document.localization.messages)[0]!;
    expect(message).toMatchObject({
      key: 'ui.menu.play',
      source: 'Play',
      context: 'Main menu button',
      translatorNote: 'Short verb',
    });

    await user.click(screen.getByRole('button', { name: 'Translations' }));
    await user.click(screen.getByRole('combobox', { name: 'Target locale' }));
    await user.click(await screen.findByRole('option', { name: /es/ }));
    const source = screen.getByDisplayValue('Play');
    expect(source).toBeEnabled();
    await user.clear(source);
    await user.type(source, 'Play game');
    await user.tab();
    expect(useProjectStore.getState().document).toMatchObject({
      localization: { messages: { [messageId]: { source: 'Play game' } } },
    });

    const target = screen.getByLabelText('Target content for ui.menu.play');
    expect(target).toHaveValue('');
    await user.type(target, 'Jugar');
    await user.tab();

    expect(useProjectStore.getState().document).toMatchObject({
      localization: {
        translations: {
          es: {
            [messageId]: {
              text: 'Jugar',
              origin: 'human',
              review: 'needs-review',
            },
          },
        },
      },
    });

    const persistedTarget = screen.getByLabelText('Target content for ui.menu.play');
    await user.clear(persistedTarget);
    await user.tab();
    const afterClear = useProjectStore.getState().document as {
      localization: { translations: Record<string, Record<string, unknown>> };
    };
    expect(afterClear.localization.translations.es?.[messageId]).toBeUndefined();
  });

  it('shows inherited targets read-only and supports whole-Message override and intentional source reuse', async () => {
    const user = userEvent.setup();
    const project = loadProject();
    const messageId = '018f4f8c-9b5d-7ae2-9b36-4c8af613f021';
    project.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
    project.localization.locales['fr-CA'] = {
      supported: true,
      parentLocale: 'fr',
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
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<LocalizationEditor tab={tab} />);
    await user.click(screen.getByRole('button', { name: 'Translations' }));
    await user.click(screen.getByRole('combobox', { name: 'Target locale' }));
    await user.click(await screen.findByRole('option', { name: /fr-CA/ }));

    const inherited = screen.getByLabelText('Target content for ui.confirm');
    expect(inherited).toHaveValue('Confirmer');
    expect(inherited).toBeDisabled();
    expect(screen.getByText(/inherited from fr/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Override inherited target' }));
    const overridden = screen.getByLabelText('Target content for ui.confirm');
    expect(overridden).toBeEnabled();
    expect(overridden).toHaveValue('Confirmer');
    expect(useProjectStore.getState().document).toMatchObject({
      localization: {
        translations: {
          'fr-CA': { [messageId]: { text: 'Confirmer', origin: 'human' } },
        },
      },
    });

    const messageSection = overridden.closest('section');
    expect(messageSection).not.toBeNull();
    await user.click(
      within(messageSection!).getByRole('button', { name: 'Use source intentionally' }),
    );
    const sourceTarget = screen.getByLabelText('Target content for ui.confirm');
    expect(sourceTarget).toHaveValue('Confirm');
    expect(sourceTarget).toBeDisabled();
    expect(
      within(messageSection!).getByText(/Current · Use source intentionally/i),
    ).toBeInTheDocument();
    expect(useProjectStore.getState().document).toMatchObject({
      localization: {
        translations: {
          'fr-CA': { [messageId]: { useSource: true } },
        },
      },
    });
  });

  it('preserves AI provenance through review but human edits reset origin without auto-reviewing', async () => {
    const user = userEvent.setup();
    const project = loadProject();
    const messageId = '018f4f8c-9b5d-7ae2-9b36-4c8af613f022';
    project.localization.locales.fr = { supported: false, parentLocale: null, fontStack: null };
    project.localization.messages[messageId] = {
      kind: 'named',
      key: 'ui.ai-copy',
      source: 'Continue',
    };
    const view = localizationMessageWorkflowView(project, messageId)!;
    project.localization.translations.fr = {
      [messageId]: createLocalizationTranslation(view, 'Continuer', 'ai', {
        provider: 'provider',
        model: 'model',
        review: 'reviewed',
      }),
    };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<LocalizationEditor tab={tab} />);
    await user.click(screen.getByRole('button', { name: 'Translations' }));
    const target = screen.getByLabelText('Target content for ui.ai-copy');
    expect(screen.getByText(/Current · ai · reviewed/i)).toBeInTheDocument();
    await user.clear(target);
    await user.type(target, 'Poursuivre');
    await user.tab();

    expect(useProjectStore.getState().document).toMatchObject({
      localization: {
        translations: {
          fr: {
            [messageId]: {
              text: 'Poursuivre',
              origin: 'human',
              review: 'needs-review',
            },
          },
        },
      },
    });
  });

  it('suggests identical local source and promotes selected usages to one named Message', async () => {
    const user = userEvent.setup();
    const project = loadProject();
    const first = defaultRoomData('First');
    first.description = inlineTextContent('Same words');
    const second = defaultRoomData('Second');
    second.description = inlineTextContent('Same words');
    project.rooms.first = { id: 'first', label: 'First', data: first };
    project.rooms.second = { id: 'second', label: 'Second', data: second };
    project.localization.locales.fr = { supported: false, parentLocale: null, fontStack: null };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<LocalizationEditor tab={tab} />);
    await user.click(screen.getByRole('button', { name: 'Translations' }));
    expect(screen.getAllByText(/Matching local Messages: 1/i).length).toBeGreaterThan(0);

    await user.click(screen.getAllByRole('button', { name: 'Promote to named Message' })[0]!);
    await user.type(screen.getByLabelText('Promotion key for Same words'), 'ui.shared.same');
    const candidate = screen.getAllByRole('checkbox')[0]!;
    await user.click(candidate);
    await user.click(screen.getByRole('button', { name: 'Promote and link' }));

    const updated = useProjectStore.getState().document as AuthoringProject;
    expect(updated.rooms.first!.data.description.source).toEqual({
      kind: 'localized',
      key: 'ui.shared.same',
    });
    expect(updated.rooms.second!.data.description.source).toEqual({
      kind: 'localized',
      key: 'ui.shared.same',
    });
    expect(Object.values(updated.localization.messages)).toContainEqual({
      kind: 'named',
      key: 'ui.shared.same',
      source: 'Same words',
    });
  });

  it('merges a named Message into another named Message from the Messages surface', async () => {
    const user = userEvent.setup();
    const project = loadProject();
    const sourceId = '11111111-1111-4111-8111-111111111111';
    const targetId = '22222222-2222-4222-8222-222222222222';
    project.localization.messages[sourceId] = {
      kind: 'named',
      key: 'ui.old.confirm',
      source: 'Confirm',
    };
    project.localization.messages[targetId] = {
      kind: 'named',
      key: 'ui.confirm',
      source: 'Confirm',
    };
    const room = defaultRoomData('Room');
    room.description = {
      markup: 'active-text',
      source: { kind: 'localized', key: 'ui.old.confirm' },
    };
    project.rooms.room = { id: 'room', label: 'Room', data: room };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<LocalizationEditor tab={tab} />);
    await user.click(screen.getByRole('button', { name: 'Messages' }));
    const sourceSection = screen.getByDisplayValue('ui.old.confirm').closest('section')!;
    await user.click(
      within(sourceSection).getByRole('button', { name: 'Merge into named Message' }),
    );
    await user.click(
      within(sourceSection).getByRole('combobox', { name: 'Merge target for ui.old.confirm' }),
    );
    await user.click(await screen.findByRole('option', { name: 'ui.confirm' }));
    await user.click(within(sourceSection).getByRole('button', { name: 'Merge Message' }));

    const updated = useProjectStore.getState().document as AuthoringProject;
    expect(updated.localization.messages[sourceId]).toBeUndefined();
    expect(updated.localization.messages[targetId]).toBeDefined();
    expect(updated.rooms.room!.data.description.source).toEqual({
      kind: 'localized',
      key: 'ui.confirm',
    });
  });

  it('shows explicit draft reuse when making one named usage local', async () => {
    const user = userEvent.setup();
    const project = loadProject();
    const messageId = '11111111-1111-4111-8111-111111111111';
    project.localization.messages[messageId] = {
      kind: 'named',
      key: 'ui.shared.hello',
      source: 'Hello',
    };
    const first = defaultRoomData('First');
    first.description = {
      markup: 'active-text',
      source: { kind: 'localized', key: 'ui.shared.hello' },
    };
    const second = defaultRoomData('Second');
    second.description = {
      markup: 'active-text',
      source: { kind: 'localized', key: 'ui.shared.hello' },
    };
    project.rooms.first = { id: 'first', label: 'First', data: first };
    project.rooms.second = { id: 'second', label: 'Second', data: second };
    project.localization.locales.fr = { supported: false, parentLocale: null, fontStack: null };
    const view = localizationMessageWorkflowView(project, messageId)!;
    project.localization.translations.fr = {
      [messageId]: createLocalizationTranslation(view, 'Bonjour', 'human', { review: 'reviewed' }),
    };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<LocalizationEditor tab={tab} />);
    await user.click(screen.getByRole('button', { name: 'Messages' }));
    await user.click(screen.getByRole('button', { name: 'Make usage local' }));

    expect(screen.getByText(/new independent Message identity/i)).toBeInTheDocument();
    expect(screen.getByText(/Bonjour/)).toBeInTheDocument();
    const copyDraft = screen.getByRole('checkbox', { name: 'Copy fr draft for ui.shared.hello' });
    expect(copyDraft).not.toBeChecked();
    await user.click(copyDraft);
    await user.click(screen.getByRole('button', { name: 'Make local' }));

    const updated = useProjectStore.getState().document as AuthoringProject;
    const localIds = Object.values(updated.localization.structuredMessageIds).filter(
      (id) => id !== messageId,
    );
    expect(localIds).toHaveLength(1);
    expect(updated.localization.translations.fr?.[localIds[0]!]).toMatchObject({
      text: 'Bonjour',
      review: 'needs-review',
    });
    expect(updated.localization.translations.fr?.[messageId]).toMatchObject({ review: 'reviewed' });
  });

  it('requires an explicit locale choice before merging conflicting translations', async () => {
    const user = userEvent.setup();
    const project = loadProject();
    const namedId = '11111111-1111-4111-8111-111111111111';
    project.localization.messages[namedId] = {
      kind: 'named',
      key: 'ui.confirm',
      source: 'Confirm',
    };
    const room = defaultRoomData('Room');
    room.description = inlineTextContent('Continue');
    project.rooms.room = { id: 'room', label: 'Room', data: room };
    project.localization.locales.fr = { supported: false, parentLocale: null, fontStack: null };
    const localView = localizationMessageWorkflowViews(project).find(
      (view) => view.source === 'Continue',
    )!;
    const namedView = localizationMessageWorkflowView(project, namedId)!;
    project.localization.translations.fr = {
      [namedId]: createLocalizationTranslation(namedView, 'Confirmer', 'human', {
        review: 'reviewed',
      }),
      [localView.id]: createLocalizationTranslation(localView, 'Continuer', 'human', {
        review: 'reviewed',
      }),
    };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<LocalizationEditor tab={tab} />);
    await user.click(screen.getByRole('button', { name: 'Translations' }));
    const continueSection = screen.getByDisplayValue('Continue').closest('section')!;
    await user.click(
      within(continueSection).getByRole('button', { name: 'Merge into named Message' }),
    );
    await user.click(
      within(continueSection).getByRole('combobox', { name: 'Merge target for Continue' }),
    );
    await user.click(await screen.findByRole('option', { name: 'ui.confirm' }));

    expect(screen.getByText('Named: Confirmer · Local: Continuer')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Merge Message' }));
    expect(screen.getByText(/choose which translation to keep/i)).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Resolve fr merge conflict' }));
    await user.click(await screen.findByRole('option', { name: 'Use local translation' }));
    await user.click(screen.getByRole('button', { name: 'Merge Message' }));

    const updated = useProjectStore.getState().document as AuthoringProject;
    expect(updated.rooms.room!.data.description.source).toEqual({
      kind: 'localized',
      key: 'ui.confirm',
    });
    expect(updated.localization.translations.fr?.[namedId]).toMatchObject({
      text: 'Continuer',
      review: 'needs-review',
    });
    expect(updated.localization.translations.fr?.[localView.id]).toBeUndefined();
  });

  it('attributes structured source edits to the owning record save unit', async () => {
    const user = userEvent.setup();
    const project = loadProject();
    const room = defaultRoomData('Foyer');
    room.description = inlineTextContent('A quiet foyer.');
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.localization.locales.fr = { supported: false, parentLocale: null, fontStack: null };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<LocalizationEditor tab={tab} />);
    await user.click(screen.getByRole('button', { name: 'Translations' }));
    const source = screen.getByDisplayValue('A quiet foyer.');
    await user.clear(source);
    await user.type(source, 'A renovated foyer.');
    await user.tab();

    expect(useCommandStore.getState().history.entries.at(-1)).toMatchObject({
      originSaveUnitId: 'record:rooms:foyer',
      persistencePolicy: 'manual-save',
    });
    expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { data: { description: { source: { text: 'A renovated foyer.' } } } } },
    });
  });

  it('resolves ambiguous external duplication without sharing Message identity', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: 'return Text.tr("Original", nil, { note = "Keep this" })\n',
    };
    const tracked = synchronizeLocalizationMessageTracking(project).project;
    const messageId = Object.values(tracked.localization.sourceMessageTracking)[0]!.occurrences[0]!
      .messageId;
    tracked.localization.locales.fr = { supported: false, parentLocale: null, fontStack: null };
    const workflow = localizationMessageWorkflowView(tracked, messageId)!;
    tracked.localization.translations.fr = {
      [messageId]: createLocalizationTranslation(workflow, 'Original traduit', 'human', {
        review: 'reviewed',
      }),
    };
    tracked.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: [
        'local first = Text.tr("Original", nil, { note = "Keep this" })',
        'local second = Text.tr("Original", nil, { note = "Keep this" })',
        'return first .. second',
        '',
      ].join('\n'),
    };
    useProjectStore.getState().loadProjectDocument({
      document: tracked,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<LocalizationEditor tab={tab} />);
    await user.click(screen.getByRole('button', { name: 'Reconciliation' }));
    expect(screen.getByText('Decision required')).toBeInTheDocument();

    await user.click(
      screen.getByRole('combobox', {
        name: /Resolution for .*bootstrap.* occurrence 0/,
      }),
    );
    await user.click(
      await screen.findByRole('option', { name: /Relink .*Original.*preserves work/ }),
    );
    await user.click(
      screen.getByRole('combobox', {
        name: /Resolution for .*bootstrap.* occurrence 1/,
      }),
    );
    await user.click(await screen.findByRole('option', { name: 'Create a new Message identity' }));
    await user.click(screen.getByRole('button', { name: 'Apply reconciliation' }));

    const document = useProjectStore.getState().document as AuthoringProject;
    const ids = Object.values(document.localization.sourceMessageTracking).flatMap((entry) =>
      entry.occurrences.map((occurrence) => occurrence.messageId),
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(messageId);
    expect(document.localization.translations.fr?.[messageId]?.text).toBe('Original traduit');
    expect(document.localization.orphanedMessages).toEqual({});
  });

  it('keeps invalid localized Dialogue Cue placements editable but blocks review', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    project.localization.locales.es = { supported: true, parentLocale: null, fontStack: null };
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
    const message = structuredMessageForPath(
      project,
      '/dialogues/intro/data/blocks/@start/segments/@line/text',
    )!;
    const workflow = localizationMessageWorkflowView(project, message.id)!;
    project.localization.translations.es = {
      [message.id]: {
        ...createLocalizationTranslation(workflow, 'Traducido'),
        dialogueCues: [{ id: 'camera', position: { offset: 99, order: 0 } }],
      },
    };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<LocalizationEditor tab={tab} />);
    await user.click(screen.getByRole('button', { name: 'Translations' }));
    expect(screen.getByLabelText('Cue camera offset')).toHaveValue(99);
    expect(screen.getByText(/Cue placements must preserve every Cue/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark reviewed' })).toBeDisabled();

    const offset = screen.getByLabelText('Cue camera offset');
    await user.clear(offset);
    await user.type(offset, '2');
    await user.tab();
    expect(screen.getByRole('button', { name: 'Mark reviewed' })).toBeEnabled();
  });

  it('filters translation work queues and bulk-reviews only current valid filtered targets', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    project.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
    const aiId = '018f4f8c-9b5d-7ae2-9b36-4c8af613f070';
    const missingId = '018f4f8c-9b5d-7ae2-9b36-4c8af613f071';
    project.localization.messages[aiId] = { kind: 'named', key: 'ui.ai', source: 'AI source' };
    project.localization.messages[missingId] = {
      kind: 'named',
      key: 'ui.missing',
      source: 'Missing source',
    };
    const aiView = localizationMessageWorkflowView(project, aiId)!;
    project.localization.translations.fr = {
      [aiId]: createLocalizationTranslation(aiView, 'Texte IA', 'ai'),
    };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<LocalizationEditor tab={tab} />);
    await user.click(screen.getByRole('button', { name: 'Translations' }));
    await user.click(screen.getByRole('combobox', { name: 'Translation status filter' }));
    await user.click(await screen.findByRole('option', { name: 'AI' }));

    expect(screen.getByDisplayValue('Texte IA')).toBeInTheDocument();
    expect(screen.queryByText('Missing source')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark filtered current as reviewed' }));

    const current = useProjectStore.getState().document as AuthoringProject;
    expect(current.localization.translations.fr?.[aiId]?.review).toBe('reviewed');
    expect(current.localization.translations.fr?.[missingId]).toBeUndefined();
  });

  it('does not let editor review bypass structural translation validation', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    project.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
    const messageId = '018f4f8c-9b5d-7ae2-9b36-4c8af613f072';
    project.localization.messages[messageId] = {
      kind: 'named',
      key: 'ui.parameterized',
      source: 'Hello {name}',
      arguments: { name: 'string' },
    };
    const view = localizationMessageWorkflowView(project, messageId)!;
    project.localization.translations.fr = {
      [messageId]: createLocalizationTranslation(view, 'Bonjour {missing}'),
    };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<LocalizationEditor tab={tab} />);
    await user.click(screen.getByRole('button', { name: 'Translations' }));
    expect(screen.getByRole('button', { name: 'Mark reviewed' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Mark filtered current as reviewed' }));

    const current = useProjectStore.getState().document as AuthoringProject;
    expect(current.localization.translations.fr?.[messageId]?.review).toBe('needs-review');
  });

  it('blocks source-locale changes after target translation work exists', async () => {
    const user = userEvent.setup();
    const project = loadProject();
    project.localization.locales.fr = { supported: false, parentLocale: null, fontStack: null };
    project.localization.messages['018f4f8c-9b5d-7ae2-9b36-4c8af613f001'] = {
      kind: 'named',
      key: 'ui.greeting',
      source: 'Hello',
    };
    project.localization.translations.fr = {
      '018f4f8c-9b5d-7ae2-9b36-4c8af613f001': testTranslation('Bonjour'),
    };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });

    render(<LocalizationEditor tab={tab} />);
    await user.click(screen.getByRole('button', { name: 'Languages' }));

    expect(screen.getByRole('combobox', { name: 'Source locale' })).toBeDisabled();
    expect(screen.getByText(/Source locale migration is outside v1/i)).toBeInTheDocument();
  });
});

describe('LocalizationEditor content preservation', () => {
  function loadMessage(pattern = false) {
    const project = createAuthoringProject();
    const messageId = '018f4f8c-9b5d-7ae2-9b36-4c8af613f022';
    project.localization.locales.fr = { supported: false, parentLocale: null, fontStack: null };
    project.localization.messages[messageId] = {
      kind: 'named',
      key: 'ui.copy',
      source: 'First line\nSecond line',
      ...(pattern
        ? {
            arguments: { count: 'plural-number' as const },
            pattern: {
              kind: 'plural' as const,
              argument: 'count',
              cases: {
                one: { kind: 'text' as const, text: 'One' },
                other: { kind: 'text' as const, text: 'Many' },
              },
            },
          }
        : {}),
    };
    const view = localizationMessageWorkflowView(project, messageId)!;
    project.localization.translations.fr = {
      [messageId]: {
        ...createLocalizationTranslation(view, 'Première ligne\nDeuxième ligne'),
        ...(pattern
          ? { pattern: structuredClone(project.localization.messages[messageId]!.pattern) }
          : {}),
      },
    };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock',
      projectFilePath: '/mock/project.json',
    });
    render(<LocalizationEditor tab={tab} />);
    return { project, messageId };
  }

  it('preserves multiline source and target content on untouched blur', async () => {
    const user = userEvent.setup();
    const { project, messageId } = loadMessage();
    await user.click(screen.getByRole('button', { name: 'Translations' }));
    await user.click(
      screen.getAllByLabelText('en source').find((field) => field.id === `source-${messageId}`)!,
    );
    await user.tab();
    await user.click(screen.getByLabelText('Target content for ui.copy'));
    await user.tab();
    await user.click(screen.getByRole('button', { name: 'Messages' }));
    await user.click(screen.getByLabelText('Source content'));
    await user.tab();
    const updated = useProjectStore.getState().document as AuthoringProject;
    expect(updated.localization.messages[messageId]?.source).toBe(
      project.localization.messages[messageId]?.source,
    );
    expect(updated.localization.translations.fr?.[messageId]?.text).toBe(
      project.localization.translations.fr?.[messageId]?.text,
    );
  });

  it('preserves selector branches when target text changes', async () => {
    const user = userEvent.setup();
    const { project, messageId } = loadMessage(true);
    await user.click(screen.getByRole('button', { name: 'Translations' }));
    const target = screen.getByLabelText('Target content for ui.copy');
    await user.clear(target);
    await user.type(target, 'Poursuivre');
    await user.tab();
    const updated = useProjectStore.getState().document as AuthoringProject;
    expect(updated.localization.translations.fr?.[messageId]?.text).toBe('Poursuivre');
    expect(updated.localization.translations.fr?.[messageId]?.pattern).toEqual(
      project.localization.translations.fr?.[messageId]?.pattern,
    );
  });
});
