import { FileCode, FileJson, Image, MonitorPlay, Palette } from 'lucide-react';
import { AssetEditor } from '@/editors/assets/AssetEditor';
import { MaterialEditor } from '@/editors/materials/MaterialEditor';
import { RawJsonEditor } from '@/editors/raw-json/RawJsonEditor';
import { EnginePreviewEditor } from '@/editors/preview/EnginePreviewEditor';
import { ShaderEditor } from '@/editors/shaders/ShaderEditor';
import { createEditorRegistry, type WorkbenchEditorRegistration } from './editor-registry';

export const defaultEditorRegistrations: WorkbenchEditorRegistration[] = [
  {
    type: 'engine-preview',
    label: 'Engine Preview',
    icon: MonitorPlay,
    component: EnginePreviewEditor,
  },
  {
    type: 'asset-detail',
    label: 'Asset Detail',
    icon: Image,
    component: AssetEditor,
  },
  {
    type: 'shader-detail',
    label: 'Shader Detail',
    icon: FileCode,
    component: ShaderEditor,
  },
  {
    type: 'material-detail',
    label: 'Material Detail',
    icon: Palette,
    component: MaterialEditor,
  },
  {
    type: 'raw-json',
    label: 'Raw JSON',
    icon: FileJson,
    component: RawJsonEditor,
  },
];

export const defaultEditorRegistry = createEditorRegistry(defaultEditorRegistrations);
