import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { AppMenuBar } from '@/components/app-menu-bar';
import { toJsonValue } from '@/project/json-value';
import { useProjectStore } from '@/project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';

beforeEach(() => {
  useProjectStore.getState().clearProject();
});

describe('AppMenuBar', () => {
  it('hides project-only toolbar icons when no project is open', async () => {
    await act(async () => {
      render(<AppMenuBar />);
    });

    const icon = screen.getByRole('img', { name: 'NovelTea Editor' });
    const fileMenu = screen.getByRole('menuitem', { name: 'File' });
    expect(screen.getByText('File')).toHaveClass('translate-y-px');
    expect(icon).toHaveClass('dark:hidden');
    expect(document.querySelector('img[aria-hidden="true"]')).toHaveClass('dark:block');
    expect(icon.compareDocumentPosition(fileMenu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTitle('Play debug game')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Undo')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Redo')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Save')).not.toBeInTheDocument();
  });

  it('shows project-only toolbar icons when a project is open', async () => {
    act(() => {
      useProjectStore.getState().loadUnsavedProjectDocument(createAuthoringProject());
    });

    await act(async () => {
      render(<AppMenuBar />);
    });

    expect(screen.getByTitle('Play / Debug Game')).toBeInTheDocument();
    expect(screen.getByTitle('Undo')).toBeInTheDocument();
    expect(screen.getByTitle('Redo')).toBeInTheDocument();
    expect(screen.getByTitle('Save')).toBeInTheDocument();
  });

  it('keeps Save and Save All inactive for autosaving settings but enables them for a dirty Room', async () => {
    const user = userEvent.setup();
    const saved = createAuthoringProject();
    const working = structuredClone(saved);
    act(() => {
      useProjectStore.getState().loadProjectDocument({
        document: toJsonValue(saved),
        savedDocument: toJsonValue(saved),
        projectPath: '/mock/project',
        projectFilePath: '/mock/project/project.yaml',
      });
    });
    render(<AppMenuBar />);
    expect(screen.getByTitle('Save')).toBeDisabled();

    working.project.name = 'New title';
    working.settings.display.barColor = '#aabbcc';
    act(() => {
      useProjectStore.getState().replaceDocumentFromCommand(toJsonValue(working), 0);
    });
    expect(screen.getByTitle('Save')).toBeDisabled();

    const fileMenu = screen.getByRole('menuitem', { name: 'File' });
    fireEvent.pointerDown(fileMenu, { button: 0, pointerType: 'mouse' });
    await user.click(fileMenu);
    expect(await screen.findByRole('menuitem', { name: 'SaveCtrl+S' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('menuitem', { name: 'Save All' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    working.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    act(() => {
      useProjectStore.getState().replaceDocumentFromCommand(toJsonValue(working), 1);
    });
    expect(screen.getByTitle('Save')).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: 'Save All' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('shows Save All in the File menu without replacing the Save As shortcut', async () => {
    const user = userEvent.setup();
    const saved = createAuthoringProject();
    const working = createAuthoringProject();
    working.project.name = 'Dirty project';
    act(() => {
      useProjectStore.getState().loadProjectDocument({
        document: toJsonValue(saved),
        projectPath: '/mock/project',
        projectFilePath: '/mock/project/game.json',
      });
      useProjectStore.getState().replaceDocumentFromCommand(toJsonValue(working), 0);
    });

    render(<AppMenuBar />);
    const fileMenu = screen.getByRole('menuitem', { name: 'File' });
    fireEvent.pointerDown(fileMenu, { button: 0, pointerType: 'mouse' });
    await user.click(fileMenu);

    expect(await screen.findByRole('menuitem', { name: 'Save All' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Save As…Ctrl+Shift+S' })).toBeInTheDocument();
  });
});
