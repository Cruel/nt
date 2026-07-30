import { SettingsPage } from '@/routes/settings';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';

export function SettingsTabEditor({ tab }: WorkbenchEditorProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <SettingsPage tabId={tab.id} />
    </div>
  );
}
