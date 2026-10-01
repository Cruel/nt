import { createRef } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  FocusTransitionOverlay,
  type FocusTransitionOverlayHandle,
} from '@/components/focus-transition/FocusTransitionOverlay';

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

function useReducedMotionForTest() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)',
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe('FocusTransitionOverlay', () => {
  it('samples the latest destination image presentation when exit begins', async () => {
    useReducedMotionForTest();
    const ref = createRef<FocusTransitionOverlayHandle>();
    const source = {
      rect: { x: 100, y: 80, width: 400, height: 200 },
      rotationDegrees: 0,
    };
    const initialDestination = {
      rect: { x: 220, y: 140, width: 300, height: 150 },
      rotationDegrees: 0,
    };
    const pannedDestination = {
      rect: { x: 64, y: 140, width: 300, height: 150 },
      rotationDegrees: 0,
    };
    let latestDestination = initialDestination;
    render(
      <FocusTransitionOverlay
        ref={ref}
        imageUrl="noveltea-asset://source/session/image"
        sourcePresentation={source}
        destinationPresentation={initialDestination}
        getDestinationPresentation={() => latestDestination}
      >
        <div data-testid="destination-editor">Focus editor</div>
      </FocusTransitionOverlay>,
    );

    await waitFor(
      () =>
        expect(screen.getByTestId('focus-transition-overlay')).toHaveAttribute(
          'data-focus-transition-phase',
          'focused',
        ),
      { timeout: 3000 },
    );

    latestDestination = pannedDestination;

    const rejectClose = vi.fn(() => false);
    act(() => ref.current?.exit(rejectClose));

    const transitionImage = document.querySelector<HTMLElement>('[data-focus-transition-image]');
    expect(transitionImage).toHaveStyle({
      left: '64px',
      top: '140px',
      width: '300px',
      height: '150px',
    });
    expect(screen.getByTestId('focus-transition-overlay')).toHaveAttribute(
      'data-focus-transition-phase',
      'exiting',
    );
    await waitFor(
      () => {
        expect(rejectClose).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('focus-transition-overlay')).toHaveAttribute(
          'data-focus-transition-phase',
          'focused',
        );
      },
      { timeout: 3000 },
    );
    expect(document.querySelector('[data-focus-transition-destination]')).toHaveStyle({
      opacity: '1',
    });
  });

  it('mounts a restored destination directly without waiting for transition geometry', () => {
    render(
      <FocusTransitionOverlay
        imageUrl={null}
        sourcePresentation={null}
        destinationPresentation={null}
        animateEntry={false}
      >
        <div data-testid="restored-destination-editor">Focus editor</div>
      </FocusTransitionOverlay>,
    );

    expect(screen.getByTestId('focus-transition-overlay')).toHaveAttribute(
      'data-focus-transition-phase',
      'focused',
    );
    expect(document.querySelector('[data-focus-transition-destination]')).toHaveStyle({
      opacity: '1',
    });
  });

  it('shows the destination directly when no source presentation is available', async () => {
    useReducedMotionForTest();
    render(
      <FocusTransitionOverlay
        imageUrl="noveltea-asset://source/session/image"
        sourcePresentation={null}
        destinationPresentation={{
          rect: { x: 220, y: 140, width: 300, height: 150 },
          rotationDegrees: 0,
        }}
      >
        <div data-testid="destination-editor">Focus editor</div>
      </FocusTransitionOverlay>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('focus-transition-overlay')).toHaveAttribute(
        'data-focus-transition-phase',
        'focused',
      ),
    );
    expect(document.querySelector('[data-focus-transition-destination]')).toHaveStyle({
      opacity: '1',
    });
  });
});
