import type { z } from 'zod';
import type { videoFrameSamplingSchema } from './project-schema/authoring-animations';

export type VideoFrameSampling = z.infer<typeof videoFrameSamplingSchema>;

export interface VideoSourceTimingRequest {
  assetId: string;
  sourcePath: string;
  sourceRange?: { startMs: number; endMs: number };
}

export interface VideoSourceTimingResult {
  sampleTimesMs: number[];
  endpointMs: number;
}

export interface OpaqueVideoPreparationRequest {
  animationId: string;
  motionId: string;
  assetId: string;
  sourcePath: string;
  canvas: { width: number; height: number };
  sourceRange?: { startMs: number; endMs: number };
  frameSampling?: VideoFrameSampling;
}

export interface OpaqueVideoPreparationResult {
  contentHash: string;
  hadAudio: boolean;
  reducedColorPrecision: boolean;
  browserVideo: {
    sourcePath: string;
    projectRelativePath: string;
    contentHash: string;
    byteSize: number;
    width: number;
    height: number;
  };
  frameDurationsMs: number[];
  alphaWebp?: {
    sourcePath: string;
    projectRelativePath: string;
    contentHash: string;
    byteSize: number;
    width: number;
    height: number;
  };
}
