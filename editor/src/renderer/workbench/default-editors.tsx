import { FileJson, MonitorPlay } from 'lucide-react';
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
    type: 'raw-json',
    label: 'Raw JSON',
    icon: FileJson,
    component: RawJsonEditor,
  },
];

export const defaultEditorRegistry = createEditorRegistry(defaultEditorRegistrations);
