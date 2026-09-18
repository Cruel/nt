import type { WorkbenchEditorProps } from '@/workbench/editor-registry';

/**
 * Authored Shader records were removed by the Material Preset/source-file cutover.
 * Shader source is opened as a project source file by the Files/source-tab workbench path.
 */
export function ShaderEditor({ tab }: WorkbenchEditorProps) {
  return (
    <div className="p-4 text-sm text-muted-foreground">
      {tab.title}: Shader records are no longer authoring resources. Open the shader source file
      from its Material instead.
    </div>
  );
}
