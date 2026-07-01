import { Clapperboard, DoorOpen, FileCode, Image, Layers, ListChecks, MessageSquareText, MonitorPlay, Palette, Puzzle, Settings, SlidersHorizontal, User } from 'lucide-react';
import { AssetEditor } from '@/editors/assets/AssetEditor';
import { CharacterEditor } from '@/editors/characters/CharacterEditor';
import { DialogueEditor } from '@/editors/dialogues/DialogueEditor';
import { LayoutEditor } from '@/editors/layouts/LayoutEditor';
import { MaterialEditor } from '@/editors/materials/MaterialEditor';
import { RoomEditor } from '@/editors/rooms/RoomEditor';
import { SceneEditor } from '@/editors/scenes/SceneEditor';
import { TestsEditor } from '@/editors/tests/TestsEditor';
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
    type: 'dialogue-detail',
    label: 'Dialogue Detail',
    icon: MessageSquareText,
    component: DialogueEditor,
  },
  {
    type: 'scene-detail',
    label: 'Scene Detail',
    icon: Clapperboard,
    component: SceneEditor,
  },
  {
    type: 'test-detail',
    label: 'Test Detail',
    icon: ListChecks,
    component: TestsEditor,
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
