import { describe, expect, it } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { DiagnosticList, diagnosticDetailsText } from '../diagnostics/DiagnosticList';

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
    expect(screen.getByText('External working file')).toBeInTheDocument();
    expect(screen.getByLabelText('Owner has unsaved edits')).toBeInTheDocument();
    expect(
      screen.getByText('.noveltea/editor/working/files/records/rooms/hall.yaml'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/caused by unsaved edits/i)).not.toBeInTheDocument();
  });

  it('keeps native working and saved provenance in details instead of cluttering compact rows', () => {
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
    expect(screen.queryByText('Saved disk')).not.toBeInTheDocument();
    expect(screen.queryByText('Working state')).not.toBeInTheDocument();
    expect(
      diagnosticDetailsText({
        severity: 'error',
        message: 'Working Room error',
        observedAgainst: 'working',
      }),
    ).toContain('Observed against: working');
  });

  it('keeps record labels readable next to an unsaved marker and hides physical paths by default', () => {
    render(
      <DiagnosticList
        compact
        showPath={false}
        items={[
          {
            severity: 'warning',
            message: 'Room description is empty.',
            path: '/rooms/director/data/description',
            sourcePath: 'records/rooms/director.yaml',
            observedAgainst: 'working',
            dirtyOwner: true,
            target: {
              tab: {
                id: 'tab:room-detail:rooms:director',
                title: 'Director Dialogue Tail',
                editorType: 'room-detail',
                resource: {
                  kind: 'record',
                  stableId: 'record:rooms:director',
                  collection: 'rooms',
                  entityId: 'director',
                },
              },
            },
          },
        ]}
      />,
    );

    expect(screen.getByText('Director Dialogue Tail')).toHaveClass('truncate');
    expect(screen.getByText('Room description is empty.')).toHaveClass('truncate');
    expect(screen.getByLabelText('Owner has unsaved edits')).toBeInTheDocument();
    expect(screen.queryByText('Working state')).not.toBeInTheDocument();
    expect(screen.queryByText('records/rooms/director.yaml')).not.toBeInTheDocument();
    expect(screen.getByText('Director Dialogue Tail').parentElement).toHaveClass('min-w-0');
  });
});
