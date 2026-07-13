import type { ComponentType, ReactNode } from 'react';
import { BookOpen, Clapperboard, DoorOpen, FileCode, Image, Images, Layers, ListChecks, MessageSquareText, MonitorPlay, Palette, Puzzle, Settings, SlidersHorizontal, Tags, User, Workflow, Wrench } from 'lucide-react';
import type { AssetNode } from '@/stores/workspace-store';
import { visualForEditorType } from '@/workspace/collection-visuals';
import type { WorkbenchTab } from './workbench-types';

export interface WorkbenchEditorProps {
  tab: WorkbenchTab;
}

export type EditorMountPolicy = 'active-only' | 'keep-mounted-while-open';

export type PreviewHostPolicy = 'none' | 'pooled-per-tab-group' | 'dedicated-while-open';

export type PreviewPersistence = 'derived' | 'stateful';

export interface WorkbenchEditorRegistration {
  type: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  component: ComponentType<WorkbenchEditorProps>;
  toolbar?: ComponentType<WorkbenchEditorProps>;
  mountPolicy?: EditorMountPolicy;
  previewHostPolicy?: PreviewHostPolicy;
  previewPersistence?: PreviewPersistence;
}

export interface ResolvedWorkbenchEditorPolicies {
  mountPolicy: EditorMountPolicy;
  previewHostPolicy: PreviewHostPolicy;
  previewPersistence?: PreviewPersistence;
}

export interface ResolvedWorkbenchEditor {
  registration: WorkbenchEditorRegistration;
  policies: ResolvedWorkbenchEditorPolicies;
}

export interface WorkbenchEditorRegistry {
  resolve: (editorType: string) => WorkbenchEditorRegistration | null;
  list: () => WorkbenchEditorRegistration[];
}

function MissingEditor({ tab }: WorkbenchEditorProps) {
  return (
    <div className="flex h-full items-center justify-center bg-background p-6 text-center text-sm text-muted-foreground">
      <div>
        <div className="font-medium text-foreground">Missing editor</div>
        <div className="mt-1 font-mono text-xs">{tab.editorType}</div>
      </div>
    </div>
  );
}

export const missingEditorRegistration: WorkbenchEditorRegistration = {
  type: 'missing-editor',
  label: 'Missing Editor',
  component: MissingEditor,
};

export function resolveEditorPolicies(
  registration: WorkbenchEditorRegistration,
): ResolvedWorkbenchEditorPolicies {
  return {
    mountPolicy: registration.mountPolicy ?? 'active-only',
    previewHostPolicy: registration.previewHostPolicy ?? 'none',
    previewPersistence: registration.previewPersistence,
  };
}

export function resolveWorkbenchEditor(
  registry: WorkbenchEditorRegistry,
  tab: Pick<WorkbenchTab, 'editorType'>,
): ResolvedWorkbenchEditor {
  const registration = registry.resolve(tab.editorType) ?? missingEditorRegistration;
  return {
    registration,
    policies: resolveEditorPolicies(registration),
  };
}

export function createEditorRegistry(
  registrations: WorkbenchEditorRegistration[],
): WorkbenchEditorRegistry {
  const byType = new Map(registrations.map((registration) => [registration.type, registration]));
  return {
    resolve: (editorType) => byType.get(editorType) ?? null,
    list: () => [...byType.values()],
  };
}

export function buildAssetDetailTabForRecord(entityId: string, title = entityId): WorkbenchTab {
  return {
    id: `tab:asset-detail:assets:${entityId}`,
    title,
    editorType: 'asset-detail',
    resource: {
      kind: 'record',
      stableId: `record:assets:${entityId}`,
      collection: 'assets',
      entityId,
    },
  };
}

export function buildShaderDetailTabForRecord(entityId: string, title = entityId): WorkbenchTab {
  return {
    id: `tab:shader-detail:shaders:${entityId}`,
    title,
    editorType: 'shader-detail',
    resource: {
      kind: 'record',
      stableId: `record:shaders:${entityId}`,
      collection: 'shaders',
      entityId,
    },
  };
}

export function buildMaterialDetailTabForRecord(entityId: string, title = entityId): WorkbenchTab {
  return {
    id: `tab:material-detail:materials:${entityId}`,
    title,
    editorType: 'material-detail',
    resource: {
      kind: 'record',
      stableId: `record:materials:${entityId}`,
      collection: 'materials',
      entityId,
    },
  };
}

