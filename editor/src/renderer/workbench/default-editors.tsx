import { Clapperboard, DoorOpen, FileCode, Image, Images, Layers, ListChecks, MessageSquareText, MonitorPlay, Palette, Puzzle, Settings, SlidersHorizontal, User } from 'lucide-react';
import { AssetEditor } from '@/editors/assets/AssetEditor';
import { AssetLibraryEditor } from '@/editors/assets/AssetLibraryEditor';
import { CharacterEditor } from '@/editors/characters/CharacterEditor';
import { ImageGenerationEditor } from '@/editors/comfyui/ImageGenerationEditor';
import { DialogueEditor } from '@/editors/dialogues/DialogueEditor';
import { LayoutEditor } from '@/editors/layouts/LayoutEditor';
import { MaterialEditor } from '@/editors/materials/MaterialEditor';
import { RoomEditor } from '@/editors/rooms/RoomEditor';
import { SceneEditor } from '@/editors/scenes/SceneEditor';
import { TestsEditor } from '@/editors/tests/TestsEditor';
import { TestSuiteEditor } from '@/editors/tests/TestSuiteEditor';
import { EnginePreviewEditor } from '@/editors/preview/EnginePreviewEditor';
import { ProjectSettingsEditor } from '@/editors/project/ProjectSettingsEditor';
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
    type: 'asset-library',
    label: 'Assets',
    icon: Image,
    component: AssetLibraryEditor,
  },
  {
    type: 'asset-detail',
    label: 'Asset Detail',
    icon: Image,
    component: AssetEditor,
  },
  {
    type: 'image-generation',
    label: 'Image Generation',
    icon: Images,
    component: ImageGenerationEditor,
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
    type: 'test-suite',
    label: 'Tests',
    icon: ListChecks,
    component: TestSuiteEditor,
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
  {
    type: 'project-settings',
    label: 'Project Settings',
    icon: Settings,
    component: ProjectSettingsEditor,
  },
];

export const defaultEditorRegistry = createEditorRegistry(defaultEditorRegistrations);
