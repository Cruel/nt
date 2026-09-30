import type { ImageNormalizedRect } from '../../../shared/project-schema/authoring-hotspots';
import type { EditableHotspot } from './hotspot-types';

export interface HotspotFocusHistory {
  past: readonly (readonly EditableHotspot[])[];
  present: readonly EditableHotspot[];
  future: readonly (readonly EditableHotspot[])[];
}

export function createHotspotFocusHistory(items: readonly EditableHotspot[]): HotspotFocusHistory {
  return { past: [], present: items, future: [] };
}

function pushHistory(
  history: HotspotFocusHistory,
  next: readonly EditableHotspot[],
): HotspotFocusHistory {
  if (next === history.present) return history;
  return { past: [...history.past, history.present], present: next, future: [] };
}

export function addHotspotGeometry(
  history: HotspotFocusHistory,
  hotspot: EditableHotspot,
): HotspotFocusHistory {
  return pushHistory(history, [...history.present, hotspot]);
}

export function setHotspotGeometryBounds(
  history: HotspotFocusHistory,
  hotspotId: string,
  bounds: ImageNormalizedRect,
): HotspotFocusHistory {
  const index = history.present.findIndex((item) => item.id === hotspotId && item.shape);
  if (index < 0) return history;
  const current = history.present[index];
  if (
    current.shape?.bounds.x === bounds.x &&
    current.shape.bounds.y === bounds.y &&
    current.shape.bounds.width === bounds.width &&
    current.shape.bounds.height === bounds.height
  )
    return history;
  const next = [...history.present];
  next[index] = { ...current, shape: { kind: 'rect', bounds } };
  return pushHistory(history, next);
}

export function deleteHotspotGeometry(
  history: HotspotFocusHistory,
  hotspotId: string,
): HotspotFocusHistory {
  if (!history.present.some((item) => item.id === hotspotId)) return history;
  return pushHistory(
    history,
    history.present.filter((item) => item.id !== hotspotId),
  );
}

export function undoHotspotGeometry(history: HotspotFocusHistory): HotspotFocusHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redoHotspotGeometry(history: HotspotFocusHistory): HotspotFocusHistory {
  const next = history.future[0];
  if (!next) return history;
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}

export function hotspotGeometryChanged(
  initial: readonly EditableHotspot[],
  current: readonly EditableHotspot[],
) {
  return JSON.stringify(initial) !== JSON.stringify(current);
}

export function mergeHotspotFocusGeometry(
  initial: readonly EditableHotspot[],
  current: readonly EditableHotspot[],
  latest: readonly EditableHotspot[],
): readonly EditableHotspot[] | null {
  const initialById = new Map(initial.map((item) => [item.id, item] as const));
  const initialIds = new Set(initialById.keys());
  const currentById = new Map(current.map((item) => [item.id, item] as const));
  const latestIds = new Set(latest.map((item) => item.id));
  const added = current.filter((item) => !initialIds.has(item.id));

  if (added.some((item) => latestIds.has(item.id))) return null;

  const shapeEqual = (left: EditableHotspot['shape'], right: EditableHotspot['shape']) =>
    JSON.stringify(left) === JSON.stringify(right);

  for (const original of initial) {
    if (latestIds.has(original.id)) continue;
    const draft = currentById.get(original.id);
    if (draft && !shapeEqual(draft.shape, original.shape)) return null;
  }

  const merged = latest.flatMap((item) => {
    if (!initialIds.has(item.id)) return [item];
    const original = initialById.get(item.id)!;
    const draft = currentById.get(item.id);
    if (!draft) return shapeEqual(item.shape, original.shape) ? [] : [null];
    const draftChanged = !shapeEqual(draft.shape, original.shape);
    if (!draftChanged) return [item];
    const latestChanged = !shapeEqual(item.shape, original.shape);
    if (latestChanged && !shapeEqual(item.shape, draft.shape)) return [null];
    return [{ ...item, shape: draft.shape }];
  });
  if (merged.some((item) => item === null)) return null;
  return [...(merged as EditableHotspot[]), ...added];
}
