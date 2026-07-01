import { ComponentsPage } from '@/routes/components';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';

export function ComponentsTabEditor(_props: WorkbenchEditorProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <ComponentsPage />
    </div>
  );
}
