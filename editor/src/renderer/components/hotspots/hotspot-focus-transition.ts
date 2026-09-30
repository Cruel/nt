import {
  fitImageStageZoom,
  imageStageRect,
  type ImageStageCamera,
  type StagePoint,
  type StageRect,
  type StageSize,
} from '@/components/image-stage/image-stage-transforms';

export interface HotspotFocusRoomPresentation {
  viewport: StageSize;
  visibleImageRect: StageRect;
  visibleImageUv: StageRect;
  rotationDegrees: number;
}

export interface HotspotFocusTransitionFrame {
  rect: StageRect;
  rotationDegrees: number;
}

export interface HotspotFocusTransitionFrames {
  room: HotspotFocusTransitionFrame;
  native: HotspotFocusTransitionFrame;
  focused: HotspotFocusTransitionFrame;
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

function mapRoomPointToDisplayedViewport(
  point: StagePoint,
  roomViewport: StageSize,
  displayedRoomViewport: StageRect,
): StagePoint {
  if (roomViewport.width <= 0 || roomViewport.height <= 0)
    return { x: displayedRoomViewport.x, y: displayedRoomViewport.y };
  return {
    x: displayedRoomViewport.x + (point.x / roomViewport.width) * displayedRoomViewport.width,
    y: displayedRoomViewport.y + (point.y / roomViewport.height) * displayedRoomViewport.height,
  };
}

function mapRoomRectToDisplayedViewport(
  rect: StageRect,
  roomViewport: StageSize,
  displayedRoomViewport: StageRect,
): StageRect {
  const first = mapRoomPointToDisplayedViewport(
    { x: rect.x, y: rect.y },
    roomViewport,
    displayedRoomViewport,
  );
  const second = mapRoomPointToDisplayedViewport(
    { x: rect.x + rect.width, y: rect.y + rect.height },
    roomViewport,
    displayedRoomViewport,
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

export function resolveHotspotFocusTransitionFrames({
  roomPresentation,
  displayedRoomViewport,
  focusViewport,
  imageSize,
  focusCamera,
}: {
  roomPresentation: HotspotFocusRoomPresentation;
  displayedRoomViewport: StageRect;
  focusViewport: StageSize;
  imageSize: StageSize;
  focusCamera: ImageStageCamera;
}): HotspotFocusTransitionFrames {
  const roomSourceRect = sourceImageRectFromVisibleProjection(
    roomPresentation.visibleImageRect,
    roomPresentation.visibleImageUv,
  );
  const nativeCamera = {
    zoom: fitImageStageZoom(focusViewport, imageSize, 'native'),
    pan: { x: 0, y: 0 },
  };
  const displayedRoomSourceRect = mapRoomRectToDisplayedViewport(
    roomSourceRect,
    roomPresentation.viewport,
    displayedRoomViewport,
  );
  const displayedRoomRotationPivot = mapRoomPointToDisplayedViewport(
    {
      x: roomPresentation.viewport.width * 0.5,
      y: roomPresentation.viewport.height * 0.5,
    },
    roomPresentation.viewport,
    displayedRoomViewport,
  );
  return {
    room: {
      rect: bakeRotationPivotIntoRect(
        displayedRoomSourceRect,
        roomPresentation.rotationDegrees,
        displayedRoomRotationPivot,
      ),
      rotationDegrees: roomPresentation.rotationDegrees,
    },
    native: {
      rect: imageStageRect(focusViewport, imageSize, nativeCamera, 'native'),
      rotationDegrees: 0,
    },
    focused: {
      rect: imageStageRect(focusViewport, imageSize, focusCamera, 'native'),
      rotationDegrees: 0,
    },
  };
}
