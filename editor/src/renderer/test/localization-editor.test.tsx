import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocalizationEditor } from '@/editors/localization/LocalizationEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

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
      localization: { translations: { es: { [messageId]: 'Jugar' } } },
    });

    const persistedTarget = screen.getByLabelText('Target content for ui.menu.play');
    await user.clear(persistedTarget);
    await user.tab();
    const afterClear = useProjectStore.getState().document as {
      localization: { translations: Record<string, Record<string, string>> };
    };
    expect(afterClear.localization.translations.es?.[messageId]).toBeUndefined();
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
      '018f4f8c-9b5d-7ae2-9b36-4c8af613f001': 'Bonjour',
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
