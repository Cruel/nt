import type { z } from 'zod';
import {
  animationMotionDurationMs,
  animationMarkerTime,
  type animationMotionSchema,
  type motionPlaybackPolicySchema,
  type spriteAnimationMotionSchema,
} from './project-schema/authoring-animations';

export type SpriteMotion = z.infer<typeof spriteAnimationMotionSchema>;
export type AnimationMotion = z.infer<typeof animationMotionSchema>;
export type MotionPolicy = z.infer<typeof motionPlaybackPolicySchema>;

export function animationDuration(motion: AnimationMotion): number {
  return animationMotionDurationMs(motion) ?? 0;
}

// This is the authoring manipulation counterpart of WorldPresentationBackend's raster_phase.
export function advanceAnimationTime(
  motion: AnimationMotion,
  policy: MotionPolicy,
  anchorMs: number,
  elapsedMs: number,
): number {
  const duration = animationDuration(motion);
  if (policy.repeat === 'once') {
    const remaining = Math.max(0, duration - anchorMs);
    return elapsedMs > 0 && policy.rate >= remaining / elapsedMs
      ? duration
      : Math.min(anchorMs + policy.rate * elapsedMs, duration);
  }
  const start = animationMarkerTime(motion, policy.loopRange?.start ?? 'start');
  const end = animationMarkerTime(motion, policy.loopRange?.end ?? 'end');
  if (start === null || end === null || start >= end)
    throw new Error('Invalid Animation loop range');
  if (anchorMs < end && (elapsedMs === 0 || policy.rate < (end - anchorMs) / elapsedMs))
    return anchorMs + policy.rate * elapsedMs;
  const length = end - start;
  const wholeMs = Math.floor(elapsedMs);
  const fractionMs = elapsedMs - wholeMs;
  const advance =
    (((policy.rate % length) * wholeMs) % length) + ((policy.rate * fractionMs) % length);
  const offset = (anchorMs - start + advance) % length;
  return start + (offset < 0 ? offset + length : offset);
}

export function animationFrameAt(motion: SpriteMotion, timeMs: number): number {
  for (let index = 0; index < motion.frames.length; index++) {
    const frame = motion.frames[index]!;
    if (timeMs < frame.durationMs) return index;
    timeMs -= frame.durationMs;
  }
  return motion.frames.length - 1;
}

export function animationFrameTime(motion: SpriteMotion, frameIndex: number): number {
  return motion.frames.slice(0, frameIndex).reduce((sum, frame) => sum + frame.durationMs, 0);
}
