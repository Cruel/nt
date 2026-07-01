import type { ComponentType, ReactNode } from 'react';
import { Clapperboard, DoorOpen, FileCode, Image, Layers, ListChecks, MessageSquareText, MonitorPlay, Palette, Puzzle, Settings, SlidersHorizontal, User, Wrench } from 'lucide-react';
import type { AssetNode } from '@/stores/workspace-store';
import type { WorkbenchTab } from './workbench-types';

export interface WorkbenchEditorProps {
  tab: WorkbenchTab;
}

export interface WorkbenchEditorRegistration {
  type: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  component: ComponentType<WorkbenchEditorProps>;
  toolbar?: ComponentType<WorkbenchEditorProps>;
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

export function buildVariablesEditorTab(selectedId?: string): WorkbenchTab {
  return {
    id: 'tab:variables',
    title: 'Variables',
    editorType: 'variables',
    resource: {
      kind: 'tool',
      stableId: selectedId ? `variables:${selectedId}` : 'variables',
      collection: 'variables',
      entityId: selectedId,
    },
  };
}

export function buildDefaultRecordTab(node: AssetNode): WorkbenchTab | null {
  if (node.collection === 'variables') return buildVariablesEditorTab(node.entityId);
  if (node.collection === 'assets' && node.entityId) return buildAssetDetailTabForRecord(node.entityId, node.entityId);
  if (node.collection === 'shaders' && node.entityId) return buildShaderDetailTabForRecord(node.entityId, node.entityId);
  if (node.collection === 'materials' && node.entityId) return buildMaterialDetailTabForRecord(node.entityId, node.entityId);
  if (node.collection === 'layouts' && node.entityId) return buildLayoutDetailTabForRecord(node.entityId, node.entityId);
  if (node.collection === 'characters' && node.entityId) return buildCharacterDetailTabForRecord(node.entityId, node.entityId);
  if (node.collection === 'rooms' && node.entityId) return buildRoomDetailTabForRecord(node.entityId, node.entityId);
  if (node.collection === 'dialogues' && node.entityId) return buildDialogueDetailTabForRecord(node.entityId, node.entityId);
  if (node.collection === 'scenes' && node.entityId) return buildSceneDetailTabForRecord(node.entityId, node.entityId);
  if (node.collection === 'tests' && node.entityId) return buildTestDetailTabForRecord(node.entityId, node.entityId);
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

export function buildProjectSettingsTab(): WorkbenchTab {
  return {
    id: 'tab:project-settings',
    title: 'Project Settings',
    editorType: 'project-settings',
    resource: {
      kind: 'tool',
      stableId: 'utility:project-settings',
    },
  };
}

export function buildPrimaryPreviewTab(): WorkbenchTab {
  return {
    id: 'tab:primary-preview',
    title: 'Preview',
    editorType: 'engine-preview',
    preview: true,
    resource: {
      kind: 'preview',
      stableId: 'preview:primary',
    },
  };
}

export function editorIconForType(editorType: string): ComponentType<{ className?: string }> {
  if (editorType === 'engine-preview') return MonitorPlay;
  if (editorType === 'asset-detail') return Image;
  if (editorType === 'shader-detail') return FileCode;
  if (editorType === 'material-detail') return Palette;
  if (editorType === 'layout-detail') return Layers;
  if (editorType === 'character-detail') return User;
  if (editorType === 'room-detail') return DoorOpen;
  if (editorType === 'dialogue-detail') return MessageSquareText;
  if (editorType === 'scene-detail') return Clapperboard;
  if (editorType === 'test-detail') return ListChecks;
  if (editorType === 'variables') return SlidersHorizontal;
  if (editorType === 'components') return Puzzle;
  if (editorType === 'settings') return Settings;
  if (editorType === 'project-settings') return Wrench;
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
