export const OPAQUE_VIDEO_FRAME_RATE = 30;

export interface OpaqueVideoPreparationRequest {
  animationId: string;
  motionId: string;
  assetId: string;
  sourcePath: string;
  canvas: { width: number; height: number };
  sourceRange?: { startMs: number; endMs: number };
}

export interface OpaqueVideoPreparationResult {
  contentHash: string;
  hadAudio: boolean;
  browserVideo: {
    sourcePath: string;
    projectRelativePath: string;
    contentHash: string;
    byteSize: number;
    width: number;
    height: number;
  };
  frames: {
    sourcePath: string;
    projectRelativePath: string;
    contentHash: string;
    byteSize: number;
    durationMs: number;
  }[];
}
