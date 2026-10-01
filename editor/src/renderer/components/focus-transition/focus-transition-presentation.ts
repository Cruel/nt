import type {
  StagePoint,
  StageRect,
  StageSize,
} from '@/components/image-stage/image-stage-transforms';

export interface FocusTransitionImagePresentation {
  rect: StageRect;
  rotationDegrees: number;
}

export interface FocusTransitionProjectedSource {
  viewport: StageSize;
  displayedViewportScreenRect: StageRect;
  visibleImageRect: StageRect;
  visibleImageUv: StageRect;
  rotationDegrees: number;
}

function sourceImageRectFromVisibleProjection(
  visibleImageRect: StageRect,
  visibleImageUv: StageRect,
): StageRect {
  if (visibleImageUv.width <= 0 || visibleImageUv.height <= 0) return visibleImageRect;
  const width = visibleImageRect.width / visibleImageUv.width;
  const height = visibleImageRect.height / visibleImageUv.height;
  return {
    x: visibleImageRect.x - visibleImageUv.x * width,
    y: visibleImageRect.y - visibleImageUv.y * height,
    width,
    height,
  };
}

function mapPointToDisplayedViewport(
  point: StagePoint,
  sourceViewport: StageSize,
  displayedViewport: StageRect,
): StagePoint {
  if (sourceViewport.width <= 0 || sourceViewport.height <= 0)
    return { x: displayedViewport.x, y: displayedViewport.y };
  return {
    x: displayedViewport.x + (point.x / sourceViewport.width) * displayedViewport.width,
    y: displayedViewport.y + (point.y / sourceViewport.height) * displayedViewport.height,
  };
}

function mapRectToDisplayedViewport(
  rect: StageRect,
  sourceViewport: StageSize,
  displayedViewport: StageRect,
): StageRect {
  const first = mapPointToDisplayedViewport(
    { x: rect.x, y: rect.y },
    sourceViewport,
    displayedViewport,
  );
  const second = mapPointToDisplayedViewport(
    { x: rect.x + rect.width, y: rect.y + rect.height },
    sourceViewport,
    displayedViewport,
  );
  return {
    x: first.x,
    y: first.y,
    width: second.x - first.x,
    height: second.y - first.y,
  };
}

function bakeRotationPivotIntoRect(
  rect: StageRect,
  rotationDegrees: number,
  pivot: StagePoint,
): StageRect {
  if (rotationDegrees === 0) return rect;
  const center = {
    x: rect.x + rect.width * 0.5,
    y: rect.y + rect.height * 0.5,
  };
  const radians = (rotationDegrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const relative = { x: center.x - pivot.x, y: center.y - pivot.y };
  const rotatedCenter = {
    x: pivot.x + relative.x * cosine - relative.y * sine,
    y: pivot.y + relative.x * sine + relative.y * cosine,
  };
  return {
    x: rect.x + rotatedCenter.x - center.x,
    y: rect.y + rotatedCenter.y - center.y,
    width: rect.width,
    height: rect.height,
  };
}

export function resolveProjectedSourcePresentation(
  source: FocusTransitionProjectedSource,
): FocusTransitionImagePresentation {
  const sourceRect = sourceImageRectFromVisibleProjection(
    source.visibleImageRect,
    source.visibleImageUv,
  );
  const displayedSourceRect = mapRectToDisplayedViewport(
    sourceRect,
    source.viewport,
    source.displayedViewportScreenRect,
  );
  const displayedRotationPivot = mapPointToDisplayedViewport(
    {
      x: source.viewport.width * 0.5,
      y: source.viewport.height * 0.5,
    },
    source.viewport,
    source.displayedViewportScreenRect,
  );
  return {
    rect: bakeRotationPivotIntoRect(
      displayedSourceRect,
      source.rotationDegrees,
      displayedRotationPivot,
    ),
    rotationDegrees: source.rotationDegrees,
  };
}

export function screenPresentationToLocal(
  presentation: FocusTransitionImagePresentation,
  containerRect: StageRect,
): FocusTransitionImagePresentation {
  return {
    rect: {
      x: presentation.rect.x - containerRect.x,
      y: presentation.rect.y - containerRect.y,
      width: presentation.rect.width,
      height: presentation.rect.height,
    },
    rotationDegrees: presentation.rotationDegrees,
  };
}
