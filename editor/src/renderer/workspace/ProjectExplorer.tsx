import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box,
  Clapperboard,
  Copy,
  File,
  FileCode,
  FilePlus2,
  FileType,
  FlaskConical,
  Folder,
  Image,
  Layers,
  Map,
  MessageSquare,
  MoreHorizontal,
  Palette,
  Route as RouteIcon,
  ScrollText,
  Search,
  SlidersHorizontal,
  Trash2,
  User,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectItem } from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { deleteEntityRecordPreflight, referenceTargetFromEntity } from '@/project/entity-operations';
import { useEntityUsagesStore } from '@/project/entity-usages-store';
import { buildReferenceIndex, findUsages } from '@/project/reference-index';
import { useWorkspaceStore, type AssetNode } from '@/stores/workspace-store';
import { authoringCollectionMetadata, isAuthoringCollectionKey, type AuthoringCollectionKey } from '../../shared/project-schema/authoring-collections';
import { isAuthoringProject, type AuthoringProject, type AuthoringRecordBase } from '../../shared/project-schema/authoring-project';
import { buildDefaultRecordTab, buildRawJsonTabForRecord, buildVariablesEditorTab } from '@/workbench/editor-registry';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';

type EntityAction = 'create' | 'rename' | 'duplicate' | 'delete' | 'metadata';

interface EntityDialogState {
  action: EntityAction;
  collection: AuthoringCollectionKey;
  entityId?: string;
}

interface ExplorerAlert {
  title: string;
  message: string;
}

const assetIcons: Record<string, typeof File> = {
  room: FileType,
  object: Box,
  verb: RouteIcon,
  action: RouteIcon,
  map: Map,
  dialogue: MessageSquare,
  cutscene: Clapperboard,
  script: ScrollText,
  image: Image,
  asset: Image,
  variable: SlidersHorizontal,
  shader: FileCode,
  material: Palette,
  layout: Layers,
  character: User,
  scene: Clapperboard,
  test: FlaskConical,
  folder: Folder,
};

function getAssetIcon(type: AssetNode['type']) {
  return assetIcons[type] ?? File;
}

function recordForNode(project: AuthoringProject | null, node: AssetNode): AuthoringRecordBase | null {
  if (!project || !node.collection || !node.entityId || !isAuthoringCollectionKey(node.collection)) return null;
  return project[node.collection][node.entityId] ?? null;
}

function defaultDuplicateId(entityId: string) {
  return `${entityId}-copy`;
}

function tagsToText(tags: string[] | undefined) {
  return (tags ?? []).join(', ');
}

