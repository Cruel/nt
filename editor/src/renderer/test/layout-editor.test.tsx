import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LayoutEditor } from '@/editors/layouts/LayoutEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: () => <div data-testid="resize-separator" />,
}));

vi.mock('@/components/engine-preview', () => ({
  EnginePreview: () => <div data-testid="engine-preview" />,
}));

vi.mock('@/components/source/SourceEditor', () => ({
  SourceEditor: ({ language = 'text', value, onChange }: { language?: string; value: string; onChange?: (value: string) => void }) => (
    <textarea aria-label={`source-${language}`} value={value} onChange={(event) => onChange?.(event.currentTarget.value)} />
  ),
}));

const tab: WorkbenchTab = {
  id: 'tab:layout-detail:layouts:main',
  title: 'Main UI',
  editorType: 'layout-detail',
  resource: {
    kind: 'record',
    stableId: 'record:layouts:main',
    collection: 'layouts',
    entityId: 'main',
  },
};

beforeEach(() => {
  useCommandStore.getState().resetCommandHistory();
  useDraftDirtyStore.getState().resetDraftDirty();
  useProjectStore.getState().clearProject();
});

describe('LayoutEditor', () => {
  it('renders typed layout defaults and preview surface', () => {
    const project = createAuthoringProject();
    project.layouts.main = { id: 'main', label: 'Main UI', tags: [], data: defaultLayoutData('Main UI') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    render(<LayoutEditor tab={tab} />);

    expect(screen.getByText('Main UI')).toBeInTheDocument();
    expect(screen.getByText('RML Source')).toBeInTheDocument();
    expect(screen.getByText('RCSS Source')).toBeInTheDocument();
    expect(screen.getByText('Lua Source')).toBeInTheDocument();
    expect(screen.getByTestId('engine-preview')).toBeInTheDocument();
  });

  it('marks source drafts dirty and applies them through layout.replaceData', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    project.layouts.main = { id: 'main', label: 'Main UI', tags: [], data: defaultLayoutData('Main UI') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    render(<LayoutEditor tab={tab} />);

    const rmlEditor = screen.getByLabelText('source-rml');
    fireEvent.change(rmlEditor, { target: { value: '<div><h1>Changed Layout</h1></div>\n' } });

    await waitFor(() => {
      expect(Object.values(useDraftDirtyStore.getState().entriesByKey)).toEqual(expect.arrayContaining([
        expect.objectContaining({ tabId: tab.id, dirty: true, label: 'Unapplied layout source edits' }),
      ]));
    });

    await user.click(screen.getByText('Apply Sources'));

    await waitFor(() => {
      expect(useProjectStore.getState().document).toMatchObject({
        layouts: {
          main: {
            data: {
              rml: { sourceText: '<div><h1>Changed Layout</h1></div>\n' },
            },
          },
        },
      });
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('layout.replaceData');
  });

  it('sets the current layout as the default layout through commands', async () => {
    const user = userEvent.setup();
    const project = createAuthoringProject();
    project.layouts.main = { id: 'main', label: 'Main UI', tags: [], data: defaultLayoutData('Main UI') };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    render(<LayoutEditor tab={tab} />);

    await user.click(screen.getByText('Set Default'));

    expect(useProjectStore.getState().document).toMatchObject({
      settings: { ui: { defaultLayout: { $ref: { collection: 'layouts', id: 'main' } } } },
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.type).toBe('project.setDefaultLayout');
  });
});