export function buildLayoutDetailTabForRecord(entityId: string, title = entityId): WorkbenchTab {
  return {
    id: `tab:layout-detail:layouts:${entityId}`,
    title,
    editorType: 'layout-detail',
    resource: {
      kind: 'record',
      stableId: `record:layouts:${entityId}`,
      collection: 'layouts',
      entityId,
    },
  };
}

export function buildCharacterDetailTabForRecord(entityId: string, title = entityId): WorkbenchTab {
  return {
    id: `tab:character-detail:characters:${entityId}`,
    title,
    editorType: 'character-detail',
    resource: {
      kind: 'record',
      stableId: `record:characters:${entityId}`,
      collection: 'characters',
      entityId,
    },
  };
}


export function buildRoomDetailTabForRecord(entityId: string, title = entityId): WorkbenchTab {
  return {
    id: `tab:room-detail:rooms:${entityId}`,
    title,
    editorType: 'room-detail',
    resource: {
      kind: 'record',
      stableId: `record:rooms:${entityId}`,
      collection: 'rooms',
      entityId,
    },
  };
}

export function buildInteractableDetailTabForRecord(entityId: string, title = entityId): WorkbenchTab {
  return {
    id: `tab:interactable-detail:interactables:${entityId}`,
    title,
    editorType: 'interactable-detail',
    resource: { kind: 'record', stableId: `record:interactables:${entityId}`, collection: 'interactables', entityId },
  };
}

export function buildDialogueDetailTabForRecord(entityId: string, title = entityId): WorkbenchTab {
  return {
    id: `tab:dialogue-detail:dialogues:${entityId}`,
    title,
    editorType: 'dialogue-detail',
    resource: {
      kind: 'record',
      stableId: `record:dialogues:${entityId}`,
      collection: 'dialogues',
      entityId,
    },
  };
}

export function buildSceneDetailTabForRecord(entityId: string, title = entityId): WorkbenchTab {
  return {
    id: `tab:scene-detail:scenes:${entityId}`,
    title,
    editorType: 'scene-detail',
    resource: {
      kind: 'record',
      stableId: `record:scenes:${entityId}`,
      collection: 'scenes',
      entityId,
    },
  };
}

export function buildTestDetailTabForRecord(entityId: string, title = entityId): WorkbenchTab {
  return {
    id: `tab:test-detail:tests:${entityId}`,
    title,
    editorType: 'test-detail',
    resource: {
      kind: 'record',
      stableId: `record:tests:${entityId}`,
      collection: 'tests',
      entityId,
    },
  };
}

export function buildVerbDetailTabForRecord(entityId: string, title = entityId): WorkbenchTab {
  return {
    id: `tab:verb-detail:verbs:${entityId}`,
    title,
    editorType: 'verb-detail',
    resource: {
      kind: 'record',
      stableId: `record:verbs:${entityId}`,
      collection: 'verbs',
      entityId,
    },
  };
}

export function buildInteractionDetailTabForRecord(entityId: string, title = entityId): WorkbenchTab {
  return { id: `tab:interaction-detail:interactions:${entityId}`, title, editorType: 'interaction-detail', resource: { kind: 'record', stableId: `record:interactions:${entityId}`, collection: 'interactions', entityId } };
}

export function buildMapDetailTabForRecord(entityId: string, title = entityId): WorkbenchTab {
  return { id: `tab:map-detail:maps:${entityId}`, title, editorType: 'map-detail', resource: { kind: 'record', stableId: `record:maps:${entityId}`, collection: 'maps', entityId } };
}

export function buildScriptModuleDetailTabForRecord(entityId: string, title = entityId): WorkbenchTab {
  return { id: `tab:script-module-detail:scripts:${entityId}`, title, editorType: 'script-module-detail', resource: { kind: 'record', stableId: `record:scripts:${entityId}`, collection: 'scripts', entityId } };
}

export function buildPlaceholderEntityTabForRecord(collection: string, entityId: string, title = entityId): WorkbenchTab {
  return {
    id: `tab:placeholder:${collection}:${entityId}`,
    title,
    editorType: 'placeholder-entity',
    resource: {
      kind: 'record',
      stableId: `record:${collection}:${entityId}`,
      collection,
      entityId,
    },
  };
}

