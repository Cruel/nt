import { useTranslation } from 'react-i18next';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';

/**
 * Authored Shader records were removed by the Material Preset/source-file cutover.
 * Shader source is opened as a project source file by the Files/source-tab workbench path.
 */
export function ShaderEditor({ tab }: WorkbenchEditorProps) {
  const { t } = useTranslation('workspace');
  return (
    <div className="p-4 text-sm text-muted-foreground">
      {t('materialEditor.shaderRemoved', { title: tab.title })}
    </div>
  );
}
