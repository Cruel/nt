import type { ImageNormalizedRect } from '../../../shared/project-schema/authoring-hotspots';

export interface StagePoint {
  x: number;
  y: number;
}

export interface StageSize {
  width: number;
  height: number;
}

export interface StageRect extends StagePoint, StageSize {}

export interface ReferenceNormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageStageCamera {
  zoom: number;
  pan: StagePoint;
}

export interface RoomBackgroundTransform {
  imageRect: StageRect;
  visibleImageUv: ImageNormalizedRect;
}

export type RoomBackgroundFit = 'cover' | 'contain' | 'stretch' | 'center';

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

export function containRect(container: StageSize, content: StageSize): StageRect {
  if (container.width <= 0 || container.height <= 0 || content.width <= 0 || content.height <= 0)
    return { x: 0, y: 0, width: 0, height: 0 };
  const scale = Math.min(container.width / content.width, container.height / content.height);
  const width = content.width * scale;
  const height = content.height * scale;
  return {
    x: (container.width - width) / 2,
    y: (container.height - height) / 2,
    width,
    height,
  };
}

export function imageStageRect(
  viewport: StageSize,
  image: StageSize,
  camera: ImageStageCamera,
): StageRect {
  const base = containRect(viewport, image);
  const zoom = clamp(camera.zoom, 0.1, 16);
  const width = base.width * zoom;
  const height = base.height * zoom;
  return {
    x: viewport.width / 2 - width / 2 + camera.pan.x,
    y: viewport.height / 2 - height / 2 + camera.pan.y,
    width,
    height,
  };
}

export function clampImageStageCamera(
  viewport: StageSize,
  image: StageSize,
  camera: ImageStageCamera,
  minimumVisiblePixels = 32,
): ImageStageCamera {
  const zoom = clamp(camera.zoom, 0.1, 16);
  if (viewport.width <= 0 || viewport.height <= 0 || image.width <= 0 || image.height <= 0)
    return { zoom, pan: { ...camera.pan } };
  const fitted = containRect(viewport, image);
  const imageWidth = fitted.width * zoom;
  const imageHeight = fitted.height * zoom;
  const visibleX = Math.min(minimumVisiblePixels, viewport.width, imageWidth);
  const visibleY = Math.min(minimumVisiblePixels, viewport.height, imageHeight);
  const maximumPanX = Math.max(0, (viewport.width + imageWidth) / 2 - visibleX);
  const maximumPanY = Math.max(0, (viewport.height + imageHeight) / 2 - visibleY);
  return {
    zoom,
    pan: {
      x: clamp(camera.pan.x, -maximumPanX, maximumPanX),
      y: clamp(camera.pan.y, -maximumPanY, maximumPanY),
    },
  };
}

export function imageUvToStage(point: StagePoint, imageRect: StageRect): StagePoint {
  return {
    x: imageRect.x + point.x * imageRect.width,
    y: imageRect.y + point.y * imageRect.height,
  };
}

export function imagePixelToUv(point: StagePoint, image: StageSize): StagePoint {
  return {
    x: image.width > 0 ? point.x / image.width : 0,
    y: image.height > 0 ? point.y / image.height : 0,
  };
}

export function imageUvToPixel(point: StagePoint, image: StageSize): StagePoint {
  return { x: point.x * image.width, y: point.y * image.height };
}

export function stageToImageUv(point: StagePoint, imageRect: StageRect): StagePoint {
  if (imageRect.width <= 0 || imageRect.height <= 0) return { x: 0, y: 0 };
  return {
    x: (point.x - imageRect.x) / imageRect.width,
    y: (point.y - imageRect.y) / imageRect.height,
  };
}

export function imageRectToStage(bounds: ImageNormalizedRect, imageRect: StageRect): StageRect {
  const origin = imageUvToStage(bounds, imageRect);
  return {
    ...origin,
    width: bounds.width * imageRect.width,
    height: bounds.height * imageRect.height,
  };
}

