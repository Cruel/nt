import type { ComponentType, ReactNode } from 'react';
import { FileCode, FileJson, Image, MonitorPlay, Palette, SlidersHorizontal } from 'lucide-react';
import type { AssetNode } from '@/stores/workspace-store';
import type { WorkbenchResource, WorkbenchTab } from './workbench-types';

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

export function buildRawJsonResource(node: AssetNode): WorkbenchResource | null {
  if (!node.collection || !node.entityId) return null;
  return {
    kind: node.type === 'test' ? 'raw' : 'record',
    stableId: `record:${node.collection}:${node.entityId}`,
    collection: node.collection,
    entityId: node.entityId,
    testId: node.type === 'test' ? node.entityId : undefined,
  };
}

export function buildRawJsonTabForRecord(collection: string, entityId: string, title = entityId): WorkbenchTab {
  return {
    id: `tab:raw-json:record:${collection}:${entityId}`,
    title,
    editorType: 'raw-json',
    resource: {
      kind: 'record',
      stableId: `record:${collection}:${entityId}`,
      collection,
      entityId,
    },
  };
}

export function buildRawJsonTab(node: AssetNode): WorkbenchTab | null {
  const resource = buildRawJsonResource(node);
  if (!resource) return null;
  return buildRawJsonTabForRecord(resource.collection!, resource.entityId!, node.entityId ?? node.label);
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
  return buildRawJsonTab(node);
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
  if (editorType === 'variables') return SlidersHorizontal;
  if (editorType === 'raw-json') return FileJson;
  return FileJson;
}

export function renderEditorToolbar(
  registry: WorkbenchEditorRegistry,
  tab: WorkbenchTab,
): ReactNode {
  const registration = registry.resolve(tab.editorType);
  const Toolbar = registration?.toolbar;
  return Toolbar ? <Toolbar tab={tab} /> : null;
}