export function buildImageGenerationTab(options: { sourceAssetId?: string; sourceProjectRelativePath?: string; mode?: 'generate' | 'edit' } = {}): WorkbenchTab {
  const suffix = options.sourceAssetId ? `:${options.sourceAssetId}` : '';
  return {
    id: `tab:image-generation${suffix}`,
    title: options.mode === 'edit' ? 'Edit Image' : 'Generate Image',
    editorType: 'image-generation',
    resource: {
      kind: 'tool',
      stableId: `utility:image-generation${suffix}`,
      collection: 'assets',
      entityId: options.sourceAssetId,
      generationMode: options.mode ?? 'generate',
      sourceProjectRelativePath: options.sourceProjectRelativePath,
    },
  };
}

export function buildAssetsEditorTab(selectedId?: string): WorkbenchTab {
  return {
    id: 'tab:assets',
    title: 'Assets',
    editorType: 'asset-library',
    resource: {
      kind: 'project',
      stableId: 'assets',
      collection: 'assets',
      entityId: selectedId,
    },
  };
}

export function buildTestsEditorTab(selectedId?: string): WorkbenchTab {
  return {
    id: 'tab:tests',
    title: 'Tests',
    editorType: 'test-suite',
    resource: {
      kind: 'project',
      stableId: 'tests',
      collection: 'tests',
      entityId: selectedId,
    },
  };
}

export function buildVariablesEditorTab(selectedId?: string): WorkbenchTab {
  return {
    id: 'tab:variables',
    title: 'Variables',
    editorType: 'variables',
    resource: {
      kind: 'project',
      stableId: 'variables',
      collection: 'variables',
      entityId: selectedId,
    },
  };
}

export function buildDefaultRecordTab(node: AssetNode): WorkbenchTab | null {
  if (node.collection === 'variables') return buildVariablesEditorTab(node.entityId);
  if (node.collection === 'assets' && !node.entityId) return buildAssetsEditorTab();
  if (node.collection === 'tests' && !node.entityId) return buildTestsEditorTab();
  const title = node.label || node.entityId;
  if (node.collection === 'assets' && node.entityId) return buildAssetDetailTabForRecord(node.entityId, title);
  if (node.collection === 'shaders' && node.entityId) return buildShaderDetailTabForRecord(node.entityId, title);
  if (node.collection === 'materials' && node.entityId) return buildMaterialDetailTabForRecord(node.entityId, title);
  if (node.collection === 'layouts' && node.entityId) return buildLayoutDetailTabForRecord(node.entityId, title);
  if (node.collection === 'characters' && node.entityId) return buildCharacterDetailTabForRecord(node.entityId, title);
  if (node.collection === 'rooms' && node.entityId) return buildRoomDetailTabForRecord(node.entityId, title);
  if (node.collection === 'interactables' && node.entityId) return buildInteractableDetailTabForRecord(node.entityId, title);
  if (node.collection === 'dialogues' && node.entityId) return buildDialogueDetailTabForRecord(node.entityId, title);
  if (node.collection === 'scenes' && node.entityId) return buildSceneDetailTabForRecord(node.entityId, title);
  if (node.collection === 'tests' && node.entityId) return buildTestDetailTabForRecord(node.entityId, title);
  if (node.collection === 'verbs' && node.entityId) return buildVerbDetailTabForRecord(node.entityId, title);
  if (node.collection === 'interactions' && node.entityId) return buildInteractionDetailTabForRecord(node.entityId, title);
  if (node.collection === 'maps' && node.entityId) return buildMapDetailTabForRecord(node.entityId, title);
  if (node.collection === 'scripts' && node.entityId) return buildScriptModuleDetailTabForRecord(node.entityId, title);
  if (node.collection && node.entityId) return buildPlaceholderEntityTabForRecord(node.collection, node.entityId, title);
  return null;
}

export function buildComponentsTab(): WorkbenchTab {
  return {
    id: 'tab:components',
    title: 'Components',
    editorType: 'components',
    resource: {
      kind: 'tool',
      stableId: 'utility:components',
    },
  };
}

export function buildSettingsTab(): WorkbenchTab {
  return {
    id: 'tab:settings',
    title: 'Settings',
    editorType: 'settings',
    resource: {
      kind: 'tool',
      stableId: 'utility:settings',
    },
  };
}

