import { expect, it } from 'vite-plus/test';
import {
  advanceAnimationTime,
  animationFrameAt,
  type SpriteMotion,
  type MotionPolicy,
} from '../../shared/animation-timeline';

const motion: SpriteMotion = {
  id: 'idle',
  kind: 'sprite-sequence',
  markers: [{ id: 'quarter', timeMs: 25 }],
  frames: [
    { image: { $ref: { collection: 'assets', id: 'a' } }, durationMs: 50 },
    { image: { $ref: { collection: 'assets', id: 'b' } }, durationMs: 100 },
  ],
};
const policy: MotionPolicy = {
  repeat: 'loop',
  rate: 1,
  clock: 'gameplay',
  initialMarker: null,
  loopRange: { start: 'quarter', end: 'end' },
};

it('uses absolute markers, plays the intro once, and wraps at the exclusive loop endpoint', () => {
  for (const [elapsed, expectedTime, expectedFrame] of [
    [0, 0, 0],
    [149, 149, 1],
    [150, 25, 0],
    [175, 50, 1],
    [275, 25, 0],
  ]) {
    const time = advanceAnimationTime(motion, policy, 0, elapsed!);
    expect(time).toBe(expectedTime);
    expect(animationFrameAt(motion, time)).toBe(expectedFrame);
  }
  expect(advanceAnimationTime(motion, { ...policy, rate: 2 }, 25, 62.5)).toBe(25);
  expect(advanceAnimationTime(motion, { ...policy, rate: 126 }, 0, 1.5)).toBe(64);
  expect(
    advanceAnimationTime(
      motion,
      { repeat: 'once', rate: 1, clock: 'gameplay', initialMarker: null },
      0,
      200,
    ),
  ).toBe(150);
  expect(animationFrameAt(motion, 150)).toBe(1);
  expect(() =>
    advanceAnimationTime(motion, { ...policy, loopRange: { start: 'end', end: 'quarter' } }, 0, 1),
  ).toThrow();
});
