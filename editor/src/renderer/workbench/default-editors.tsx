import { FileCode, Image, Layers, MonitorPlay, Palette, SlidersHorizontal, User } from 'lucide-react';
import { AssetEditor } from '@/editors/assets/AssetEditor';
import { CharacterEditor } from '@/editors/characters/CharacterEditor';
import { LayoutEditor } from '@/editors/layouts/LayoutEditor';
import { MaterialEditor } from '@/editors/materials/MaterialEditor';
import { EnginePreviewEditor } from '@/editors/preview/EnginePreviewEditor';
import { ShaderEditor } from '@/editors/shaders/ShaderEditor';
import { VariablesEditor } from '@/editors/variables/VariablesEditor';
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
    type: 'layout-detail',
    label: 'Layout Detail',
    icon: Layers,
    component: LayoutEditor,
  },
  {
    type: 'character-detail',
    label: 'Character Detail',
    icon: User,
    component: CharacterEditor,
  },
  {
    type: 'variables',
    label: 'Variables',
    icon: SlidersHorizontal,
    component: VariablesEditor,
  },
];

export const defaultEditorRegistry = createEditorRegistry(defaultEditorRegistrations);