export function buildComfyUiWorkflowsTab(): WorkbenchTab {
  return {
    id: 'tab:comfyui-workflows',
    title: 'ComfyUI Workflows',
    editorType: 'comfyui-workflows',
    resource: {
      kind: 'tool',
      stableId: 'utility:comfyui-workflows',
    },
  };
}

export function buildProjectSettingsTab(): WorkbenchTab {
  return {
    id: 'tab:project-settings',
    title: 'Project Settings',
    editorType: 'project-settings',
    resource: {
      kind: 'project',
      stableId: 'project:settings',
    },
  };
}

export function buildPlatformExportTab(): WorkbenchTab {
  return {
    id: 'tab:platform-export',
    title: 'Export',
    editorType: 'platform-export',
    resource: {
      kind: 'project',
      stableId: 'project:platform-export',
    },
  };
}

export function buildPlatformExportProfilesTab(): WorkbenchTab {
  return {
    id: 'tab:platform-export-profiles',
    title: 'Export Profiles',
    editorType: 'platform-export-profiles',
    resource: {
      kind: 'project',
      stableId: 'project:platform-export-profiles',
    },
  };
}

export function buildProjectChaptersTab(target?: { collection: string; entityId: string; label?: string }): WorkbenchTab {
  const suffix = target ? `:${target.collection}:${target.entityId}` : '';
  return {
    id: target ? `tab:project-chapters${suffix}` : 'tab:project-chapters',
    title: target ? `Chapters: ${target.label ?? target.entityId}` : 'Chapters',
    editorType: 'project-chapters',
    resource: {
      kind: 'project',
      stableId: target ? `project:chapters${suffix}` : 'project:chapters',
      collection: target?.collection,
      entityId: target?.entityId,
    },
  };
}

export function buildProjectTagsTab(): WorkbenchTab {
  return {
    id: 'tab:project-tags',
    title: 'Tags',
    editorType: 'project-tags',
    resource: {
      kind: 'project',
      stableId: 'project:tags',
    },
  };
}

export function buildFullGamePreviewTab(): WorkbenchTab {
  return {
    id: 'tab:full-game-preview',
    title: 'Play',
    editorType: 'full-game-preview',
    preview: true,
    resource: {
      kind: 'preview',
      stableId: 'preview:full-game',
    },
  };
}

export function editorIconClassNameForTab(tab: WorkbenchTab): string {
  return visualForEditorType(tab.editorType, tab.resource?.collection)?.colorClassName ?? '';
}

export function editorIconForType(editorType: string): ComponentType<{ className?: string }> {
  if (editorType === 'full-game-preview') return MonitorPlay;
  if (editorType === 'engine-preview') return MonitorPlay;
  if (editorType === 'image-generation') return Images;
  if (editorType === 'asset-detail' || editorType === 'asset-library') return Image;
  if (editorType === 'shader-detail') return FileCode;
  if (editorType === 'material-detail') return Palette;
  if (editorType === 'layout-detail') return Layers;
  if (editorType === 'character-detail') return User;
  if (editorType === 'room-detail') return DoorOpen;
  if (editorType === 'interactable-detail') return Puzzle;
  if (editorType === 'dialogue-detail') return MessageSquareText;
  if (editorType === 'scene-detail') return Clapperboard;
  if (editorType === 'placeholder-entity') return Puzzle;
  if (editorType === 'test-detail' || editorType === 'test-suite') return ListChecks;
  if (editorType === 'variables') return SlidersHorizontal;
  if (editorType === 'components') return Puzzle;
  if (editorType === 'settings') return Settings;
  if (editorType === 'comfyui-workflows') return Workflow;
  if (editorType === 'project-settings') return Wrench;
  if (editorType === 'platform-export') return MonitorPlay;
  if (editorType === 'platform-export-profiles') return SlidersHorizontal;
  if (editorType === 'project-chapters') return BookOpen;
  if (editorType === 'project-tags') return Tags;
  return FileCode;
}

export function renderEditorToolbar(
  registry: WorkbenchEditorRegistry,
  tab: WorkbenchTab,
): ReactNode {
  const registration = registry.resolve(tab.editorType);
  const Toolbar = registration?.toolbar;
  return Toolbar ? <Toolbar tab={tab} /> : null;
}