export function stageRectToImage(bounds: StageRect, imageRect: StageRect): ImageNormalizedRect {
  const first = stageToImageUv({ x: bounds.x, y: bounds.y }, imageRect);
  const second = stageToImageUv(
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    imageRect,
  );
  return normalizedRectFromPoints(first, second);
}

export function normalizedRectFromPoints(
  first: StagePoint,
  second: StagePoint,
  minimumSize = 0,
): ImageNormalizedRect {
  const left = clamp(Math.min(first.x, second.x), 0, 1);
  const top = clamp(Math.min(first.y, second.y), 0, 1);
  const right = clamp(Math.max(first.x, second.x), left, 1);
  const bottom = clamp(Math.max(first.y, second.y), top, 1);
  const width = clamp(Math.max(right - left, minimumSize), 0, 1 - left);
  const height = clamp(Math.max(bottom - top, minimumSize), 0, 1 - top);
  return { x: left, y: top, width, height };
}

export function moveNormalizedRect(
  bounds: ImageNormalizedRect,
  delta: StagePoint,
): ImageNormalizedRect {
  return {
    ...bounds,
    x: clamp(bounds.x + delta.x, 0, 1 - bounds.width),
    y: clamp(bounds.y + delta.y, 0, 1 - bounds.height),
  };
}

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export function resizeNormalizedRect(
  initial: ImageNormalizedRect,
  handle: ResizeHandle,
  delta: StagePoint,
  minimumSize: StagePoint,
): ImageNormalizedRect {
  let left = initial.x;
  let top = initial.y;
  let right = initial.x + initial.width;
  let bottom = initial.y + initial.height;
  if (handle.includes('w')) left = clamp(left + delta.x, 0, right - minimumSize.x);
  if (handle.includes('e')) right = clamp(right + delta.x, left + minimumSize.x, 1);
  if (handle.includes('n')) top = clamp(top + delta.y, 0, bottom - minimumSize.y);
  if (handle.includes('s')) bottom = clamp(bottom + delta.y, top + minimumSize.y, 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function roomBackgroundImageRect(
  viewport: StageSize,
  image: StageSize,
  fit: RoomBackgroundFit,
): StageRect {
  if (viewport.width <= 0 || viewport.height <= 0 || image.width <= 0 || image.height <= 0)
    return { x: 0, y: 0, width: 0, height: 0 };
  if (fit === 'stretch') return { x: 0, y: 0, ...viewport };
  if (fit === 'center')
    return {
      x: (viewport.width - image.width) / 2,
      y: (viewport.height - image.height) / 2,
      ...image,
    };
  const scale =
    fit === 'cover'
      ? Math.max(viewport.width / image.width, viewport.height / image.height)
      : Math.min(viewport.width / image.width, viewport.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    x: (viewport.width - width) / 2,
    y: (viewport.height - height) / 2,
    width,
    height,
  };
}

export function roomBackgroundTransform(
  viewport: StageSize,
  image: StageSize,
  fit: RoomBackgroundFit,
): RoomBackgroundTransform {
  const imageRect = roomBackgroundImageRect(viewport, image, fit);
  if (imageRect.width <= 0 || imageRect.height <= 0)
    return {
      imageRect,
      visibleImageUv: { x: 0, y: 0, width: 1, height: 1 },
    };
  const left = Math.max(0, -imageRect.x) / imageRect.width;
  const top = Math.max(0, -imageRect.y) / imageRect.height;
  const right = Math.min(imageRect.width, viewport.width - imageRect.x) / imageRect.width;
  const bottom = Math.min(imageRect.height, viewport.height - imageRect.y) / imageRect.height;
  return {
    imageRect,
    visibleImageUv: {
      x: clamp(left, 0, 1),
      y: clamp(top, 0, 1),
      width: clamp(right - left, 0, 1),
      height: clamp(bottom - top, 0, 1),
    },
  };
}

export function referenceRectToStage(bounds: ReferenceNormalizedRect, viewport: StageSize): StageRect {
  return {
    x: bounds.x * viewport.width,
    y: bounds.y * viewport.height,
    width: bounds.width * viewport.width,
    height: bounds.height * viewport.height,
  };
}
