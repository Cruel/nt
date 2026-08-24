import { clampImageStageCamera, type StageSize } from './image-stage-transforms';

export const HOTSPOT_VIEW_STATE_SCHEMA = 'noveltea.editor.hotspot-view' as const;

export type HotspotTool = 'select' | 'draw-rect' | 'pan';

export interface HotspotEditorViewState {
  schema: typeof HOTSPOT_VIEW_STATE_SCHEMA;
  tool: HotspotTool;
  selectedHotspotId: string | null;
  zoom: number;
  panX: number;
  panY: number;
}

export const defaultHotspotViewState = (): HotspotEditorViewState => ({
  schema: HOTSPOT_VIEW_STATE_SCHEMA,
  tool: 'select',
  selectedHotspotId: null,
  zoom: 1,
  panX: 0,
  panY: 0,
});

export function parseHotspotViewTabState(value: unknown): HotspotEditorViewState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (
    keys.length !== 6 ||
    !['schema', 'tool', 'selectedHotspotId', 'zoom', 'panX', 'panY'].every((key) =>
      Object.hasOwn(value, key),
    )
  )
    return undefined;
  const state = value as Partial<HotspotEditorViewState>;
  if (
    state.schema !== HOTSPOT_VIEW_STATE_SCHEMA ||
    !['select', 'draw-rect', 'pan'].includes(String(state.tool)) ||
    typeof state.panX !== 'number' ||
    !Number.isFinite(state.panX) ||
    typeof state.panY !== 'number' ||
    !Number.isFinite(state.panY) ||
    typeof state.zoom !== 'number' ||
    !Number.isFinite(state.zoom) ||
    (state.selectedHotspotId !== null && typeof state.selectedHotspotId !== 'string')
  )
    return undefined;
  return {
    schema: HOTSPOT_VIEW_STATE_SCHEMA,
    tool: state.tool as HotspotTool,
    selectedHotspotId: state.selectedHotspotId,
    zoom: Math.min(16, Math.max(0.1, state.zoom)),
    panX: state.panX,
    panY: state.panY,
  };
}

export function restoreHotspotViewState(
  value: unknown,
  hotspotIds: Iterable<string>,
  geometry?: { viewport: StageSize; image: StageSize },
): HotspotEditorViewState {
  const parsed = parseHotspotViewTabState(value) ?? defaultHotspotViewState();
  const ids = new Set(hotspotIds);
  const camera = geometry
    ? clampImageStageCamera(
        geometry.viewport,
        geometry.image,
        { zoom: parsed.zoom, pan: { x: parsed.panX, y: parsed.panY } },
        32,
      )
    : { zoom: parsed.zoom, pan: { x: parsed.panX, y: parsed.panY } };
  return {
    ...parsed,
    selectedHotspotId:
      parsed.selectedHotspotId && ids.has(parsed.selectedHotspotId)
        ? parsed.selectedHotspotId
        : null,
    zoom: camera.zoom,
    panX: camera.pan.x,
    panY: camera.pan.y,
  };
}
