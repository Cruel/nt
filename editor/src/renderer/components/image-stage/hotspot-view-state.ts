import { clampImageStageCamera, type StageSize } from './image-stage-transforms';

export const HOTSPOT_VIEW_STATE_SCHEMA = 'noveltea.editor.hotspot-view' as const;
export const HOTSPOT_VIEW_STATE_VERSION = 1 as const;

export type HotspotTool = 'select' | 'draw-rect' | 'pan';

export interface HotspotEditorViewStateV1 {
  schema: typeof HOTSPOT_VIEW_STATE_SCHEMA;
  schemaVersion: typeof HOTSPOT_VIEW_STATE_VERSION;
  tool: HotspotTool;
  selectedHotspotId: string | null;
  zoom: number;
  panX: number;
  panY: number;
}

export const defaultHotspotViewState = (): HotspotEditorViewStateV1 => ({
  schema: HOTSPOT_VIEW_STATE_SCHEMA,
  schemaVersion: HOTSPOT_VIEW_STATE_VERSION,
  tool: 'select',
  selectedHotspotId: null,
  zoom: 1,
  panX: 0,
  panY: 0,
});

export function parseHotspotViewTabState(value: unknown): HotspotEditorViewStateV1 | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const state = value as Partial<HotspotEditorViewStateV1>;
  if (
    state.schema !== HOTSPOT_VIEW_STATE_SCHEMA ||
    state.schemaVersion !== HOTSPOT_VIEW_STATE_VERSION ||
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
    ...(state as HotspotEditorViewStateV1),
    zoom: Math.min(16, Math.max(0.1, state.zoom)),
  };
}

export function restoreHotspotViewState(
  value: unknown,
  hotspotIds: Iterable<string>,
  geometry?: { viewport: StageSize; image: StageSize },
): HotspotEditorViewStateV1 {
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
