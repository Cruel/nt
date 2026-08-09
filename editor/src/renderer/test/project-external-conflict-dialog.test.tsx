import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { ProjectExternalConflictDialog } from '@/project/ProjectExternalConflictDialog';

const revision = `sha256:${'a'.repeat(64)}` as const;

describe('ProjectExternalConflictDialog', () => {
  it('shows the conflicted paths and exposes only explicit resolution actions', () => {
    const onUseDisk = vi.fn();
    const onKeepMine = vi.fn();
    render(
      <ProjectExternalConflictDialog
        saveUnitId="record:rooms:hall"
        conflict={{
          baseValueByPath: { '/rooms/hall/label': { exists: true, value: 'Hall' } },
          localValueByPath: { '/rooms/hall/label': { exists: true, value: 'Local Hall' } },
          externalValueByPath: { '/rooms/hall/label': { exists: true, value: 'Disk Hall' } },
          conflictingPaths: ['/rooms/hall/label'],
          externalWorkspaceRevision: revision,
          externalFileRevisions: { 'records/rooms/hall.json': revision },
        }}
        onUseDisk={onUseDisk}
        onKeepMine={onKeepMine}
      />,
    );

    expect(screen.getByText('/rooms/hall/label')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use Disk' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep Mine' }));
    expect(onUseDisk).toHaveBeenCalledOnce();
    expect(onKeepMine).toHaveBeenCalledOnce();
  });
});
