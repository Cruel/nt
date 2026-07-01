import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProjectSettingsEditor } from '@/editors/project/ProjectSettingsEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';

vi.mock('@/components/source/SourceEditor', () => ({
  SourceEditor: ({ value, onChange, className }: { value: string; onChange?: (value: string) => void; className?: string }) => (
    <textarea aria-label="source-editor" className={className} value={value} onChange={(event) => onChange?.(event.currentTarget.value)} />
  ),
}));

const tab: WorkbenchTab = {
  id: 'tab:project-settings',
  title: 'Project Settings',
  editorType: 'project-settings',
  resource: { kind: 'tool', stableId: 'utility:project-settings' },
};

function project() {
  const next = createAuthoringProject({ name: 'Old Title' });
  next.rooms.foyer = { id: 'foyer', label: 'Foyer', tags: [], data: defaultRoomData('Foyer') };
  next.layouts.main = { id: 'main', label: 'Main Layout', tags: [], data: defaultLayoutData('Main Layout') };
  next.assets['main-font'] = {
    id: 'main-font',
    label: 'Main Font',
    tags: [],
    data: { kind: 'font', source: { type: 'project-file', path: 'assets/fonts/main.ttf' }, aliases: [], extension: '.ttf' },
  };
  next.assets.logo = {
    id: 'logo',
    label: 'Logo',
    tags: [],
    data: { kind: 'image', source: { type: 'project-file', path: 'assets/images/logo.png' }, aliases: [], extension: '.png' },
  };
  return next;
}

beforeEach(() => {
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
});

describe('ProjectSettingsEditor', () => {
  it('renders project settings and updates metadata, entrypoint, and startup script through commands', async () => {
    useProjectStore.getState().loadProjectDocument({ document: project(), projectPath: '/mock', projectFilePath: '/mock/project.json' });
    render(<ProjectSettingsEditor tab={tab} />);

    expect(screen.getByText('Project Settings')).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('Old Title'), { target: { value: 'New Title' } });
    await waitFor(() => expect(useProjectStore.getState().document).toMatchObject({ project: { name: 'New Title' } }));
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('project.updateMetadata');

    fireEvent.change(screen.getByLabelText('Entrypoint room'), { target: { value: 'foyer' } });
    await waitFor(() => expect(useProjectStore.getState().document).toMatchObject({ entrypoint: { collection: 'rooms', id: 'foyer' } }));
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('project.setEntrypoint');

    fireEvent.change(screen.getByLabelText('source-editor'), { target: { value: 'game.start()' } });
    await waitFor(() => expect(useProjectStore.getState().document).toMatchObject({ settings: { startup: { initScript: 'game.start()' } } }));
  });

  it('updates runtime defaults, title screen, and icon settings', async () => {
    useProjectStore.getState().loadProjectDocument({ document: project(), projectPath: '/mock', projectFilePath: '/mock/project.json' });
    render(<ProjectSettingsEditor tab={tab} />);

    fireEvent.change(screen.getByLabelText('Default layout'), { target: { value: 'main' } });
    fireEvent.change(screen.getByLabelText('Default font'), { target: { value: 'main-font' } });
    fireEvent.change(screen.getByLabelText('Title image'), { target: { value: 'logo' } });
    fireEvent.change(screen.getByLabelText('Project icon'), { target: { value: 'logo' } });
    fireEvent.change(screen.getByLabelText('Start label'), { target: { value: 'Begin' } });

    await waitFor(() => expect(useProjectStore.getState().document).toMatchObject({
      settings: {
        ui: { defaultLayout: { $ref: { collection: 'layouts', id: 'main' } } },
        text: { defaultFont: { $ref: { collection: 'assets', id: 'main-font' } } },
        titleScreen: { titleImage: { $ref: { collection: 'assets', id: 'logo' } }, startLabel: 'Begin' },
        app: { icon: { $ref: { collection: 'assets', id: 'logo' } } },
      },
    }));
  });
});
