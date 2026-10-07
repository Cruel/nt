export const MAX_RASTER_IMPORT_FRAMES = 1000;
export const MAX_RASTER_IMPORT_PIXELS = 64 * 1024 * 1024;

export function checkRasterImportSize(width: number, height: number, frames: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 10_000 ||
    height > 10_000 ||
    !Number.isInteger(frames) ||
    frames < 1 ||
    frames > MAX_RASTER_IMPORT_FRAMES ||
    width * height * frames > MAX_RASTER_IMPORT_PIXELS
  )
    throw new Error('Animation import exceeds the canvas, frame-count, or decoded-pixel limit.');
}
