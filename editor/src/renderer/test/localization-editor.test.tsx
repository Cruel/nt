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
  createLocalizationTranslation,
  localizationMessageWorkflowView,
} from '../../shared/authoring-localization-workflow';
import { synchronizeLocalizationMessageTracking } from '../../shared/authoring-localization-sync';
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
  it('exposes the localization work surfaces and manages locale lifecycle through project commands', async () => {
    const user = userEvent.setup();
    loadProject();
    render(<LocalizationEditor tab={tab} />);

    expect(screen.getByRole('button', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Translations' })).toBeInTheDocument();
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
    await user.click(within(row).getByRole('switch', { name: 'Supported' }));
    expect(useProjectStore.getState().document).toMatchObject({
      localization: { locales: { 'fr-CA': { supported: true } } },
    });
    expect(within(row).getByRole('button', { name: 'Remove fr-CA' })).toBeDisabled();
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

  it('preserves AI provenance through review but human edits reset origin without auto-reviewing', async () => {
    const user = userEvent.setup();
    const project = loadProject();
    const messageId = '018f4f8c-9b5d-7ae2-9b36-4c8af613f022';
    project.localization.locales.fr = { supported: false, parentLocale: null };
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
    project.localization.locales.fr = { supported: false, parentLocale: null };
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

  it('attributes structured source edits to the owning record save unit', async () => {
    const user = userEvent.setup();
    const project = loadProject();
    const room = defaultRoomData('Foyer');
    room.description = inlineTextContent('A quiet foyer.');
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.localization.locales.fr = { supported: false, parentLocale: null };
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
    tracked.localization.locales.fr = { supported: false, parentLocale: null };
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

  it('blocks source-locale changes after target translation work exists', async () => {
    const user = userEvent.setup();
    const project = loadProject();
    project.localization.locales.fr = { supported: false, parentLocale: null };
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
