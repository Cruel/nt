import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  File,
  FileCode,
  FilePlus2,
  FolderOpen,
  MoreHorizontal,
  Palette,
  Plus,
  Search,
  Settings,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  DropdownMenuCheckboxItem,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectItem } from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { deleteEntityRecordPreflight, referenceTargetFromEntity } from '@/project/entity-operations';
import { useEntityUsagesStore } from '@/project/entity-usages-store';
import { buildReferenceIndex, findUsages } from '@/project/reference-index';
import { useWorkspaceStore, type AssetNode } from '@/stores/workspace-store';
import { authoringCollectionMetadata, type AuthoringCollectionKey } from '../../shared/project-schema/authoring-collections';
import { isAuthoringProject, type AuthoringProject, type AuthoringRecordBase } from '../../shared/project-schema/authoring-project';
import { editorProjectStateFromProject } from '@/workbench/project-editor-state';
import {
  buildAssetsEditorTab,
  buildDefaultRecordTab,
  buildProjectSettingsTab,
  buildTestsEditorTab,
  buildVariablesEditorTab,
} from '@/workbench/editor-registry';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { dispatchWorkspaceToolbarCommand } from './workspace-toolbar-events';
import { visualForCollection, chapterVisual, hiddenVisual } from './collection-visuals';
import { buildProjectExplorerTree, collectiveCollectionSet, findProjectExplorerPlacementForTab, type ProjectExplorerNode } from './project-explorer-tree';
import { recordTargetKey, useProjectExplorerStore } from './project-explorer-store';
import type { WorkbenchTab } from '@/workbench/workbench-types';

type EntityAction = 'create' | 'rename' | 'duplicate' | 'delete' | 'metadata';
type ChapterAction = 'manage' | 'assign';

interface EntityDialogState {
  action: EntityAction;
  collection: AuthoringCollectionKey;
  entityId?: string;
}

interface ChapterDialogState {
  action: ChapterAction;
  collection?: AuthoringCollectionKey;
  entityId?: string;
}

interface ExplorerAlert {
  title: string;
  message: string;
}

interface ContextMenuState {
  node: ProjectExplorerNode;
  x: number;
  y: number;
}

function recordForNode(project: AuthoringProject | null, node: ProjectExplorerNode): AuthoringRecordBase | null {
  if (!project || !node.collection || !node.entityId) return null;
  return project[node.collection][node.entityId] ?? null;
}

function defaultDuplicateId(entityId: string) {
  return `${entityId}-copy`;
}

function withExplorerPlacement(tab: WorkbenchTab, explorerNodeId: string): WorkbenchTab {
  return {
    ...tab,
    resource: tab.resource ? { ...tab.resource, explorerNodeId } : { kind: 'project', stableId: tab.id, explorerNodeId },
  };
}

function tagsToText(tags: string[] | undefined) {
  return (tags ?? []).join(', ');
}

