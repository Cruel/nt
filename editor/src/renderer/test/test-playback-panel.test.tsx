import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { TestPlaybackPanel } from '@/workbench/TestPlaybackPanel';
import { useWorkspaceStore } from '@/stores/workspace-store';

beforeEach(() => {
  useWorkspaceStore.getState().setLastPlaybackReport(null);
});

describe('TestPlaybackPanel', () => {
  it('renders an empty state without a report', () => {
    render(<TestPlaybackPanel />);
    expect(screen.getByText('No playback report yet.')).toBeInTheDocument();
  });

  it('renders pass/fail status, diagnostics, observations, events, and final state', () => {
    useWorkspaceStore.getState().setLastPlaybackReport({
      id: 'smoke',
      passed: false,
      failures: ['Expected mode dialogue'],
      diagnostics: [
        {
          severity: 'warning',
          category: 'Test playback',
          message: 'Conversion missing',
          path: '/tests/smoke',
        },
      ],
      final_state: {
        loaded: true,
        running: false,
        mode: 'room',
        title: 'Opening',
        current_room: 'foyer',
      },
      observations: [
        {
          step_index: 1,
          input: 'continue',
          handled: true,
          passed: false,
          assertion_failures: ['mode mismatch'],
          diagnostics: [
            {
              severity: 'error',
              category: 'assertion',
              message: 'mode mismatch',
              path: '/steps/1',
            },
          ],
        },
      ],
      events: [{ type: 'state', step_index: 1 }],
    });

    render(<TestPlaybackPanel />);

    expect(screen.getAllByText('failed').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('smoke')).toBeInTheDocument();
    expect(screen.getByText('Expected mode dialogue')).toBeInTheDocument();
    expect(screen.getByText('Final state')).toBeInTheDocument();
    expect(screen.getByText('foyer')).toBeInTheDocument();
    expect(screen.getByText('continue')).toBeInTheDocument();
    expect(screen.getAllByText('mode mismatch').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Conversion missing')).toBeInTheDocument();
    expect(screen.getByText('state @1')).toBeInTheDocument();
  });

  it('renders typed step and final expectation results from native playback reports', () => {
    useWorkspaceStore.getState().setLastPlaybackReport({
      schema: 'noveltea.editor.playback-report',
      version: 1,
      id: 'typed-expectations',
      passed: false,
      steps: [
        {
          index: 0,
          handled: true,
          events: [{ type: 'notification', message: 'ready' }],
          diagnostics: [],
          expectations: [
            { id: 'room', passed: true, message: 'Expectation passed.' },
            { id: 'visible', passed: false, message: 'Entity state did not match.' },
          ],
        },
      ],
      finalExpectations: [{ id: 'saved', passed: true, message: 'Expectation passed.' }],
      finalPublication: { revision: 3 },
    });

    render(<TestPlaybackPanel />);

    expect(screen.getByText('typed-expectations')).toBeInTheDocument();
    expect(screen.getByText('room')).toBeInTheDocument();
    expect(screen.getByText('visible')).toBeInTheDocument();
    expect(screen.getByText('Entity state did not match.')).toBeInTheDocument();
    expect(screen.getByText('Final expectations')).toBeInTheDocument();
    expect(screen.getByText('saved')).toBeInTheDocument();
    expect(screen.getByText('Final publication')).toBeInTheDocument();
  });
});
