import { describe, expect, it } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { DiagnosticList } from '../diagnostics/DiagnosticList';

describe('Problems diagnostic source origin (#629)', () => {
  it('shows an external working path without claiming the unsaved owner caused the failure', () => {
    render(
      <DiagnosticList
        compact
        items={[
          {
            severity: 'error',
            path: '/rooms/hall/data/name',
            sourcePath: 'records/rooms/hall.yaml',
            message: 'Unparseable Room',
            observedAgainst: 'working-file',
            dirtyOwner: true,
          },
        ]}
      />,
    );
    expect(screen.getByText('External working file · Owner has unsaved edits')).toBeInTheDocument();
    expect(
      screen.getByText('.noveltea/editor/working/files/records/rooms/hall.yaml'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/caused by unsaved edits/i)).not.toBeInTheDocument();
  });

  it('labels saved-state and native-working-state diagnostics separately', () => {
    render(
      <DiagnosticList
        compact
        items={[
          {
            severity: 'warning',
            path: '/rooms/hall',
            message: 'Saved Room warning',
            observedAgainst: 'disk',
          },
          {
            severity: 'error',
            path: '/rooms/studio',
            message: 'Working Room error',
            observedAgainst: 'working',
          },
        ]}
      />,
    );
    expect(screen.getByText('Saved disk')).toBeInTheDocument();
    expect(screen.getByText('Working state')).toBeInTheDocument();
  });
});
