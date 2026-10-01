import { describe, expect, it } from 'vite-plus/test';
import { resolveRoomEditPresentationEnvironment } from '@/editors/rooms/room-edit-presentation';

describe('Room Edit presentation environment', () => {
  it('matches capped native presentation raster semantics below and above reference resolution', () => {
    expect(
      resolveRoomEditPresentationEnvironment(
        { width: 1920, height: 1080 },
        { width: 960, height: 540 },
        'capped',
      ),
    ).toEqual({
      referenceToWorldRasterScale: [0.5, 0.5],
      contextLogicalToRasterScale: [0.5, 0.5],
      viewportPixelDimensions: [960, 540],
    });

    expect(
      resolveRoomEditPresentationEnvironment(
        { width: 1920, height: 1080 },
        { width: 3840, height: 2160 },
        'capped',
      ),
    ).toEqual({
      referenceToWorldRasterScale: [1, 1],
      contextLogicalToRasterScale: [2, 2],
      viewportPixelDimensions: [3840, 2160],
    });
  });

  it('uses the fitted framebuffer viewport and native world raster policy', () => {
    expect(
      resolveRoomEditPresentationEnvironment(
        { width: 1920, height: 1080 },
        { width: 2048, height: 1536 },
        'native',
      ),
    ).toEqual({
      referenceToWorldRasterScale: [2048 / 1920, 1152 / 1080],
      contextLogicalToRasterScale: [2048 / 1920, 1152 / 1080],
      viewportPixelDimensions: [2048, 1152],
    });
  });
});