function textToTags(value: string) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function ParentSelect({
  project,
  collection,
  entityId,
  value,
  onChange,
}: {
  project: AuthoringProject;
  collection: AuthoringCollectionKey;
  entityId: string;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const options = Object.entries(project[collection]).filter(([id]) => id !== entityId);
  return (
    <Select value={value ?? '__none__'} onValueChange={(next) => onChange(next === '__none__' ? null : String(next))}>
      <SelectItem value="__none__">No parent</SelectItem>
      {options.map(([id, record]) => (
        <SelectItem key={id} value={id}>
          {record.label || id} ({id})
        </SelectItem>
      ))}
    </Select>
  );
}

function EntityOperationDialog({
  state,
  project,
  onClose,
}: {
  state: EntityDialogState | null;
  project: AuthoringProject | null;
  onClose: () => void;
}) {
  const executeCommand = useCommandStore((store) => store.executeCommand);
  const openTab = useWorkbenchStore((store) => store.openTab);
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [color, setColor] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [forceDelete, setForceDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const record = state && project && state.entityId ? project[state.collection][state.entityId] : null;
  const metadata = state ? authoringCollectionMetadata[state.collection] : null;
  const deletePreflight = useMemo(() => {
    if (!state || state.action !== 'delete' || !project || !state.entityId) return null;
    return deleteEntityRecordPreflight(project, { collection: state.collection, id: state.entityId });
  }, [project, state]);

  const resetFromState = useCallback((next: EntityDialogState | null) => {
    setError(null);
    setForceDelete(false);
    if (!next) return;
    const nextRecord = project && next.entityId ? project[next.collection][next.entityId] : null;
    if (next.action === 'create') {
      setId('');
      setLabel('');
      setDescription('');
      setTags('');
      setColor('');
      setParentId(null);
    } else if (next.action === 'duplicate') {
      setId(defaultDuplicateId(next.entityId ?? 'record'));
      setLabel(nextRecord ? `${nextRecord.label} Copy` : 'Copy');
      setDescription('');
      setTags('');
      setColor('');
      setParentId(null);
    } else if (next.action === 'rename') {
      setId(next.entityId ?? '');
      setLabel(nextRecord?.label ?? '');
      setDescription('');
      setTags('');
      setColor('');
      setParentId(null);
    } else if (next.action === 'metadata') {
      setId(next.entityId ?? '');
      setLabel(nextRecord?.label ?? '');
      setDescription(nextRecord?.description ?? '');
      setTags(tagsToText(nextRecord?.tags));
      setColor(nextRecord?.color ?? '');
      setParentId(nextRecord?.parent?.collection === next.collection ? nextRecord.parent.id : null);
    }
  }, [project]);

  useEffect(() => {
    resetFromState(state);
  }, [resetFromState, state]);

  if (!state || !project || !metadata) return null;

  const activeState = state;
  const activeMetadata = metadata;

  function finish(result: ReturnType<typeof executeCommand>, success: () => void) {
    const failure = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    if (!result.ok || failure) {
      setError(failure?.message ?? 'Command failed.');
      return;
    }
    success();
    onClose();
  }

  function submit() {
    if (activeState.action === 'create') {
      finish(
        executeCommand({
          type: 'entity.createRecord',
          label: `Create ${activeMetadata.singularLabel}`,
          payload: { collection: activeState.collection, entityId: id.trim(), label: label.trim() || undefined },
        }),
        () => openTab(buildRawJsonTabForRecord(activeState.collection, id.trim(), id.trim())),
      );
    } else if (activeState.action === 'rename' && activeState.entityId) {
      const toId = id.trim();
      finish(
        executeCommand({
          type: 'entity.renameId',
          label: `Rename ${activeState.collection}/${activeState.entityId}`,
          payload: { collection: activeState.collection, fromId: activeState.entityId, toId, label: label.trim() || undefined },
        }),
        () => openTab(buildRawJsonTabForRecord(activeState.collection, toId, toId)),
      );
    } else if (activeState.action === 'duplicate' && activeState.entityId) {
      const targetId = id.trim();
      finish(
        executeCommand({
          type: 'entity.duplicateRecord',
          label: `Duplicate ${activeState.collection}/${activeState.entityId}`,
          payload: { collection: activeState.collection, sourceId: activeState.entityId, targetId, label: label.trim() || undefined },
        }),
        () => openTab(buildRawJsonTabForRecord(activeState.collection, targetId, targetId)),
      );
    } else if (activeState.action === 'delete' && activeState.entityId) {
      finish(
        executeCommand({
          type: 'entity.deleteRecord',
          label: `Delete ${activeState.collection}/${activeState.entityId}`,
          payload: { collection: activeState.collection, entityId: activeState.entityId, force: forceDelete },
        }),
        () => undefined,
      );
    } else if (activeState.action === 'metadata' && activeState.entityId) {
      const first = executeCommand({
        type: 'entity.updateMetadata',
        label: `Update ${activeState.collection}/${activeState.entityId}`,
        payload: {
          collection: activeState.collection,
          entityId: activeState.entityId,
          label: label.trim(),
          description: description.trim() || undefined,
          tags: textToTags(tags),
          color: color.trim() || null,
        },
      });
      const failure = first.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
      if (!first.ok || failure) {
        setError(failure?.message ?? 'Metadata update failed.');
        return;
      }
      const second = executeCommand({
        type: 'entity.setParent',
        label: `Set parent for ${activeState.collection}/${activeState.entityId}`,
        payload: { collection: activeState.collection, entityId: activeState.entityId, parentId },
      });
      finish(second, () => undefined);
    }
  }

  const title =
    activeState.action === 'create'
      ? `Create ${activeMetadata.singularLabel}`
      : activeState.action === 'rename'
        ? `Rename ${activeState.entityId}`
        : activeState.action === 'duplicate'
          ? `Duplicate ${activeState.entityId}`
          : activeState.action === 'delete'
            ? `Delete ${activeState.entityId}`
            : `Edit ${activeState.entityId}`;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPopup key={`${state.action}:${state.collection}:${state.entityId ?? ''}`}>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {state.action === 'delete'
            ? 'Delete removes only this record. Existing references are not rewritten.'
            : `Edit base authoring metadata for ${metadata.label}.`}
        </DialogDescription>
        <div className="space-y-3">
          {error ? <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</div> : null}
          {state.action === 'delete' ? (
            <div className="space-y-3 text-sm">
              {deletePreflight && deletePreflight.usages.length > 0 ? (
                <div className="rounded border p-2 text-xs">
                  <div className="font-medium">Referenced by {deletePreflight.usages.length} usage{deletePreflight.usages.length === 1 ? '' : 's'}:</div>
                  <div className="mt-2 max-h-32 space-y-1 overflow-auto font-mono text-[10px] text-muted-foreground">
                    {deletePreflight.usages.map((usage, index) => (
                      <div key={`${usage.path}-${index}`}>{usage.kind}: {usage.sourceCollection}/{usage.sourceId} {usage.path}</div>
                    ))}
                  </div>
                  <label className="mt-3 flex items-center gap-2">
                    <input type="checkbox" checked={forceDelete} onChange={(event) => setForceDelete(event.currentTarget.checked)} />
                    Force delete and let validation report missing references
                  </label>
                </div>
              ) : (
                <p className="rounded border p-2 text-xs text-muted-foreground">No references point to this record.</p>
              )}
            </div>
          ) : (
            <>
              {state.action !== 'metadata' ? (
                <div className="space-y-1">
                  <Label htmlFor="entity-id">ID</Label>
                  <Input id="entity-id" value={id} onChange={(event) => setId(event.currentTarget.value)} placeholder="lowercase-kebab-id" />
                </div>
              ) : null}
              <div className="space-y-1">
                <Label htmlFor="entity-label">Label</Label>
                <Input id="entity-label" value={label} onChange={(event) => setLabel(event.currentTarget.value)} />
              </div>
              {state.action === 'metadata' && record ? (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="entity-description">Description</Label>
                    <Input id="entity-description" value={description} onChange={(event) => setDescription(event.currentTarget.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="entity-tags">Tags</Label>
                    <Input id="entity-tags" value={tags} onChange={(event) => setTags(event.currentTarget.value)} placeholder="tag-a, tag-b" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="entity-color">Color</Label>
                    <Input id="entity-color" value={color} onChange={(event) => setColor(event.currentTarget.value)} placeholder="#8b5cf6 or empty" />
                  </div>
                  <div className="space-y-1">
                    <Label>Parent</Label>
                    <ParentSelect project={project} collection={state.collection} entityId={state.entityId!} value={parentId} onChange={setParentId} />
                  </div>
                </>
              ) : null}
            </>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant={state.action === 'delete' ? 'destructive' : 'default'} onClick={submit} disabled={state.action === 'delete' && !!deletePreflight?.usages.length && !forceDelete}>
            {state.action === 'delete' ? 'Delete' : 'Apply'}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function ProjectExplorerItem({
  node,
  project,
  depth = 0,
  openDialog,
  showAlert,
}: {
  node: AssetNode;
  project: AuthoringProject | null;
  depth?: number;
  openDialog: (state: EntityDialogState) => void;
  showAlert: (alert: ExplorerAlert) => void;
}) {
  const selectedId = useWorkspaceStore((state) => state.selectedAssetId);
  const projectFilePath = useProjectStore((state) => state.projectFilePath);
  const setSelectedId = useWorkspaceStore((state) => state.setSelectedAssetId);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const setUsages = useEntityUsagesStore((state) => state.setUsages);
  const setActiveBottomPanel = useBottomPanelStore((state) => state.setActivePanelId);
  const setStatusMessage = useWorkspaceStore((state) => state.setStatusMessage);
  const Icon = getAssetIcon(node.type);
  const selectable = node.type !== 'folder' || node.collection === 'variables' || (node.children?.length ?? 0) === 0;
  const record = recordForNode(project, node);
  const knownCollection = node.collection && isAuthoringCollectionKey(node.collection) ? node.collection : null;

  const openNode = () => {
    if (!selectable) return;
    setSelectedId(node.id);
    const tab = node.collection === 'variables' && !node.entityId ? buildVariablesEditorTab() : buildDefaultRecordTab(node);
    if (tab) openTab(tab);
  };

  async function importAssetsFromFolder() {
    if (!projectFilePath) {
      const message = 'Save the project before importing assets.';
      setStatusMessage(message);
      showAlert({ title: 'Asset import unavailable', message });
      return;
    }
    const result = await window.noveltea.importAssets(projectFilePath, { allowMultiple: true });
    if (!result.success || result.assets.length === 0) {
      const message = result.error ?? result.diagnostics[0]?.message ?? 'Asset import canceled.';
      setStatusMessage(message);
      if (result.error || result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
        showAlert({ title: 'Asset import failed', message });
      }
      return;
    }
    const command = useCommandStore.getState().executeCommand({
      type: 'asset.importFiles',
      label: `Import ${result.assets.length} asset${result.assets.length === 1 ? '' : 's'}`,
      payload: { assets: result.assets },
    });
    const failure = command.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    if (failure) {
      setStatusMessage(failure.message);
      showAlert({ title: 'Asset import failed', message: failure.message });
    } else {
      setStatusMessage(`Imported ${result.assets.length} asset${result.assets.length === 1 ? '' : 's'}`);
    }
  }

  function findNodeUsages() {
    if (!project || !knownCollection || !node.entityId) return;
    const target = referenceTargetFromEntity({ collection: knownCollection, entityId: node.entityId });
    setUsages(target, findUsages(buildReferenceIndex(project), target));
    setActiveBottomPanel('references');
  }

  return (
    <div>
      <div className="group flex items-center gap-1 rounded-sm transition-colors hover:bg-accent">
        <button
          type="button"
          onClick={openNode}
          className={`flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-sm ${
            selectedId === node.id ? 'text-accent-foreground' : ''
          }`}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
        >
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {record?.color ? <span className="h-2 w-2 shrink-0 rounded-full border" style={{ backgroundColor: record.color }} /> : null}
          <span className="truncate">{node.label}</span>
          {record?.tags?.length ? <Badge variant="outline" className="ml-1 h-4 px-1 text-[9px]">{record.tags.length}</Badge> : null}
          {node.type === 'folder' ? (
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">{node.children?.length ?? 0}</span>
          ) : null}
        </button>
        {knownCollection ? (
          <Menu>
            <MenuTrigger className="mr-1 inline-flex h-6 w-6 items-center justify-center rounded-md opacity-0 transition-colors hover:bg-accent group-hover:opacity-100">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </MenuTrigger>
            <MenuPopup>
              {node.type === 'folder' ? (
                <>
                  {knownCollection === 'assets' ? (
                    <MenuItem onClick={() => void importAssetsFromFolder()}>
                      <FilePlus2 /> Import Assets
                    </MenuItem>
                  ) : null}
                  <MenuItem onClick={() => openDialog({ action: 'create', collection: knownCollection })}>
                    <FilePlus2 /> Create {authoringCollectionMetadata[knownCollection].singularLabel}
                  </MenuItem>
                </>
              ) : (
                <>
                  <MenuItem onClick={openNode}><File /> Open</MenuItem>
                  {knownCollection === 'assets' && node.entityId ? (
                    <MenuItem onClick={() => openTab(buildRawJsonTabForRecord('assets', node.entityId!, node.entityId!))}><FileCode /> Open Raw JSON</MenuItem>
                  ) : null}
                  {knownCollection === 'variables' && node.entityId ? (
                    <MenuItem onClick={() => openTab(buildRawJsonTabForRecord('variables', node.entityId!, node.entityId!))}><FileCode /> Open Raw JSON</MenuItem>
                  ) : null}
                  <MenuItem onClick={() => openDialog({ action: 'metadata', collection: knownCollection, entityId: node.entityId })}><Palette /> Edit Metadata</MenuItem>
                  <MenuItem onClick={() => openDialog({ action: 'rename', collection: knownCollection, entityId: node.entityId })}><FileCode /> Rename ID</MenuItem>
                  <MenuItem onClick={() => openDialog({ action: 'duplicate', collection: knownCollection, entityId: node.entityId })}><Copy /> Duplicate</MenuItem>
                  <MenuItem onClick={findNodeUsages}><Search /> Find Usages</MenuItem>
                  <MenuSeparator />
                  <MenuItem onClick={() => openDialog({ action: 'delete', collection: knownCollection, entityId: node.entityId })} className="text-destructive"><Trash2 /> Delete</MenuItem>
                </>
              )}
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
      {node.children?.map((child) => (
        <ProjectExplorerItem key={child.id} node={child} project={project} depth={depth + 1} openDialog={openDialog} showAlert={showAlert} />
      ))}
    </div>
  );
}

export function ProjectExplorer({ nodes }: { nodes: AssetNode[] }) {
  const projectDocument = useProjectStore((state) => state.document);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const [dialogState, setDialogState] = useState<EntityDialogState | null>(null);
  const [alert, setAlert] = useState<ExplorerAlert | null>(null);

  if (nodes.length === 0) {
    return <div className="p-3 text-xs text-muted-foreground">No authoring project loaded.</div>;
  }
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => (
        <ProjectExplorerItem key={node.id} node={node} project={project} openDialog={(state) => setDialogState(state)} showAlert={setAlert} />
      ))}
      <EntityOperationDialog state={dialogState} project={project} onClose={() => setDialogState(null)} />
      <Dialog open={alert !== null} onOpenChange={(open) => { if (!open) setAlert(null); }}>
        <DialogPopup>
          <DialogTitle>{alert?.title ?? 'Project explorer warning'}</DialogTitle>
          <DialogDescription>{alert?.message}</DialogDescription>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setAlert(null)}>OK</Button>
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
