import { DoorOpen, FileCode, Image, Layers, MonitorPlay, Palette, Puzzle, Settings, SlidersHorizontal, User } from 'lucide-react';
import { AssetEditor } from '@/editors/assets/AssetEditor';
import { CharacterEditor } from '@/editors/characters/CharacterEditor';
import { LayoutEditor } from '@/editors/layouts/LayoutEditor';
import { MaterialEditor } from '@/editors/materials/MaterialEditor';
import { RoomEditor } from '@/editors/rooms/RoomEditor';
import { EnginePreviewEditor } from '@/editors/preview/EnginePreviewEditor';
import { ShaderEditor } from '@/editors/shaders/ShaderEditor';
import { ComponentsTabEditor } from '@/editors/utility/ComponentsTabEditor';
import { SettingsTabEditor } from '@/editors/utility/SettingsTabEditor';
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
    type: 'room-detail',
    label: 'Room Detail',
    icon: DoorOpen,
    component: RoomEditor,
  },
  {
    type: 'variables',
    label: 'Variables',
    icon: SlidersHorizontal,
    component: VariablesEditor,
  },
  {
    type: 'components',
    label: 'Components',
    icon: Puzzle,
    component: ComponentsTabEditor,
  },
  {
    type: 'settings',
    label: 'Settings',
    icon: Settings,
    component: SettingsTabEditor,
  },
];

export const defaultEditorRegistry = createEditorRegistry(defaultEditorRegistrations);
