import type { RoomEditProjectedRect, RoomEditSize } from './room-edit-projection';

export interface RoomEditNavigation {
  zoom: number;
  pan: { x: number; y: number };
}

export const ROOM_EDIT_FIT_NAVIGATION: RoomEditNavigation = {
  zoom: 1,
  pan: { x: 0, y: 0 },
};

export const ROOM_EDIT_MIN_ZOOM = 0.25;
export const ROOM_EDIT_MAX_ZOOM = 8;
export const ROOM_EDIT_NAVIGATION_TRANSITION_MS = 180;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

export function fitRoomEditSurfaceFrame(
  available: RoomEditSize,
  authored: RoomEditSize,
): RoomEditSize {
  if (available.width <= 0 || available.height <= 0 || authored.width <= 0 || authored.height <= 0)
    return { width: 0, height: 0 };
  const scale = Math.min(available.width / authored.width, available.height / authored.height);
  return { width: authored.width * scale, height: authored.height * scale };
}

export function sanitizeRoomEditNavigation(value: RoomEditNavigation): RoomEditNavigation {
  const zoom = Number.isFinite(value.zoom)
    ? clamp(value.zoom, ROOM_EDIT_MIN_ZOOM, ROOM_EDIT_MAX_ZOOM)
    : 1;
  return {
    zoom,
    pan: {
      x: Number.isFinite(value.pan.x) ? value.pan.x : 0,
      y: Number.isFinite(value.pan.y) ? value.pan.y : 0,
    },
  };
}

export function applyRoomEditNavigation(
  projected: RoomEditProjectedRect,
  viewport: RoomEditSize,
  navigation: RoomEditNavigation,
): RoomEditProjectedRect {
  const value = sanitizeRoomEditNavigation(navigation);
  const centerX = viewport.width * 0.5;
  const centerY = viewport.height * 0.5;
  const radians = (-projected.rotationDegrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const authoredPan = {
    x: value.pan.x * cosine - value.pan.y * sine,
    y: value.pan.x * sine + value.pan.y * cosine,
  };
  return {
    rect: {
      x: centerX + (projected.rect.x - centerX) * value.zoom + authoredPan.x,
      y: centerY + (projected.rect.y - centerY) * value.zoom + authoredPan.y,
      width: projected.rect.width * value.zoom,
      height: projected.rect.height * value.zoom,
    },
    rotationDegrees: projected.rotationDegrees,
  };
}

export function zoomRoomEditNavigationAtPoint(
  navigation: RoomEditNavigation,
  viewport: RoomEditSize,
  point: { x: number; y: number },
  nextZoom: number,
): RoomEditNavigation {
  const current = sanitizeRoomEditNavigation(navigation);
  const zoom = clamp(nextZoom, ROOM_EDIT_MIN_ZOOM, ROOM_EDIT_MAX_ZOOM);
  if (zoom === current.zoom) return current;
  const center = { x: viewport.width * 0.5, y: viewport.height * 0.5 };
  const authoredPoint = {
    x: (point.x - center.x - current.pan.x) / current.zoom,
    y: (point.y - center.y - current.pan.y) / current.zoom,
  };
  return {
    zoom,
    pan: {
      x: point.x - center.x - authoredPoint.x * zoom,
      y: point.y - center.y - authoredPoint.y * zoom,
    },
  };
}

export function panRoomEditNavigation(
  navigation: RoomEditNavigation,
  delta: { x: number; y: number },
): RoomEditNavigation {
  const current = sanitizeRoomEditNavigation(navigation);
  return {
    ...current,
    pan: { x: current.pan.x + delta.x, y: current.pan.y + delta.y },
  };
}

export function clampRoomEditNavigation(
  navigation: RoomEditNavigation,
  viewport: RoomEditSize,
  canonicalSurface: RoomEditProjectedRect,
): RoomEditNavigation {
  const value = sanitizeRoomEditNavigation(navigation);
  const visibleMarginX = Math.min(96, Math.max(32, viewport.width * 0.08));
  const visibleMarginY = Math.min(96, Math.max(32, viewport.height * 0.08));
  const centerX = viewport.width * 0.5;
  const centerY = viewport.height * 0.5;
  const scaledWidth = canonicalSurface.rect.width * value.zoom;
  const scaledHeight = canonicalSurface.rect.height * value.zoom;
  const rectCenterX =
    centerX + (canonicalSurface.rect.x + canonicalSurface.rect.width * 0.5 - centerX) * value.zoom;
  const rectCenterY =
    centerY + (canonicalSurface.rect.y + canonicalSurface.rect.height * 0.5 - centerY) * value.zoom;
  const radians = (canonicalSurface.rotationDegrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const localCenterX = rectCenterX - centerX;
  const localCenterY = rectCenterY - centerY;
  const rotatedCenterX = centerX + localCenterX * cosine - localCenterY * sine;
  const rotatedCenterY = centerY + localCenterX * sine + localCenterY * cosine;
  const screenWidth = Math.abs(cosine) * scaledWidth + Math.abs(sine) * scaledHeight;
  const screenHeight = Math.abs(sine) * scaledWidth + Math.abs(cosine) * scaledHeight;
  const baseLeft = rotatedCenterX - screenWidth * 0.5;
  const baseTop = rotatedCenterY - screenHeight * 0.5;
  const minPanX = visibleMarginX - (baseLeft + screenWidth);
  const maxPanX = viewport.width - visibleMarginX - baseLeft;
  const minPanY = visibleMarginY - (baseTop + screenHeight);
  const maxPanY = viewport.height - visibleMarginY - baseTop;
  return {
    zoom: value.zoom,
    pan: {
      x: clamp(value.pan.x, Math.min(minPanX, maxPanX), Math.max(minPanX, maxPanX)),
      y: clamp(value.pan.y, Math.min(minPanY, maxPanY), Math.max(minPanY, maxPanY)),
    },
  };
}

export function interpolateRoomEditNavigation(
  from: RoomEditNavigation,
  to: RoomEditNavigation,
  progress: number,
): RoomEditNavigation {
  const start = sanitizeRoomEditNavigation(from);
  const end = sanitizeRoomEditNavigation(to);
  const t = clamp(progress, 0, 1);
  const eased = 1 - (1 - t) * (1 - t) * (1 - t);
  return {
    zoom: start.zoom + (end.zoom - start.zoom) * eased,
    pan: {
      x: start.pan.x + (end.pan.x - start.pan.x) * eased,
      y: start.pan.y + (end.pan.y - start.pan.y) * eased,
    },
  };
}
