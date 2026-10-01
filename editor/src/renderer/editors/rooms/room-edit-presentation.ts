import type { ProjectWorldRasterPolicy } from '../../../shared/project-schema/authoring-project-settings';

export interface RoomEditPresentationEnvironment {
  referenceToWorldRasterScale: readonly [number, number];
  contextLogicalToRasterScale: readonly [number, number];
  viewportPixelDimensions: readonly [number, number];
}

function positiveInteger(value: number) {
  return Math.max(1, Math.round(Number.isFinite(value) ? value : 1));
}

function fittedViewport(
  host: { width: number; height: number },
  reference: { width: number; height: number },
) {
  const hostWidth = positiveInteger(host.width);
  const hostHeight = positiveInteger(host.height);
  const referenceWidth = positiveInteger(reference.width);
  const referenceHeight = positiveInteger(reference.height);
  let width = hostWidth;
  let height = Math.max(1, Math.floor((hostWidth * referenceHeight) / referenceWidth));
  if (height > hostHeight) {
    height = hostHeight;
    width = Math.max(1, Math.floor((hostHeight * referenceWidth) / referenceHeight));
  }
  return { width, height };
}

export function resolveRoomEditPresentationEnvironment(
  reference: { width: number; height: number },
  hostFramebuffer: { width: number; height: number },
  worldRasterPolicy: ProjectWorldRasterPolicy,
): RoomEditPresentationEnvironment {
  const referenceWidth = positiveInteger(reference.width);
  const referenceHeight = positiveInteger(reference.height);
  const viewport = fittedViewport(hostFramebuffer, reference);
  const worldRaster =
    worldRasterPolicy === 'native' ||
    (viewport.width <= referenceWidth && viewport.height <= referenceHeight)
      ? viewport
      : { width: referenceWidth, height: referenceHeight };
  return {
    referenceToWorldRasterScale: [
      worldRaster.width / referenceWidth,
      worldRaster.height / referenceHeight,
    ],
    contextLogicalToRasterScale: [
      viewport.width / referenceWidth,
      viewport.height / referenceHeight,
    ],
    viewportPixelDimensions: [viewport.width, viewport.height],
  };
}
