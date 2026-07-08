import {
  BookOpen,
  Clapperboard,
  DoorOpen,
  FileCode,
  Image,
  Images,
  Layers,
  ListChecks,
  MessageSquareText,
  MonitorPlay,
  Palette,
  Puzzle,
  Settings,
  SlidersHorizontal,
  Tags,
  User,
} from 'lucide-react';
import { AssetEditor } from '@/editors/assets/AssetEditor';
import { AssetLibraryEditor } from '@/editors/assets/AssetLibraryEditor';
import { CharacterEditor } from '@/editors/characters/CharacterEditor';
import { ImageGenerationEditor } from '@/editors/comfyui/ImageGenerationEditor';
import { DialogueEditor } from '@/editors/dialogues/DialogueEditor';
import { LayoutEditor } from '@/editors/layouts/LayoutEditor';
import { MaterialEditor } from '@/editors/materials/MaterialEditor';
import { PlaceholderEntityEditor } from '@/editors/placeholder/PlaceholderEntityEditor';
import { RoomEditor } from '@/editors/rooms/RoomEditor';
import { SceneEditor } from '@/editors/scenes/SceneEditor';
import { TestsEditor } from '@/editors/tests/TestsEditor';
import { TestSuiteEditor } from '@/editors/tests/TestSuiteEditor';
import { EnginePreviewEditor } from '@/editors/preview/EnginePreviewEditor';
import { FullGamePreviewEditor } from '@/editors/preview/FullGamePreviewEditor';
import { ChaptersEditor } from '@/editors/project/ChaptersEditor';
import { ProjectSettingsEditor } from '@/editors/project/ProjectSettingsEditor';
import { TagsEditor } from '@/editors/project/TagsEditor';
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
    type: 'full-game-preview',
    label: 'Play',
    icon: MonitorPlay,
    component: FullGamePreviewEditor,
    mountPolicy: 'keep-mounted-while-open',
    previewHostPolicy: 'dedicated-while-open',
    previewPersistence: 'stateful',
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
    previewHostPolicy: 'pooled-per-tab-group',
    previewPersistence: 'derived',
  },
  {
    type: 'material-detail',
    label: 'Material Detail',
    icon: Palette,
    component: MaterialEditor,
    previewHostPolicy: 'pooled-per-tab-group',
    previewPersistence: 'derived',
  },
  {
    type: 'layout-detail',
    label: 'Layout Detail',
    icon: Layers,
    component: LayoutEditor,
    previewHostPolicy: 'pooled-per-tab-group',
    previewPersistence: 'derived',
  },
  {
    type: 'character-detail',
    label: 'Character Detail',
    icon: User,
    component: CharacterEditor,
    previewHostPolicy: 'pooled-per-tab-group',
    previewPersistence: 'derived',
  },
  {
    type: 'room-detail',
    label: 'Room Detail',
    icon: DoorOpen,
    component: RoomEditor,
    previewHostPolicy: 'pooled-per-tab-group',
    previewPersistence: 'derived',
  },
  {
    type: 'dialogue-detail',
    label: 'Dialogue Detail',
    icon: MessageSquareText,
    component: DialogueEditor,
    previewHostPolicy: 'pooled-per-tab-group',
    previewPersistence: 'derived',
  },
  {
    type: 'scene-detail',
    label: 'Scene Detail',
    icon: Clapperboard,
    component: SceneEditor,
    previewHostPolicy: 'pooled-per-tab-group',
    previewPersistence: 'derived',
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
    type: 'placeholder-entity',
    label: 'Placeholder Entity',
    icon: Puzzle,
    component: PlaceholderEntityEditor,
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
  {
    type: 'project-chapters',
    label: 'Chapters',
    icon: BookOpen,
    component: ChaptersEditor,
  },
  {
    type: 'project-tags',
    label: 'Tags',
    icon: Tags,
    component: TagsEditor,
  },
];

export const defaultEditorRegistry = createEditorRegistry(defaultEditorRegistrations);
