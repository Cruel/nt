import { FileJson, Image, MonitorPlay } from 'lucide-react';
import { AssetEditor } from '@/editors/assets/AssetEditor';
import { RawJsonEditor } from '@/editors/raw-json/RawJsonEditor';
import { EnginePreviewEditor } from '@/editors/preview/EnginePreviewEditor';
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
    type: 'raw-json',
    label: 'Raw JSON',
    icon: FileJson,
    component: RawJsonEditor,
  },
];

export const defaultEditorRegistry = createEditorRegistry(defaultEditorRegistrations);
