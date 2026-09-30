import type { RoomEditProjectedRect, RoomEditRect, RoomEditSize } from './room-edit-projection';

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
  canonicalSurface: RoomEditRect,
): RoomEditNavigation {
  const value = sanitizeRoomEditNavigation(navigation);
  const visibleMarginX = Math.min(96, Math.max(32, viewport.width * 0.08));
  const visibleMarginY = Math.min(96, Math.max(32, viewport.height * 0.08));
  const centerX = viewport.width * 0.5;
  const centerY = viewport.height * 0.5;
  const baseLeft = centerX + (canonicalSurface.x - centerX) * value.zoom;
  const baseTop = centerY + (canonicalSurface.y - centerY) * value.zoom;
  const scaledWidth = canonicalSurface.width * value.zoom;
  const scaledHeight = canonicalSurface.height * value.zoom;
  const minPanX = visibleMarginX - (baseLeft + scaledWidth);
  const maxPanX = viewport.width - visibleMarginX - baseLeft;
  const minPanY = visibleMarginY - (baseTop + scaledHeight);
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
