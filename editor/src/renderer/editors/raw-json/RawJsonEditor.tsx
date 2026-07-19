import type { WorkbenchEditorProps } from '@/workbench/editor-registry';

export function RawJsonEditor(_props: WorkbenchEditorProps) {
  return (
    <div className="flex h-full items-center justify-center bg-background p-6 text-center text-sm text-muted-foreground">
      <div>
        <div className="font-medium text-foreground">Document editing unavailable</div>
        <p className="mt-1 max-w-sm">
          Project records must be edited through typed editors and command-backed operations.
        </p>
      </div>
    </div>
  );
}