function textToTags(value: string) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
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
        <SelectItem key={id} value={id}>{record.label || id} ({id})</SelectItem>
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

  useEffect(() => {
    setError(null);
    setForceDelete(false);
    if (!state) return;
    const record = project && state.entityId ? project[state.collection][state.entityId] : null;
    if (state.action === 'create') {
      setId(''); setLabel(''); setDescription(''); setTags(''); setColor(''); setParentId(null);
    } else if (state.action === 'duplicate') {
      setId(defaultDuplicateId(state.entityId ?? 'record'));
      setLabel(record ? `${record.label} Copy` : 'Copy');
      setDescription(''); setTags(''); setColor(''); setParentId(null);
    } else if (state.action === 'rename') {
      setId(state.entityId ?? ''); setLabel(record?.label ?? ''); setDescription(''); setTags(''); setColor(''); setParentId(null);
    } else if (state.action === 'metadata') {
      setId(state.entityId ?? ''); setLabel(record?.label ?? ''); setDescription(record?.description ?? ''); setTags(tagsToText(record?.tags)); setColor(record?.color ?? '');
      setParentId(record?.parent?.collection === state.collection ? record.parent.id : null);
    }
  }, [project, state]);

  if (!state || !project) return null;
  const activeState = state;
  const metadata = authoringCollectionMetadata[activeState.collection];
  const record = activeState.entityId ? project[activeState.collection][activeState.entityId] : null;
  const deletePreflight = activeState.action === 'delete' && activeState.entityId ? deleteEntityRecordPreflight(project, { collection: activeState.collection, id: activeState.entityId }) : null;

  function finish(result: ReturnType<typeof executeCommand>, success: () => void) {
    const failure = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    if (!result.ok || failure) {
      setError(failure?.message ?? 'Command failed.');
      return;
    }
    success();
    onClose();
  }

  function tabFor(collection: AuthoringCollectionKey, entityId: string, title: string) {
    return buildDefaultRecordTab({ id: `${collection}:${entityId}`, label: title, type: authoringCollectionMetadata[collection].nodeType, collection, entityId });
  }

  function submit() {
    const state = activeState;
    if (state.action === 'create') {
      const entityId = id.trim();
      finish(executeCommand({ type: 'entity.createRecord', label: `Create ${metadata.singularLabel}`, payload: { collection: state.collection, entityId, label: label.trim() || undefined } }), () => {
        const tab = tabFor(state.collection, entityId, label.trim() || entityId);
        if (tab) openTab(tab);
      });
    } else if (state.action === 'rename' && state.entityId) {
      const toId = id.trim();
      finish(executeCommand({ type: 'entity.renameId', label: `Rename ${state.collection}/${state.entityId}`, payload: { collection: state.collection, fromId: state.entityId, toId, label: label.trim() || undefined } }), () => {
        const tab = tabFor(state.collection, toId, label.trim() || toId);
        if (tab) openTab(tab);
      });
    } else if (state.action === 'duplicate' && state.entityId) {
      const targetId = id.trim();
      finish(executeCommand({ type: 'entity.duplicateRecord', label: `Duplicate ${state.collection}/${state.entityId}`, payload: { collection: state.collection, sourceId: state.entityId, targetId, label: label.trim() || undefined } }), () => {
        const tab = tabFor(state.collection, targetId, label.trim() || targetId);
        if (tab) openTab(tab);
      });
    } else if (state.action === 'delete' && state.entityId) {
      finish(executeCommand({ type: 'entity.deleteRecord', label: `Delete ${state.collection}/${state.entityId}`, payload: { collection: state.collection, entityId: state.entityId, force: forceDelete } }), () => undefined);
    } else if (state.action === 'metadata' && state.entityId) {
      const first = executeCommand({ type: 'entity.updateMetadata', label: `Update ${state.collection}/${state.entityId}`, payload: { collection: state.collection, entityId: state.entityId, label: label.trim(), description: description.trim() || undefined, tags: textToTags(tags), color: color.trim() || null } });
      const failure = first.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
      if (!first.ok || failure) { setError(failure?.message ?? 'Metadata update failed.'); return; }
      finish(executeCommand({ type: 'entity.setParent', label: `Set parent for ${state.collection}/${state.entityId}`, payload: { collection: state.collection, entityId: state.entityId, parentId } }), () => undefined);
    }
  }

  const title = state.action === 'create'
    ? `Create ${metadata.singularLabel}`
    : state.action === 'rename'
      ? `Rename ${state.entityId}`
      : state.action === 'duplicate'
        ? `Duplicate ${state.entityId}`
        : state.action === 'delete'
          ? `Delete ${state.entityId}`
          : `Edit ${state.entityId}`;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPopup key={`${state.action}:${state.collection}:${state.entityId ?? ''}`}>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{state.action === 'delete' ? 'Delete removes only this record. Existing references are not rewritten.' : `Edit base authoring metadata for ${metadata.label}.`}</DialogDescription>
        <div className="space-y-3">
          {error ? <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</div> : null}
          {state.action === 'delete' ? (
            <div className="space-y-3 text-sm">
              {deletePreflight && deletePreflight.usages.length > 0 ? (
                <div className="rounded border p-2 text-xs">
                  <div className="font-medium">Referenced by {deletePreflight.usages.length} usage{deletePreflight.usages.length === 1 ? '' : 's'}:</div>
                  <div className="mt-2 max-h-32 space-y-1 overflow-auto font-mono text-[10px] text-muted-foreground">
                    {deletePreflight.usages.map((usage, index) => <div key={`${usage.path}-${index}`}>{usage.kind}: {usage.sourceCollection}/{usage.sourceId} {usage.path}</div>)}
                  </div>
                  <label className="mt-3 flex items-center gap-2"><input type="checkbox" checked={forceDelete} onChange={(event) => setForceDelete(event.currentTarget.checked)} />Force delete and let validation report missing references</label>
                </div>
              ) : <p className="rounded border p-2 text-xs text-muted-foreground">No references point to this record.</p>}
            </div>
          ) : (
            <>
              {state.action !== 'metadata' ? <div className="space-y-1"><Label htmlFor="entity-id">ID</Label><Input id="entity-id" value={id} onChange={(event) => setId(event.currentTarget.value)} placeholder="lowercase-kebab-id" /></div> : null}
              <div className="space-y-1"><Label htmlFor="entity-label">Label</Label><Input id="entity-label" value={label} onChange={(event) => setLabel(event.currentTarget.value)} /></div>
              {state.action === 'metadata' && record ? (
                <>
                  <div className="space-y-1"><Label htmlFor="entity-description">Description</Label><Input id="entity-description" value={description} onChange={(event) => setDescription(event.currentTarget.value)} /></div>
                  <div className="space-y-1"><Label htmlFor="entity-tags">Tags</Label><Input id="entity-tags" value={tags} onChange={(event) => setTags(event.currentTarget.value)} placeholder="tag-a, tag-b" /></div>
                  <div className="space-y-1"><Label htmlFor="entity-color">Color</Label><Input id="entity-color" value={color} onChange={(event) => setColor(event.currentTarget.value)} placeholder="#8b5cf6 or empty" /></div>
                  <div className="space-y-1"><Label>Parent</Label><ParentSelect project={project} collection={state.collection} entityId={state.entityId!} value={parentId} onChange={setParentId} /></div>
                </>
              ) : null}
            </>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant={state.action === 'delete' ? 'destructive' : 'default'} onClick={submit} disabled={state.action === 'delete' && !!deletePreflight?.usages.length && !forceDelete}>{state.action === 'delete' ? 'Delete' : 'Apply'}</Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function ChapterDialog({ state, project, onClose }: { state: ChapterDialogState | null; project: AuthoringProject | null; onClose: () => void }) {
  const executeCommand = useCommandStore((store) => store.executeCommand);
  const [chapterId, setChapterId] = useState('');
  const [label, setLabel] = useState('');
  const [color, setColor] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const chapters = project ? editorProjectStateFromProject(project).chapters : { records: {}, assignments: {} };
  const chapterEntries = Object.entries(chapters.records).sort(([, left], [, right]) => (left.label || left.id).localeCompare(right.label || right.id));

  useEffect(() => {
    setMessage(null);
    if (!state) return;
    setChapterId(''); setLabel(''); setColor('');
    if (state.action === 'assign' && state.collection && state.entityId) {
      setSelected(new Set(chapters.assignments[recordTargetKey(state.collection, state.entityId)] ?? []));
    } else setSelected(new Set());
  }, [chapters.assignments, state]);

  if (!state || !project) return null;
  const activeState = state;

  function run(command: Parameters<typeof executeCommand>[0]) {
    const result = executeCommand(command);
    const failure = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    setMessage(failure?.message ?? null);
    return result.ok && !failure;
  }

  function createChapter() {
    if (run({ type: 'project.createChapter', label: 'Create chapter', payload: { chapterId: chapterId.trim(), label: label.trim(), color: color.trim() || null } })) {
      setChapterId(''); setLabel(''); setColor('');
    }
  }

  function deleteChapter(id: string) {
    run({ type: 'project.deleteChapter', label: `Delete chapter ${id}`, payload: { chapterId: id } });
  }

  function renameChapter(id: string, nextLabel: string) {
    run({ type: 'project.renameChapter', label: `Rename chapter ${id}`, payload: { chapterId: id, label: nextLabel } });
  }

  function setChapterColor(id: string, nextColor: string) {
    run({ type: 'project.setChapterColor', label: `Set chapter color ${id}`, payload: { chapterId: id, color: nextColor.trim() || null } });
  }

  function applyAssignment() {
    if (!activeState.collection || !activeState.entityId) return;
    if (run({ type: 'project.assignChapters', label: `Assign chapters to ${activeState.collection}/${activeState.entityId}`, payload: { collection: activeState.collection, entityId: activeState.entityId, chapterIds: [...selected] } })) onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPopup className="max-w-xl">
        <DialogTitle>{state.action === 'assign' ? 'Assign Chapters' : 'Manage Chapters'}</DialogTitle>
        <DialogDescription>{state.action === 'assign' ? 'Choose every chapter this record belongs to.' : 'Create, rename, color, and delete editor-only chapters.'}</DialogDescription>
        {message ? <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{message}</div> : null}
        {state.action === 'assign' ? (
          <div className="max-h-72 space-y-2 overflow-auto">
            {chapterEntries.length === 0 ? <p className="text-sm text-muted-foreground">No chapters exist yet.</p> : chapterEntries.map(([id, chapter]) => (
              <label key={id} className="flex items-center gap-2 rounded border p-2 text-sm">
                <input type="checkbox" checked={selected.has(id)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.currentTarget.checked) next.add(id); else next.delete(id); return next; })} />
                <span className="h-2.5 w-2.5 rounded-full border" style={{ backgroundColor: chapter.color ?? 'transparent' }} />
                <span>{chapter.label}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{id}</span>
              </label>
            ))}
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={applyAssignment}>Apply</Button></div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-2 md:grid-cols-[1fr_1fr_96px_auto]">
              <Input value={chapterId} onChange={(event) => setChapterId(event.currentTarget.value)} placeholder="chapter-id" />
              <Input value={label} onChange={(event) => setLabel(event.currentTarget.value)} placeholder="Chapter label" />
              <Input value={color} onChange={(event) => setColor(event.currentTarget.value)} placeholder="#8b5cf6" />
              <Button size="sm" onClick={createChapter}><Plus className="h-3.5 w-3.5" /> Create</Button>
            </div>
            <div className="max-h-72 space-y-2 overflow-auto">
              {chapterEntries.length === 0 ? <p className="text-sm text-muted-foreground">No chapters exist yet.</p> : chapterEntries.map(([id, chapter]) => (
                <div key={id} className="grid items-center gap-2 rounded border p-2 md:grid-cols-[1fr_96px_auto]">
                  <Input defaultValue={chapter.label} onBlur={(event) => renameChapter(id, event.currentTarget.value)} />
                  <Input defaultValue={chapter.color ?? ''} onBlur={(event) => setChapterColor(id, event.currentTarget.value)} />
                  <Button size="sm" variant="destructive" onClick={() => deleteChapter(id)}><Trash2 className="h-3.5 w-3.5" /> Delete</Button>
                </div>
              ))}
            </div>
            <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
          </div>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function ProjectHeading({ projectName, onManageChapters }: { projectName: string; onManageChapters: () => void }) {
  const openTab = useWorkbenchStore((state) => state.openTab);
  const followActiveTab = useProjectExplorerStore((state) => state.followActiveTab);
  const organizeByChapter = useProjectExplorerStore((state) => state.organizeByChapter);
  const groupUnassignedItems = useProjectExplorerStore((state) => state.groupUnassignedItems);
  const setFollowActiveTab = useProjectExplorerStore((state) => state.setFollowActiveTab);
  const setOrganizeByChapter = useProjectExplorerStore((state) => state.setOrganizeByChapter);
  const setGroupUnassignedItems = useProjectExplorerStore((state) => state.setGroupUnassignedItems);
  const executeCommand = useCommandStore((state) => state.executeCommand);

  function setOption(payload: { followActiveTab?: boolean; organizeByChapter?: boolean; groupUnassignedItems?: boolean }) {
    executeCommand({ type: 'project.setExplorerOptions', label: 'Update explorer options', payload });
    if (payload.followActiveTab !== undefined) setFollowActiveTab(payload.followActiveTab);
    if (payload.organizeByChapter !== undefined) setOrganizeByChapter(payload.organizeByChapter);
    if (payload.groupUnassignedItems !== undefined) setGroupUnassignedItems(payload.groupUnassignedItems);
  }

  return (
    <div className="flex items-center gap-2 border-b px-2 py-2">
      <div className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground" title={projectName}>{projectName}</div>
      <Menu>
        <MenuTrigger className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-accent" aria-label="Project explorer menu"><MoreHorizontal className="h-3.5 w-3.5" /></MenuTrigger>
        <MenuPopup className="w-auto min-w-56">
          <MenuItem className="whitespace-nowrap" onClick={() => openTab(buildProjectSettingsTab())}><Settings /> Project Settings…</MenuItem>
          <MenuItem className="whitespace-nowrap" onClick={onManageChapters}><FolderOpen /> Manage Chapters…</MenuItem>
          <MenuSeparator />
          <DropdownMenuCheckboxItem className="whitespace-nowrap" checked={followActiveTab} onCheckedChange={(checked) => setOption({ followActiveTab: Boolean(checked) })}>Follow Active Tab</DropdownMenuCheckboxItem>
          <MenuSeparator />
          <DropdownMenuCheckboxItem className="whitespace-nowrap" checked={organizeByChapter} onCheckedChange={(checked) => setOption({ organizeByChapter: Boolean(checked) })}>Organize by Chapter</DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem className="whitespace-nowrap" checked={groupUnassignedItems} disabled={!organizeByChapter} onCheckedChange={(checked) => setOption({ groupUnassignedItems: Boolean(checked) })}>Group Unassigned Items</DropdownMenuCheckboxItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

function ExplorerContextMenu({
  state,
  project,
  onClose,
  openDialog,
  openChapterDialog,
  showAlert,
}: {
  state: ContextMenuState | null;
  project: AuthoringProject | null;
  onClose: () => void;
  openDialog: (state: EntityDialogState) => void;
  openChapterDialog: (state: ChapterDialogState) => void;
  showAlert: (alert: ExplorerAlert) => void;
}) {
  const openTab = useWorkbenchStore((store) => store.openTab);
  const setUsages = useEntityUsagesStore((store) => store.setUsages);
  const setActiveBottomPanel = useBottomPanelStore((store) => store.setActivePanelId);
  const setStatusMessage = useWorkspaceStore((store) => store.setStatusMessage);
  const setActiveNodeId = useProjectExplorerStore((store) => store.setActiveNodeId);
  const projectFilePath = useProjectStore((store) => store.projectFilePath);
  const executeCommand = useCommandStore((store) => store.executeCommand);
  const setHiddenCollectionKeys = useProjectExplorerStore((store) => store.setHiddenCollectionKeys);
  const hiddenCollectionKeys = useProjectExplorerStore((store) => store.hiddenCollectionKeys);
  const chapters = useProjectExplorerStore((store) => store.chapters);

  useEffect(() => {
    if (!state) return;
    const close = () => onClose();
    window.addEventListener('click', close);
    window.addEventListener('keydown', close);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', close); };
  }, [onClose, state]);

  if (!state || !project || !state.node.collection) return null;
  const activeProject = project;
  const node = state.node;
  const collection = node.collection as AuthoringCollectionKey;
  const isHidden = hiddenCollectionKeys.includes(collection);
  const collective = node.kind === 'collective-collection';
  const assignDisabled = Object.keys(chapters.records).length === 0 || collectiveCollectionSet.has(collection) || !node.entityId;

  function run(command: Parameters<typeof executeCommand>[0]) {
    const result = executeCommand(command);
    const failure = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    if (failure) setStatusMessage(failure.message);
    return result.ok && !failure;
  }

  function hideCollection(nextHidden: boolean) {
    const keys = nextHidden ? [...hiddenCollectionKeys, collection] : hiddenCollectionKeys.filter((key) => key !== collection);
    if (run({ type: 'project.setHiddenCollections', label: 'Update hidden categories', payload: { hiddenCollectionKeys: keys } })) setHiddenCollectionKeys(keys);
  }

  function openNode() {
    if (collective) {
      setActiveNodeId(node.id);
      if (collection === 'assets') openTab(withExplorerPlacement(buildAssetsEditorTab(), node.id));
      else if (collection === 'tests') openTab(withExplorerPlacement(buildTestsEditorTab(), node.id));
      else if (collection === 'variables') openTab(withExplorerPlacement(buildVariablesEditorTab(), node.id));
      return;
    }
    if (!node.entityId) return;
    setActiveNodeId(node.id);
    const tab = buildDefaultRecordTab({ id: `${collection}:${node.entityId}`, label: node.label, type: authoringCollectionMetadata[collection].nodeType, collection, entityId: node.entityId });
    if (tab) openTab(withExplorerPlacement(tab, node.id));
  }

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
      if (result.error || result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) showAlert({ title: 'Asset import failed', message });
      return;
    }
    run({ type: 'asset.importFiles', label: `Import ${result.assets.length} asset${result.assets.length === 1 ? '' : 's'}`, payload: { assets: result.assets } });
  }

  function findNodeUsages() {
    if (!node.entityId) return;
    const target = referenceTargetFromEntity({ collection, entityId: node.entityId });
    setUsages(target, findUsages(buildReferenceIndex(activeProject), target));
    setActiveBottomPanel('references');
  }

  const itemClass = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent';
  return (
    <div className="fixed z-50 min-w-44 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg" style={{ left: state.x, top: state.y }} onClick={(event) => event.stopPropagation()}>
      {node.kind === 'record' ? (
        <>
          <button className={itemClass} onClick={() => { openNode(); onClose(); }}><File className="h-3.5 w-3.5" /> Open</button>
          <button className={itemClass} onClick={() => { if (node.entityId) openDialog({ action: 'metadata', collection, entityId: node.entityId }); onClose(); }}><Palette className="h-3.5 w-3.5" /> Edit Metadata</button>
          <button className={itemClass} onClick={() => { if (node.entityId) openDialog({ action: 'rename', collection, entityId: node.entityId }); onClose(); }}><FileCode className="h-3.5 w-3.5" /> Rename ID</button>
          <button className={itemClass} onClick={() => { if (node.entityId) openDialog({ action: 'duplicate', collection, entityId: node.entityId }); onClose(); }}><Copy className="h-3.5 w-3.5" /> Duplicate</button>
          <button className={itemClass} disabled={assignDisabled} onClick={() => { if (node.entityId) openChapterDialog({ action: 'assign', collection, entityId: node.entityId }); onClose(); }}><FolderOpen className="h-3.5 w-3.5" /> Assign Chapters…</button>
          <button className={itemClass} onClick={() => { findNodeUsages(); onClose(); }}><Search className="h-3.5 w-3.5" /> Find Usages</button>
          <div className="my-1 h-px bg-border" />
          <button className={`${itemClass} text-destructive`} onClick={() => { if (node.entityId) openDialog({ action: 'delete', collection, entityId: node.entityId }); onClose(); }}><Trash2 className="h-3.5 w-3.5" /> Delete</button>
        </>
      ) : node.kind === 'chapter-folder' && node.chapterId ? (
        <>
          <button className={itemClass} onClick={() => { openChapterDialog({ action: 'manage' }); onClose(); }}><FolderOpen className="h-3.5 w-3.5" /> Manage Chapters…</button>
        </>
      ) : (
        <>
          {collective ? <button className={itemClass} onClick={() => { openNode(); onClose(); }}><File className="h-3.5 w-3.5" /> Open</button> : null}
          {collection === 'assets' ? <button className={itemClass} onClick={() => { void importAssetsFromFolder(); onClose(); }}><FilePlus2 className="h-3.5 w-3.5" /> Import Assets</button> : null}
          {!collective ? <button className={itemClass} onClick={() => { openDialog({ action: 'create', collection }); onClose(); }}><FilePlus2 className="h-3.5 w-3.5" /> Create {authoringCollectionMetadata[collection].singularLabel}</button> : null}
          <div className="my-1 h-px bg-border" />
          <button className={itemClass} onClick={() => { hideCollection(!isHidden); onClose(); }}>{isHidden ? 'Unhide Category' : 'Hide Category'}</button>
        </>
      )}
    </div>
  );
}

function ProjectExplorerItem({ node, project, depth = 0, onContextMenu }: { node: ProjectExplorerNode; project: AuthoringProject | null; depth?: number; onContextMenu: (state: ContextMenuState) => void }) {
  const selectedId = useWorkspaceStore((state) => state.selectedAssetId);
  const setSelectedId = useWorkspaceStore((state) => state.setSelectedAssetId);
  const expandedNodeIds = useProjectExplorerStore((state) => state.expandedNodeIds);
  const followExpandedNodeIds = useProjectExplorerStore((state) => state.followExpandedNodeIds);
  const activeNodeId = useProjectExplorerStore((state) => state.activeNodeId);
  const setActiveNodeId = useProjectExplorerStore((state) => state.setActiveNodeId);
  const toggleExpanded = useProjectExplorerStore((state) => state.toggleExpanded);
  const suppressFollowNodeId = useProjectExplorerStore((state) => state.suppressFollowNodeId);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const manuallyExpanded = expandedNodeIds.includes(node.id);
  const followExpanded = followExpandedNodeIds.includes(node.id);
  const expanded = manuallyExpanded || followExpanded;
  const collection = node.collection;
  const visual = collection ? visualForCollection(collection) : node.kind === 'hidden-root' ? hiddenVisual : chapterVisual;
  const Icon = node.kind === 'chapter-folder' || node.kind === 'all-folder' || node.kind === 'unassigned-folder' ? chapterVisual.icon : visual.icon;
  const record = recordForNode(project, node);
  const canExpand = node.expandable && (node.children?.length ?? 0) > 0;
  const openable = node.kind === 'record' || node.kind === 'collective-collection';
  const inert = !openable && !canExpand;
  const clickSelectionId = node.entityId && node.collection ? `${node.collection}:${node.entityId}` : node.id;
  const selected = activeNodeId ? activeNodeId === node.id : selectedId === clickSelectionId;
  const dimClass = node.dimmed ? 'opacity-55' : '';
  const inertClass = inert && !node.dimmed ? 'text-muted-foreground/80 hover:text-muted-foreground' : '';
  const cursorClass = openable || canExpand ? 'cursor-pointer' : 'cursor-default';

  function openNode() {
    if (node.kind === 'hidden-root' || node.kind === 'collection' || node.kind === 'chapter-folder' || node.kind === 'all-folder' || node.kind === 'unassigned-folder') {
      if (canExpand) {
        if (expanded) suppressFollowNodeId(node.id);
        if (!followExpanded || manuallyExpanded) toggleExpanded(node.id);
      }
      return;
    }
    if (node.kind === 'collective-collection' && node.collection) {
      setSelectedId(node.id);
      setActiveNodeId(node.id);
      if (node.collection === 'assets') openTab(withExplorerPlacement(buildAssetsEditorTab(), node.id));
      else if (node.collection === 'tests') openTab(withExplorerPlacement(buildTestsEditorTab(), node.id));
      else if (node.collection === 'variables') openTab(withExplorerPlacement(buildVariablesEditorTab(), node.id));
      return;
    }
    if (node.kind === 'record' && node.collection && node.entityId) {
      const targetId = `${node.collection}:${node.entityId}`;
      setSelectedId(targetId);
      setActiveNodeId(node.id);
      const tab = buildDefaultRecordTab({ id: targetId, label: node.label, type: authoringCollectionMetadata[node.collection].nodeType, collection: node.collection, entityId: node.entityId });
      if (tab) openTab(withExplorerPlacement(tab, node.id));
    }
  }

  return (
    <div>
      <button
        type="button"
        data-explorer-node-id={node.id}
        className={`group flex w-full min-w-0 items-center gap-1 rounded-sm px-2 py-1 text-left text-sm transition-colors hover:bg-accent ${cursorClass} ${selected ? 'bg-accent text-accent-foreground' : ''} ${inertClass} ${dimClass}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={openNode}
        onContextMenu={(event) => { event.preventDefault(); onContextMenu({ node, x: event.clientX, y: event.clientY }); }}
      >
        {canExpand ? expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <span className="w-3.5 shrink-0" />}
        <Icon className={`h-3.5 w-3.5 shrink-0 ${node.kind === 'chapter-folder' && node.chapterId ? chapterVisual.colorClassName : visual.colorClassName}`} />
        {node.kind === 'chapter-folder' && node.chapterId ? <span className="h-2 w-2 shrink-0 rounded-full border" style={{ backgroundColor: editorProjectStateFromProject(project).chapters.records[node.chapterId]?.color ?? 'transparent' }} /> : null}
        {record?.color ? <span className="h-2 w-2 shrink-0 rounded-full border" style={{ backgroundColor: record.color }} /> : null}
        <span className="truncate">{node.label}</span>
        {record?.tags?.length ? <Badge variant="outline" className="ml-1 h-4 px-1 text-[9px]">{record.tags.length}</Badge> : null}
        {node.count !== undefined ? <span className={`ml-auto font-mono text-[10px] ${inert && !node.dimmed ? 'text-muted-foreground/70' : 'text-muted-foreground'}`}>{node.count}</span> : null}
      </button>
      {canExpand && expanded ? node.children?.map((child) => <ProjectExplorerItem key={child.id} node={child} project={project} depth={depth + 1} onContextMenu={onContextMenu} />) : null}
    </div>
  );
}

export function ProjectExplorer(_props: { nodes: AssetNode[] }) {
  const projectDocument = useProjectStore((state) => state.document);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const expandedNodeIds = useProjectExplorerStore((state) => state.expandedNodeIds);
  const hiddenCollectionKeys = useProjectExplorerStore((state) => state.hiddenCollectionKeys);
  const followActiveTab = useProjectExplorerStore((state) => state.followActiveTab);
  const organizeByChapter = useProjectExplorerStore((state) => state.organizeByChapter);
  const groupUnassignedItems = useProjectExplorerStore((state) => state.groupUnassignedItems);
  const chapters = useProjectExplorerStore((state) => state.chapters);
  const hydrateExplorer = useProjectExplorerStore((state) => state.hydrate);
  const activeNodeId = useProjectExplorerStore((state) => state.activeNodeId);
  const setActiveNodeId = useProjectExplorerStore((state) => state.setActiveNodeId);
  const followSuppressedNodeIds = useProjectExplorerStore((state) => state.followSuppressedNodeIds);
  const setFollowExpandedNodeIds = useProjectExplorerStore((state) => state.setFollowExpandedNodeIds);
  const clearFollowSuppressedNodeIds = useProjectExplorerStore((state) => state.clearFollowSuppressedNodeIds);
  const activeGroupId = useWorkbenchStore((state) => state.activeGroupId);
  const groupsById = useWorkbenchStore((state) => state.groupsById);
  const tabsById = useWorkbenchStore((state) => state.tabsById);
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const [dialogState, setDialogState] = useState<EntityDialogState | null>(null);
  const [chapterDialogState, setChapterDialogState] = useState<ChapterDialogState | null>(null);
  const [alert, setAlert] = useState<ExplorerAlert | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  useEffect(() => {
    if (!project) return;
    const editorState = editorProjectStateFromProject(project);
    hydrateExplorer(editorState.explorer, editorState.chapters);
  }, [hydrateExplorer, project]);

  const explorer = useMemo(() => ({ expandedNodeIds, hiddenCollectionKeys, followActiveTab, organizeByChapter, groupUnassignedItems }), [expandedNodeIds, followActiveTab, groupUnassignedItems, hiddenCollectionKeys, organizeByChapter]);
  const tree = useMemo(() => project ? buildProjectExplorerTree(project, { explorer, chapters }) : [], [chapters, explorer, project]);
  const activeTabId = groupsById[activeGroupId]?.activeTabId ?? null;
  const activeTab = useMemo(() => activeTabId ? tabsById[activeTabId] ?? null : null, [activeTabId, tabsById]);

  useEffect(() => {
    clearFollowSuppressedNodeIds();
  }, [activeTabId, clearFollowSuppressedNodeIds]);

  useEffect(() => {
    if (!followActiveTab || !activeTab) {
      setFollowExpandedNodeIds([]);
      return;
    }
    const placement = findProjectExplorerPlacementForTab(tree, activeTab);
    if (!placement) {
      setActiveNodeId(null);
      setFollowExpandedNodeIds([]);
      return;
    }
    setActiveNodeId(placement.node.id);
    setFollowExpandedNodeIds(placement.ancestorIds.filter((nodeId) => !expandedNodeIds.includes(nodeId) && !followSuppressedNodeIds.includes(nodeId)));
  }, [activeTab, expandedNodeIds, followActiveTab, followSuppressedNodeIds, setActiveNodeId, setFollowExpandedNodeIds, tree]);

  useEffect(() => {
    if (!followActiveTab || !activeNodeId) return;
    const frame = window.requestAnimationFrame(() => {
      const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(activeNodeId) : activeNodeId.replace(/"/g, '\\"');
      treeScrollRef.current?.querySelector<HTMLElement>(`[data-explorer-node-id="${escaped}"]`)?.scrollIntoView({ block: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeNodeId, followActiveTab, tree]);

  if (!project) {
    return (
      <div className="space-y-1 p-2">
        <Button className="h-8 w-full justify-start gap-2 px-2" size="default" variant="ghost" onClick={() => dispatchWorkspaceToolbarCommand('new-project')}><FilePlus2 className="h-3.5 w-3.5" />New Project</Button>
        <Button className="h-8 w-full justify-start gap-2 px-2" size="default" variant="ghost" onClick={() => dispatchWorkspaceToolbarCommand('open-project')}><FolderOpen className="h-3.5 w-3.5" />Open Project</Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProjectHeading projectName={project.project.name.trim() || 'Project'} onManageChapters={() => setChapterDialogState({ action: 'manage' })} />
      <div ref={treeScrollRef} className="min-h-0 flex-1 overflow-y-auto p-1">
        {tree.map((node) => <ProjectExplorerItem key={node.id} node={node} project={project} onContextMenu={setContextMenu} />)}
      </div>
      <ExplorerContextMenu state={contextMenu} project={project} onClose={() => setContextMenu(null)} openDialog={setDialogState} openChapterDialog={setChapterDialogState} showAlert={setAlert} />
      <EntityOperationDialog state={dialogState} project={project} onClose={() => setDialogState(null)} />
      <ChapterDialog state={chapterDialogState} project={project} onClose={() => setChapterDialogState(null)} />
      <Dialog open={alert !== null} onOpenChange={(open) => { if (!open) setAlert(null); }}>
        <DialogPopup>
          <DialogTitle>{alert?.title ?? 'Project explorer warning'}</DialogTitle>
          <DialogDescription>{alert?.message}</DialogDescription>
          <div className="flex justify-end"><Button size="sm" onClick={() => setAlert(null)}>OK</Button></div>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
