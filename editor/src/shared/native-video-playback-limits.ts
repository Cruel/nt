/**
 * Current native prepared-VP9 admission limits. Smaller/odd videos may still play
 * through a different hardware decoder or the built-in libvpx software fallback.
 */
export const NATIVE_VIDEO_MAX_DIMENSION = 8192;
export const NATIVE_VIDEO_MAX_SOURCE_BYTES = 128 * 1024 * 1024;
export const NATIVE_VIDEO_MIN_TESTED_NVDEC_DIMENSION = 128;

export type VideoCanvasNotice = 'native-limit' | 'hardware-may-fallback' | null;

export function videoCanvasNotice(canvas: { width: number; height: number }): VideoCanvasNotice {
  const { width, height } = canvas;
  if (width > NATIVE_VIDEO_MAX_DIMENSION || height > NATIVE_VIDEO_MAX_DIMENSION)
    return 'native-limit';
  if (
    width < NATIVE_VIDEO_MIN_TESTED_NVDEC_DIMENSION ||
    height < NATIVE_VIDEO_MIN_TESTED_NVDEC_DIMENSION ||
    width % 2 !== 0 ||
    height % 2 !== 0
  )
    return 'hardware-may-fallback';
  return null;
}
