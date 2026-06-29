import type { ComponentType, ReactNode } from 'react';
import { FileJson, MonitorPlay } from 'lucide-react';
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
