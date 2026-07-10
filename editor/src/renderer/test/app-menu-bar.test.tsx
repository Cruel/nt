import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppMenuBar } from '@/components/app-menu-bar';
import { useProjectStore } from '@/project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

beforeEach(() => {
  useProjectStore.getState().clearProject();
});

describe('AppMenuBar', () => {
  it('hides project-only toolbar icons when no project is open', async () => {
    await act(async () => {
      render(<AppMenuBar />);
    });

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
});
