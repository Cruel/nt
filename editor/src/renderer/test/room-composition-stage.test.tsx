import { describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen } from '@testing-library/react';
import { RoomCompositionStage } from '@/components/room-composition-stage';

describe('RoomCompositionStage', () => {
  it('keeps gesture changes local and commits moved bounds once on pointer release', () => {
    const onCommitBounds = vi.fn();
    render(
      <RoomCompositionStage
        backgroundUrl={null}
        backgroundFit="cover"
        fallbackColor={null}
        items={[
          {
            id: 'desk',
            label: 'Desk',
            bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
            occupants: ['Key'],
          },
        ]}
        selectedId="desk"
        onSelectionChange={() => {}}
        onCommitBounds={onCommitBounds}
      />,
    );
    const stage = screen.getByTestId('room-composition-stage');
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 500,
      width: 1000,
      height: 500,
      toJSON: () => ({}),
    });
    const placement = screen.getByTestId('room-placement-desk');
    fireEvent.pointerDown(placement, { pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 300, clientY: 150 });
    expect(onCommitBounds).not.toHaveBeenCalled();
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 300, clientY: 150 });
    expect(onCommitBounds).toHaveBeenCalledOnce();
    expect(onCommitBounds).toHaveBeenCalledWith('desk', {
      x: 0.3,
      y: 0.3,
      width: 0.2,
      height: 0.2,
    });
  });
});
