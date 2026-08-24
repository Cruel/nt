import { useMemo, useState } from 'react';
import { SettingsPage, type EditorSettingsCategory } from '@/routes/settings';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  useWorkbenchEditorTabState,
  useWorkbenchTabStateStore,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';

const SETTINGS_EDITOR_TAB_STATE_SCHEMA = 'noveltea.editor.tab-state.settings';

interface SettingsEditorTabStatePayload {
  activeCategory: EditorSettingsCategory;
}

type SettingsEditorTabState = WorkbenchTabStatePayload & {
  schema: typeof SETTINGS_EDITOR_TAB_STATE_SCHEMA;
  payload?: SettingsEditorTabStatePayload;
};

function isEditorSettingsCategory(value: unknown): value is EditorSettingsCategory {
  return (
    value === 'appearance' ||
    value === 'window' ||
    value === 'workspace' ||
    value === 'preview' ||
    value === 'export' ||
    value === 'comfyui'
  );
}

function parseSettingsEditorTabState(
  value: WorkbenchTabStatePayload,
): SettingsEditorTabStatePayload | null {
  if (
    value.schema !== SETTINGS_EDITOR_TAB_STATE_SCHEMA ||
    typeof value.payload !== 'object' ||
    value.payload === null ||
    Array.isArray(value.payload)
  )
    return null;
  const payload = value.payload as Record<string, unknown>;
  if (!isEditorSettingsCategory(payload.activeCategory)) return null;
  return { activeCategory: payload.activeCategory };
}

export function SettingsTabEditor({ tab }: WorkbenchEditorProps) {
  const [activeCategory, setActiveCategory] = useState<EditorSettingsCategory>(() => {
    const savedState = useWorkbenchTabStateStore.getState().tabStatesById[tab.id];
    return savedState
      ? (parseSettingsEditorTabState(savedState)?.activeCategory ?? 'appearance')
      : 'appearance';
  });

  useWorkbenchEditorTabState<SettingsEditorTabState>(
    tab.id,
    useMemo(
      () => ({
        schema: SETTINGS_EDITOR_TAB_STATE_SCHEMA,
        captureTabState: () => ({
          schema: SETTINGS_EDITOR_TAB_STATE_SCHEMA,
          payload: { activeCategory },
        }),
        restoreTabState: (state: SettingsEditorTabState) => {
          const parsed = parseSettingsEditorTabState(state);
          if (parsed) setActiveCategory(parsed.activeCategory);
        },
      }),
      [activeCategory],
    ),
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <SettingsPage
        tabId={tab.id}
        activeCategory={activeCategory}
        onActiveCategoryChange={setActiveCategory}
      />
    </div>
  );
}
