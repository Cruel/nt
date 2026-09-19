import {
  applyWorkbenchTabState,
  captureWorkbenchTabState,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';

export const SHADER_SOURCE_TAB_STATE_SCHEMA = 'noveltea.editor.shader-source-tab-state.v1' as const;

export interface ShaderSourceTabState {
  materialIds: string[];
}

export function parseShaderSourceTabState(state: WorkbenchTabStatePayload | null | undefined) {
  if (!state || state.schema !== SHADER_SOURCE_TAB_STATE_SCHEMA) return null;
  const payload = state.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const materialIds = (payload as Record<string, unknown>).materialIds;
  if (!Array.isArray(materialIds) || !materialIds.every((id) => typeof id === 'string'))
    return null;
  return { materialIds: [...new Set(materialIds)] } satisfies ShaderSourceTabState;
}

export function shaderSourceTabState(materialIds: readonly string[]): WorkbenchTabStatePayload {
  return {
    schema: SHADER_SOURCE_TAB_STATE_SCHEMA,
    payload: { materialIds: [...new Set(materialIds)] },
  };
}

export function seedShaderSourceTabMaterial(tabId: string, materialId: string): void {
  const current = parseShaderSourceTabState(captureWorkbenchTabState(tabId));
  const remaining = (current?.materialIds ?? []).filter((id) => id !== materialId);
  applyWorkbenchTabState(tabId, shaderSourceTabState([materialId, ...remaining]));
}
