import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  Search,
  Settings,
  Tags,
  Trash2,
  WholeWord,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TagBadge } from '@/components/tags/TagBadge';
import { TagInput } from '@/components/tags/TagInput';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { Label } from '@/components/ui/label';
import {
  DropdownMenuCheckboxItem,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useCommandStore } from '@/commands/command-store';
import type { CommandRequest } from '@/commands/command-types';
import { useProjectStore } from '@/project/project-store';
import {
  MUTATION_SURFACE_ATTRIBUTIONS,
  recordSaveUnitId,
  structuralSaveUnitId,
} from '@/project/save-unit-registry';
import {
  deleteEntityRecordPreflight,
  referenceTargetFromEntity,
} from '@/project/entity-operations';
import { useEntityUsagesStore } from '@/project/entity-usages-store';
import { useWorkspaceStore, type AssetNode } from '@/stores/workspace-store';
import {
  authoringCollectionMetadata,
  type AuthoringCollectionKey,
} from '../../shared/project-schema/authoring-collections';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import {
  isAuthoringProject,
  type AuthoringProject,
  type AuthoringRecordBase,
} from '../../shared/project-schema/authoring-project';
import {
  collectProjectTags,
  normalizeTagKey,
  recordEditorMetadata,
} from '../../shared/project-schema/authoring-tags';
import { buildProjectSearchIndex } from '../../shared/project-search/project-search-index';
import { searchProjectIndex } from '../../shared/project-search/project-search';
import { searchReferences } from '../../shared/project-search/project-search-helpers';
import { editorProjectStateFromProject } from '@/workbench/project-editor-state';
import {
  buildAssetsEditorTab,
  buildDefaultRecordTab,
  buildImageGenerationTab,
  buildProjectChaptersTab,
  buildProjectSettingsTab,
  buildProjectTagsTab,
  buildTestsEditorTab,
  buildVariablesEditorTab,
} from '@/workbench/editor-registry';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { dispatchWorkspaceToolbarCommand } from './workspace-toolbar-events';
import {
  WORKSPACE_TOOLBAR_COMMAND_EVENT,
  type WorkspaceToolbarCommandDetail,
} from './workspace-toolbar-events';
import { visualForCollection, chapterVisual, hiddenVisual } from './collection-visuals';
import {
  buildProjectExplorerTree,
  collectiveCollectionSet,
  findProjectExplorerPlacementForTab,
  type ProjectExplorerNode,
} from './project-explorer-tree';
import { recordTargetKey, useProjectExplorerStore } from './project-explorer-store';
import { RecentProjectsList } from './WorkspaceDashboard';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { NewEntityWizardDialog } from '@/wizard/new-entity/NewEntityWizardDialog';

type EntityAction = 'rename' | 'duplicate' | 'delete' | 'metadata';

interface EntityDialogState {
  action: EntityAction;
  collection: AuthoringCollectionKey;
  entityId?: string;
}

interface NewEntityWizardState {
  collection?: AuthoringCollectionKey;
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

interface HoverDetailsState {
  node: ProjectExplorerNode;
  x: number;
  y: number;
}

function recordForNode(
  project: AuthoringProject | null,
  node: ProjectExplorerNode,
): AuthoringRecordBase | null {
  if (!project || !node.collection || !node.entityId) return null;
  return project[node.collection][node.entityId] ?? null;
}

function defaultDuplicateId(entityId: string) {
  return `${entityId}-copy`;
}

function withExplorerPlacement(tab: WorkbenchTab, explorerNodeId: string): WorkbenchTab {
  return {
    ...tab,
    resource: tab.resource
      ? { ...tab.resource, explorerNodeId }
      : { kind: 'project', stableId: tab.id, explorerNodeId },
  };
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
  const [tags, setTags] = useState<string[]>([]);
  const [color, setColor] = useState('');
  const [forceDelete, setForceDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setForceDelete(false);
    if (!state) return;
    const record = project && state.entityId ? project[state.collection][state.entityId] : null;
    if (state.action === 'duplicate') {
      setId(defaultDuplicateId(state.entityId ?? 'record'));
      setLabel(record ? `${record.label} Copy` : 'Copy');
      setDescription('');
      setTags([]);
      setColor('');
    } else if (state.action === 'rename') {
      setId(state.entityId ?? '');
      setLabel(record?.label ?? '');
      setDescription('');
      setTags([]);
      setColor('');
    } else if (state.action === 'metadata') {
      const editorMetadata = state.entityId
        ? recordEditorMetadata(project!, state.collection, state.entityId)
        : { tags: [] };
      setId(state.entityId ?? '');
      setLabel(record?.label ?? '');
      setDescription(record?.description ?? '');
      setTags(editorMetadata.tags);
      setColor(editorMetadata.color ?? '');
    }
  }, [project, state]);

  const tagSuggestions = useMemo(
    () => (project ? collectProjectTags(project, tags) : []),
    [project, tags],
  );

  if (!state || !project) return null;
  const activeState = state;
  const metadata = authoringCollectionMetadata[activeState.collection];
  const record = activeState.entityId
    ? project[activeState.collection][activeState.entityId]
    : null;
  const deletePreflight =
    activeState.action === 'delete' && activeState.entityId
      ? deleteEntityRecordPreflight(project, {
          collection: activeState.collection,
          id: activeState.entityId,
        })
      : null;

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
    return buildDefaultRecordTab({
      id: `${collection}:${entityId}`,
      label: title,
      type: authoringCollectionMetadata[collection].nodeType,
      collection,
      entityId,
    });
  }

  function submit() {
    const state = activeState;
    if (state.action === 'rename' && state.entityId) {
      const toId = id.trim();
      finish(
        executeCommand({
          type: 'entity.renameId',
          label: `Rename ${state.collection}/${state.entityId}`,
          payload: {
            collection: state.collection,
            fromId: state.entityId,
            toId,
            label: label.trim() || undefined,
          },
          originSaveUnitId: structuralSaveUnitId(state.collection),
          persistencePolicy: 'auto-commit',
        }),
        () => {
          const tab = tabFor(state.collection, toId, label.trim() || toId);
          if (tab) openTab(tab);
        },
      );
    } else if (state.action === 'duplicate' && state.entityId) {
      const targetId = id.trim();
      finish(
        executeCommand({
          type: 'entity.duplicateRecord',
          label: `Duplicate ${state.collection}/${state.entityId}`,
          payload: {
            collection: state.collection,
            sourceId: state.entityId,
            targetId,
            label: label.trim() || undefined,
          },
          originSaveUnitId: structuralSaveUnitId(state.collection),
          persistencePolicy: 'auto-commit',
        }),
        () => {
          const tab = tabFor(state.collection, targetId, label.trim() || targetId);
          if (tab) openTab(tab);
        },
      );
    } else if (state.action === 'delete' && state.entityId) {
      finish(
        executeCommand({
          type: 'entity.deleteRecord',
          label: `Delete ${state.collection}/${state.entityId}`,
          payload: { collection: state.collection, entityId: state.entityId, force: forceDelete },
          originSaveUnitId: structuralSaveUnitId(state.collection),
          persistencePolicy: 'auto-commit',
        }),
        () => undefined,
      );
    } else if (state.action === 'metadata' && state.entityId) {
      finish(
        executeCommand({
          type: 'entity.updateMetadata',
          label: `Update ${state.collection}/${state.entityId}`,
          payload: {
            collection: state.collection,
            entityId: state.entityId,
            label: label.trim(),
            description: description.trim() || undefined,
            tags,
            color: color.trim() || null,
          },
          originSaveUnitId: recordSaveUnitId(state.collection, state.entityId),
          persistencePolicy: 'manual-save',
        }),
        () => undefined,
      );
    }
  }

  const title =
    state.action === 'rename'
      ? `Rename ${state.entityId}`
      : state.action === 'duplicate'
        ? `Duplicate ${state.entityId}`
        : state.action === 'delete'
          ? `Delete ${state.entityId}`
          : `Edit ${state.entityId}`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup key={`${state.action}:${state.collection}:${state.entityId ?? ''}`}>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {state.action === 'delete'
            ? 'Delete removes only this record. Existing references are not rewritten.'
            : `Edit base metadata for ${metadata.label}.`}
        </DialogDescription>
        <div className="space-y-3">
          {error ? (
            <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
          {state.action === 'delete' ? (
            <div className="space-y-3 text-sm">
              {deletePreflight && deletePreflight.usages.length > 0 ? (
                <div className="rounded border p-2 text-xs">
                  <div className="font-medium">
                    Referenced by {deletePreflight.usages.length} usage
                    {deletePreflight.usages.length === 1 ? '' : 's'}:
                  </div>
                  <div className="mt-2 max-h-32 space-y-1 overflow-auto font-mono text-[10px] text-muted-foreground">
                    {deletePreflight.usages.map((usage, index) => (
                      <div key={`${usage.path}-${index}`}>
                        {usage.kind}: {usage.sourceCollection}/{usage.sourceId} {usage.path}
                      </div>
                    ))}
                  </div>
                  <label className="mt-3 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={forceDelete}
                      onChange={(event) => setForceDelete(event.currentTarget.checked)}
                    />
                    Force delete and let validation report missing references
                  </label>
                </div>
              ) : (
                <p className="rounded border p-2 text-xs text-muted-foreground">
                  No references point to this record.
                </p>
              )}
            </div>
          ) : (
            <>
              {state.action !== 'metadata' ? (
                <div className="space-y-1">
                  <Label htmlFor="entity-id">ID</Label>
                  <Input
                    id="entity-id"
                    value={id}
                    onChange={(event) => setId(event.currentTarget.value)}
                    placeholder="lowercase-kebab-id"
                  />
                </div>
              ) : null}
              <div className="space-y-1">
                <Label htmlFor="entity-label">Label</Label>
                <Input
                  id="entity-label"
                  value={label}
                  onChange={(event) => setLabel(event.currentTarget.value)}
                />
              </div>
              {state.action === 'metadata' && record ? (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="entity-description">Description</Label>
                    <Input
                      id="entity-description"
                      value={description}
                      onChange={(event) => setDescription(event.currentTarget.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="entity-tags">Tags</Label>
                    <TagInput
                      id="entity-tags"
                      value={tags}
                      onChange={setTags}
                      suggestions={tagSuggestions}
                      placeholder="Add tag"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="entity-color">Color</Label>
                    <Input
                      id="entity-color"
                      value={color}
                      onChange={(event) => setColor(event.currentTarget.value)}
                      placeholder="#8b5cf6 or empty"
                    />
                  </div>
                </>
              ) : null}
            </>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={state.action === 'delete' ? 'destructive' : 'default'}
            onClick={submit}
            disabled={state.action === 'delete' && !!deletePreflight?.usages.length && !forceDelete}
          >
            {state.action === 'delete' ? 'Delete' : 'Apply'}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function ProjectHeading({ projectName }: { projectName: string }) {
  const openTab = useWorkbenchStore((state) => state.openTab);
  const followActiveTab = useProjectExplorerStore((state) => state.followActiveTab);
  const organizeByChapter = useProjectExplorerStore((state) => state.organizeByChapter);
  const groupUnassignedItems = useProjectExplorerStore((state) => state.groupUnassignedItems);
  const hideEmptyCategories = useProjectExplorerStore((state) => state.hideEmptyCategories);
  const showInfoOnHover = useProjectExplorerStore((state) => state.showInfoOnHover);
  const setFollowActiveTab = useProjectExplorerStore((state) => state.setFollowActiveTab);
  const setOrganizeByChapter = useProjectExplorerStore((state) => state.setOrganizeByChapter);
  const setGroupUnassignedItems = useProjectExplorerStore((state) => state.setGroupUnassignedItems);
  const setHideEmptyCategories = useProjectExplorerStore((state) => state.setHideEmptyCategories);
  const setShowInfoOnHover = useProjectExplorerStore((state) => state.setShowInfoOnHover);
  const executeCommand = useCommandStore((state) => state.executeCommand);
  const { t } = useTranslation('workspace');

  function setOption(payload: {
    followActiveTab?: boolean;
    organizeByChapter?: boolean;
    groupUnassignedItems?: boolean;
    hideEmptyCategories?: boolean;
    showInfoOnHover?: boolean;
  }) {
    executeCommand({
      type: 'project.setExplorerOptions',
      label: 'Update explorer options',
      payload,
      ...MUTATION_SURFACE_ATTRIBUTIONS.explorerOptionsAndVisibility,
    });
    if (payload.followActiveTab !== undefined) setFollowActiveTab(payload.followActiveTab);
    if (payload.organizeByChapter !== undefined) setOrganizeByChapter(payload.organizeByChapter);
    if (payload.groupUnassignedItems !== undefined)
      setGroupUnassignedItems(payload.groupUnassignedItems);
    if (payload.hideEmptyCategories !== undefined)
      setHideEmptyCategories(payload.hideEmptyCategories);
    if (payload.showInfoOnHover !== undefined) setShowInfoOnHover(payload.showInfoOnHover);
  }

  return (
    <div className="flex items-center gap-2 border-b px-2 py-2">
      <div
        className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        title={projectName}
      >
        {projectName}
      </div>
      <Menu>
        <MenuTrigger
          className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-accent"
          aria-label="Project explorer menu"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </MenuTrigger>
        <MenuPopup className="w-auto min-w-56">
          <MenuItem
            className="whitespace-nowrap"
            onClick={() => openTab(buildProjectSettingsTab())}
          >
            <Settings /> Project Settings…
          </MenuItem>
          <MenuItem
            className="whitespace-nowrap"
            onClick={() => openTab(buildProjectChaptersTab())}
          >
            <FolderOpen /> Manage Chapters…
          </MenuItem>
          <MenuItem className="whitespace-nowrap" onClick={() => openTab(buildProjectTagsTab())}>
            <Tags /> Manage Tags…
          </MenuItem>
          <MenuSeparator />
          <DropdownMenuCheckboxItem
            className="whitespace-nowrap"
            checked={showInfoOnHover}
            onCheckedChange={(checked) => setOption({ showInfoOnHover: Boolean(checked) })}
          >
            Show Info on Hover
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            className="whitespace-nowrap"
            checked={hideEmptyCategories}
            onCheckedChange={(checked) => setOption({ hideEmptyCategories: Boolean(checked) })}
          >
            {t('projectExplorer.options.hideEmptyCategories')}
          </DropdownMenuCheckboxItem>
          <MenuSeparator />
          <DropdownMenuCheckboxItem
            className="whitespace-nowrap"
            checked={followActiveTab}
            onCheckedChange={(checked) => setOption({ followActiveTab: Boolean(checked) })}
          >
            Follow Active Tab
          </DropdownMenuCheckboxItem>
          <MenuSeparator />
          <DropdownMenuCheckboxItem
            className="whitespace-nowrap"
            checked={organizeByChapter}
            onCheckedChange={(checked) => setOption({ organizeByChapter: Boolean(checked) })}
          >
            Organize by Chapter
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            className="whitespace-nowrap"
            checked={groupUnassignedItems}
            disabled={!organizeByChapter}
            onCheckedChange={(checked) => setOption({ groupUnassignedItems: Boolean(checked) })}
          >
            Group Unassigned Items
          </DropdownMenuCheckboxItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

function ProjectExplorerHoverDetails({
  state,
  project,
}: {
  state: HoverDetailsState | null;
  project: AuthoringProject | null;
}) {
  if (!state || !project) return null;
  const node = state.node;
  const record = recordForNode(project, node);
  const collection = node.collection;
  const metadata =
    collection && node.entityId
      ? recordEditorMetadata(project, collection, node.entityId)
      : { tags: [] };
  const tagByKey = new Map(collectProjectTags(project, metadata.tags).map((tag) => [tag.key, tag]));
  const alignedTop = state.y - 4;
  const top =
    typeof window === 'undefined'
      ? alignedTop
      : Math.max(48, Math.min(alignedTop, window.innerHeight - 220));
  return (
    <div
      className="pointer-events-none fixed z-50 w-72 rounded-r-md border bg-popover p-2 text-xs text-popover-foreground shadow-lg"
      style={{ left: state.x, top }}
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{node.label}</div>
        <div className="mt-1 font-mono text-[10px] text-muted-foreground">{node.id}</div>
      </div>
      {collection ? (
        <div className="mt-3 grid grid-cols-[4rem_1fr] gap-x-2 gap-y-1">
          <div className="text-muted-foreground">Type</div>
          <div>
            {authoringCollectionMetadata[collection as AuthoringCollectionKey]?.singularLabel ??
              collection}
          </div>
          {node.entityId ? (
            <>
              <div className="text-muted-foreground">ID</div>
              <div className="truncate font-mono">{node.entityId}</div>
            </>
          ) : null}
        </div>
      ) : null}
      {record?.description ? (
        <div className="mt-3 line-clamp-3 text-muted-foreground">{record.description}</div>
      ) : null}
      {record ? (
        <div className="mt-3">
          <div className="mb-1 text-muted-foreground">Tags</div>
          {metadata.tags.length ? (
            <div className="flex flex-wrap gap-1">
              {metadata.tags.map((tag) => {
                const summary = tagByKey.get(normalizeTagKey(tag));
                return (
                  <TagBadge
                    key={tag}
                    name={tag}
                    color={summary?.color ?? 'tag-slate'}
                    className="text-[10px]"
                  />
                );
              })}
            </div>
          ) : (
            <div className="text-muted-foreground">No tags</div>
          )}
        </div>
      ) : null}
      {node.count !== undefined ? (
        <div className="mt-3 text-muted-foreground">
          {node.count} item{node.count === 1 ? '' : 's'}
        </div>
      ) : null}
    </div>
  );
}

function ExplorerContextMenu({
  state,
  project,
  onClose,
  openDialog,
  openCreateWizard,
  showAlert,
}: {
  state: ContextMenuState | null;
  project: AuthoringProject | null;
  onClose: () => void;
  openDialog: (state: EntityDialogState) => void;
  openCreateWizard: (state: NewEntityWizardState) => void;
  showAlert: (alert: ExplorerAlert) => void;
}) {
  const openTab = useWorkbenchStore((store) => store.openTab);
  const setSearchResults = useEntityUsagesStore((store) => store.setSearchResults);
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
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', close);
    };
  }, [onClose, state]);

  if (!state || !project || !state.node.collection) return null;
  const activeProject = project;
  const node = state.node;
  const collection = node.collection as AuthoringCollectionKey;
  const isHidden = hiddenCollectionKeys.includes(collection);
  const collective = node.kind === 'collective-collection';
  const assignDisabled =
    Object.keys(chapters.records).length === 0 ||
    collectiveCollectionSet.has(collection) ||
    !node.entityId;

  function run(
    command: Omit<CommandRequest, 'originSaveUnitId' | 'persistencePolicy'>,
    attribution: Pick<CommandRequest, 'originSaveUnitId' | 'persistencePolicy'> = {
      ...MUTATION_SURFACE_ATTRIBUTIONS.explorerOptionsAndVisibility,
    },
  ) {
    const result = executeCommand({ ...command, ...attribution });
    const failure = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    if (failure) setStatusMessage(failure.message);
    return result.ok && !failure;
  }

  function hideCollection(nextHidden: boolean) {
    const keys = nextHidden
      ? [...hiddenCollectionKeys, collection]
      : hiddenCollectionKeys.filter((key) => key !== collection);
    if (
      run({
        type: 'project.setHiddenCollections',
        label: 'Update hidden categories',
        payload: { hiddenCollectionKeys: keys },
      })
    )
      setHiddenCollectionKeys(keys);
  }

  function openNode() {
    if (collective) {
      setActiveNodeId(node.id);
      if (collection === 'assets') openTab(withExplorerPlacement(buildAssetsEditorTab(), node.id));
      else if (collection === 'tests')
        openTab(withExplorerPlacement(buildTestsEditorTab(), node.id));
      else if (collection === 'variables')
        openTab(withExplorerPlacement(buildVariablesEditorTab(), node.id));
      return;
    }
    if (!node.entityId) return;
    setActiveNodeId(node.id);
    const tab = buildDefaultRecordTab({
      id: `${collection}:${node.entityId}`,
      label: node.label,
      type: authoringCollectionMetadata[collection].nodeType,
      collection,
      entityId: node.entityId,
    });
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
      if (result.error || result.diagnostics.some((diagnostic) => diagnostic.severity === 'error'))
        showAlert({ title: 'Asset import failed', message });
      return;
    }
    run(
      {
        type: 'asset.importFiles',
        label: `Import ${result.assets.length} asset${result.assets.length === 1 ? '' : 's'}`,
        payload: { assets: result.assets },
      },
      {
        ...MUTATION_SURFACE_ATTRIBUTIONS.assetImport,
      },
    );
  }

  function findNodeUsages() {
    if (!node.entityId) return;
    const target = referenceTargetFromEntity({ collection, entityId: node.entityId });
    const record = activeProject[collection][node.entityId];
    const aliases =
      collection === 'assets' && record ? parseAssetData(record.data)?.aliases : undefined;
    setSearchResults(
      target,
      searchReferences(activeProject, { referencesTo: [target], aliases }).results,
    );
    setActiveBottomPanel('references');
  }

  const itemClass =
    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent';
  return (
    <div
      className="fixed z-50 min-w-44 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{ left: state.x, top: state.y }}
      onClick={(event) => event.stopPropagation()}
    >
      {node.kind === 'record' ? (
        <>
          <button
            className={itemClass}
            onClick={() => {
              openNode();
              onClose();
            }}
          >
            <File className="h-3.5 w-3.5" /> Open
          </button>
          <button
            className={itemClass}
            onClick={() => {
              if (node.entityId)
                openDialog({ action: 'metadata', collection, entityId: node.entityId });
              onClose();
            }}
          >
            <Palette className="h-3.5 w-3.5" /> Edit Metadata
          </button>
          <button
            className={itemClass}
            onClick={() => {
              if (node.entityId)
                openDialog({ action: 'rename', collection, entityId: node.entityId });
              onClose();
            }}
          >
            <FileCode className="h-3.5 w-3.5" /> Rename ID
          </button>
          <button
            className={itemClass}
            onClick={() => {
              if (node.entityId)
                openDialog({ action: 'duplicate', collection, entityId: node.entityId });
              onClose();
            }}
          >
            <Copy className="h-3.5 w-3.5" /> Duplicate
          </button>
          <button
            className={itemClass}
            disabled={assignDisabled}
            onClick={() => {
              if (node.entityId)
                openTab(
                  buildProjectChaptersTab({
                    collection,
                    entityId: node.entityId,
                    label: node.label,
                  }),
                );
              onClose();
            }}
          >
            <FolderOpen className="h-3.5 w-3.5" /> Assign Chapters…
          </button>
          <button
            className={itemClass}
            onClick={() => {
              findNodeUsages();
              onClose();
            }}
          >
            <Search className="h-3.5 w-3.5" /> Find Usages
          </button>
          <div className="my-1 h-px bg-border" />
          <button
            className={`${itemClass} text-destructive`}
            onClick={() => {
              if (node.entityId)
                openDialog({ action: 'delete', collection, entityId: node.entityId });
              onClose();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
        </>
      ) : node.kind === 'chapter-folder' && node.chapterId ? (
        <>
          <button
            className={itemClass}
            onClick={() => {
              openTab(buildProjectChaptersTab());
              onClose();
            }}
          >
            <FolderOpen className="h-3.5 w-3.5" /> Manage Chapters…
          </button>
        </>
      ) : (
        <>
          {collective ? (
            <button
              className={itemClass}
              onClick={() => {
                openNode();
                onClose();
              }}
            >
              <File className="h-3.5 w-3.5" /> Open
            </button>
          ) : null}
          {collection === 'assets' ? (
            <button
              className={itemClass}
              onClick={() => {
                openTab(buildImageGenerationTab());
                onClose();
              }}
            >
              <FilePlus2 className="h-3.5 w-3.5" /> Generate Image
            </button>
          ) : null}
          {collection === 'assets' ? (
            <button
              className={itemClass}
              onClick={() => {
                void importAssetsFromFolder();
                onClose();
              }}
            >
              <FilePlus2 className="h-3.5 w-3.5" /> Import Assets
            </button>
          ) : null}
          {!collective ? (
            <button
              className={itemClass}
              onClick={() => {
                openCreateWizard({ collection });
                onClose();
              }}
            >
              <FilePlus2 className="h-3.5 w-3.5" /> Create{' '}
              {authoringCollectionMetadata[collection].singularLabel}
            </button>
          ) : null}
          <div className="my-1 h-px bg-border" />
          <button
            className={itemClass}
            onClick={() => {
              hideCollection(!isHidden);
              onClose();
            }}
          >
            {isHidden ? 'Unhide Category' : 'Hide Category'}
          </button>
        </>
      )}
    </div>
  );
}

function ProjectExplorerItem({
  node,
  project,
  depth = 0,
  onContextMenu,
  onHoverDetails,
  getHoverDetailsX,
}: {
  node: ProjectExplorerNode;
  project: AuthoringProject | null;
  depth?: number;
  onContextMenu: (state: ContextMenuState) => void;
  onHoverDetails: (state: HoverDetailsState | null) => void;
  getHoverDetailsX: () => number | null;
}) {
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
  const visual = collection
    ? visualForCollection(collection)
    : node.kind === 'hidden-root'
      ? hiddenVisual
      : chapterVisual;
  const Icon =
    node.kind === 'chapter-folder' ||
    node.kind === 'all-folder' ||
    node.kind === 'unassigned-folder'
      ? chapterVisual.icon
      : visual.icon;
  const recordMetadata =
    project && node.collection && node.entityId
      ? recordEditorMetadata(project, node.collection, node.entityId)
      : { tags: [] };
  const canExpand = node.expandable && (node.children?.length ?? 0) > 0;
  const openable = node.kind === 'record' || node.kind === 'collective-collection';
  const inert = !openable && !canExpand;
  const clickSelectionId =
    node.entityId && node.collection ? `${node.collection}:${node.entityId}` : node.id;
  const selected = activeNodeId ? activeNodeId === node.id : selectedId === clickSelectionId;
  const dimClass = node.dimmed ? 'opacity-55' : '';
  const inertClass =
    inert && !node.dimmed ? 'text-muted-foreground/80 hover:text-muted-foreground' : '';
  const cursorClass = openable || canExpand ? 'cursor-pointer' : 'cursor-default';

  function openNode() {
    if (
      node.kind === 'empty-root' ||
      node.kind === 'hidden-root' ||
      node.kind === 'collection' ||
      node.kind === 'chapter-folder' ||
      node.kind === 'all-folder' ||
      node.kind === 'unassigned-folder'
    ) {
      if (canExpand) {
        if (expanded) suppressFollowNodeId(node.id);
        if (!followExpanded || manuallyExpanded) toggleExpanded(node.id);
      }
      return;
    }
    if (node.kind === 'collective-collection' && node.collection) {
      setSelectedId(node.id);
      setActiveNodeId(node.id);
      if (node.collection === 'assets')
        openTab(withExplorerPlacement(buildAssetsEditorTab(), node.id));
      else if (node.collection === 'tests')
        openTab(withExplorerPlacement(buildTestsEditorTab(), node.id));
      else if (node.collection === 'variables')
        openTab(withExplorerPlacement(buildVariablesEditorTab(), node.id));
      return;
    }
    if (node.kind === 'record' && node.collection && node.entityId) {
      const targetId = `${node.collection}:${node.entityId}`;
      setSelectedId(targetId);
      setActiveNodeId(node.id);
      const tab = buildDefaultRecordTab({
        id: targetId,
        label: node.label,
        type: authoringCollectionMetadata[node.collection].nodeType,
        collection: node.collection,
        entityId: node.entityId,
      });
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
        onMouseEnter={(event) => {
          if (!project) return;
          const rect = event.currentTarget.getBoundingClientRect();
          onHoverDetails({ node, x: getHoverDetailsX() ?? rect.right, y: rect.top });
        }}
        onMouseLeave={() => onHoverDetails(null)}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu({ node, x: event.clientX, y: event.clientY });
        }}
      >
        {canExpand ? (
          expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <Icon
          className={`h-3.5 w-3.5 shrink-0 ${node.kind === 'chapter-folder' && node.chapterId ? chapterVisual.colorClassName : visual.colorClassName}`}
        />
        {node.kind === 'chapter-folder' && node.chapterId ? (
          <span
            className="h-2 w-2 shrink-0 rounded-full border"
            style={{
              backgroundColor:
                editorProjectStateFromProject(project).chapters.records[node.chapterId]?.color ??
                'transparent',
            }}
          />
        ) : null}
        {recordMetadata.color ? (
          <span
            className="h-2 w-2 shrink-0 rounded-full border"
            style={{ backgroundColor: recordMetadata.color }}
          />
        ) : null}
        <span className="truncate">{node.label}</span>
        {recordMetadata.tags.length ? (
          <Badge variant="outline" className="ml-1 h-4 px-1 text-[9px]">
            {recordMetadata.tags.length}
          </Badge>
        ) : null}
        {node.count !== undefined ? (
          <span
            className={`ml-auto font-mono text-[10px] ${inert && !node.dimmed ? 'text-muted-foreground/70' : 'text-muted-foreground'}`}
          >
            {node.count}
          </span>
        ) : null}
      </button>
      {canExpand && expanded
        ? node.children?.map((child) => (
            <ProjectExplorerItem
              key={child.id}
              node={child}
              project={project}
              depth={depth + 1}
              onContextMenu={onContextMenu}
              onHoverDetails={onHoverDetails}
              getHoverDetailsX={getHoverDetailsX}
            />
          ))
        : null}
    </div>
  );
}

export function ProjectExplorer(_props: { nodes: AssetNode[] }) {
  const projectDocument = useProjectStore((state) => state.document);
  const projectFilePath = useProjectStore((state) => state.projectFilePath);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const expandedNodeIds = useProjectExplorerStore((state) => state.expandedNodeIds);
  const hiddenCollectionKeys = useProjectExplorerStore((state) => state.hiddenCollectionKeys);
  const followActiveTab = useProjectExplorerStore((state) => state.followActiveTab);
  const organizeByChapter = useProjectExplorerStore((state) => state.organizeByChapter);
  const groupUnassignedItems = useProjectExplorerStore((state) => state.groupUnassignedItems);
  const hideEmptyCategories = useProjectExplorerStore((state) => state.hideEmptyCategories);
  const showInfoOnHover = useProjectExplorerStore((state) => state.showInfoOnHover);
  const searchQuery = useProjectExplorerStore((state) => state.searchQuery);
  const filterTags = useProjectExplorerStore((state) => state.filterTags);
  const showTagFilter = useProjectExplorerStore((state) => state.showTagFilter);
  const exactMatch = useProjectExplorerStore((state) => state.exactMatch);
  const chapters = useProjectExplorerStore((state) => state.chapters);
  const hydrateExplorer = useProjectExplorerStore((state) => state.hydrate);
  const setSearchQuery = useProjectExplorerStore((state) => state.setSearchQuery);
  const setFilterTags = useProjectExplorerStore((state) => state.setFilterTags);
  const setShowTagFilter = useProjectExplorerStore((state) => state.setShowTagFilter);
  const setExactMatch = useProjectExplorerStore((state) => state.setExactMatch);
  const activeNodeId = useProjectExplorerStore((state) => state.activeNodeId);
  const setActiveNodeId = useProjectExplorerStore((state) => state.setActiveNodeId);
  const followSuppressedNodeIds = useProjectExplorerStore((state) => state.followSuppressedNodeIds);
  const setFollowExpandedNodeIds = useProjectExplorerStore(
    (state) => state.setFollowExpandedNodeIds,
  );
  const clearFollowSuppressedNodeIds = useProjectExplorerStore(
    (state) => state.clearFollowSuppressedNodeIds,
  );
  const activeGroupId = useWorkbenchStore((state) => state.activeGroupId);
  const groupsById = useWorkbenchStore((state) => state.groupsById);
  const tabsById = useWorkbenchStore((state) => state.tabsById);
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const [dialogState, setDialogState] = useState<EntityDialogState | null>(null);
  const [newEntityWizard, setNewEntityWizard] = useState<NewEntityWizardState | null>(null);
  const [alert, setAlert] = useState<ExplorerAlert | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [hoverDetails, setHoverDetails] = useState<HoverDetailsState | null>(null);
  const lastProjectKey = useRef<string | null>(null);

  function hoverDetailsX() {
    return treeScrollRef.current?.getBoundingClientRect().right ?? null;
  }

  useEffect(() => {
    const projectKey = project ? (projectFilePath ?? project.project.id) : null;
    if (projectKey === lastProjectKey.current) return;
    lastProjectKey.current = projectKey;
    if (!project) {
      hydrateExplorer(undefined, undefined);
      return;
    }
    const editorState = editorProjectStateFromProject(project);
    hydrateExplorer(editorState.explorer, editorState.chapters);
  }, [hydrateExplorer, project, projectFilePath]);

  const explorer = useMemo(
    () => ({
      expandedNodeIds,
      hiddenCollectionKeys,
      followActiveTab,
      organizeByChapter,
      groupUnassignedItems,
      hideEmptyCategories,
      showInfoOnHover,
      searchQuery,
      filterTags,
      showTagFilter,
      exactMatch,
    }),
    [
      expandedNodeIds,
      exactMatch,
      filterTags,
      followActiveTab,
      groupUnassignedItems,
      hiddenCollectionKeys,
      hideEmptyCategories,
      organizeByChapter,
      searchQuery,
      showInfoOnHover,
      showTagFilter,
    ],
  );
  const searchIndex = useMemo(() => (project ? buildProjectSearchIndex(project) : null), [project]);
  const activeFilterTags = useMemo(
    () => (showTagFilter ? filterTags : []),
    [filterTags, showTagFilter],
  );
  const isFiltering = Boolean(searchQuery.trim()) || activeFilterTags.length > 0;
  const searchResponse = useMemo(() => {
    if (!searchIndex || !isFiltering) return null;
    return searchProjectIndex(searchIndex, {
      text: searchQuery,
      tags: activeFilterTags,
      tagMode: 'all',
      tokenMode: 'all',
      threshold: exactMatch ? 0 : undefined,
      sort: { kind: 'label' },
    });
  }, [activeFilterTags, exactMatch, isFiltering, searchIndex, searchQuery]);
  const visibleRecordKeys = useMemo(() => {
    if (!searchResponse) return null;
    return new Set(
      searchResponse.results.flatMap((result) =>
        result.document.collection && result.document.entityId
          ? [recordTargetKey(result.document.collection, result.document.entityId)]
          : [],
      ),
    );
  }, [searchResponse]);
  const tagSuggestions = useMemo(
    () => (project ? collectProjectTags(project, filterTags) : []),
    [filterTags, project],
  );
  const tree = useMemo(
    () =>
      project ? buildProjectExplorerTree(project, { explorer, chapters, visibleRecordKeys }) : [],
    [chapters, explorer, project, visibleRecordKeys],
  );
  const activeTabId = groupsById[activeGroupId]?.activeTabId ?? null;
  const activeTab = useMemo(
    () => (activeTabId ? (tabsById[activeTabId] ?? null) : null),
    [activeTabId, tabsById],
  );

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
    setFollowExpandedNodeIds(
      placement.ancestorIds.filter(
        (nodeId) => !expandedNodeIds.includes(nodeId) && !followSuppressedNodeIds.includes(nodeId),
      ),
    );
  }, [
    activeTab,
    expandedNodeIds,
    followActiveTab,
    followSuppressedNodeIds,
    setActiveNodeId,
    setFollowExpandedNodeIds,
    tree,
  ]);

  useEffect(() => {
    if (!followActiveTab || !activeNodeId) return;
    const frame = window.requestAnimationFrame(() => {
      const escaped =
        typeof CSS !== 'undefined' && CSS.escape
          ? CSS.escape(activeNodeId)
          : activeNodeId.replace(/"/g, '\\"');
      treeScrollRef.current
        ?.querySelector<HTMLElement>(`[data-explorer-node-id="${escaped}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeNodeId, followActiveTab, tree]);

  useEffect(() => {
    if (!project) return;
    function openWizard(event: Event) {
      const detail = (event as CustomEvent<WorkspaceToolbarCommandDetail>).detail;
      const command = typeof detail === 'string' ? detail : detail?.command;
      if (event.type === 'noveltea-open-new-entity-wizard') setNewEntityWizard({});
      if (command === 'new-entity') setNewEntityWizard({});
    }
    window.addEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, openWizard);
    window.addEventListener('noveltea-open-new-entity-wizard', openWizard);
    return () => {
      window.removeEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, openWizard);
      window.removeEventListener('noveltea-open-new-entity-wizard', openWizard);
    };
  }, [project]);

  if (!project) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="space-y-1 border-b p-2">
          <Button
            className="h-8 w-full justify-start gap-2 px-2"
            size="default"
            variant="ghost"
            onClick={() => dispatchWorkspaceToolbarCommand('new-project')}
          >
            <FilePlus2 className="h-3.5 w-3.5" />
            New Project
          </Button>
          <Button
            className="h-8 w-full justify-start gap-2 px-2"
            size="default"
            variant="ghost"
            onClick={() => dispatchWorkspaceToolbarCommand('open-project')}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Open Project
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <RecentProjectsList compact noBorder />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProjectHeading projectName={project.project.name.trim() || 'Project'} />
      <div className="border-b">
        <SearchInput
          value={searchQuery}
          onValueChange={setSearchQuery}
          placeholder="Search project"
          aria-label="Search project"
          clearAriaLabel="Clear project search"
          inputClassName="h-8 rounded-none border-0 border-b bg-transparent pr-24 text-xs focus-visible:ring-0"
          endActions={
            <>
              <button
                type="button"
                className={`flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground ${exactMatch ? 'bg-accent text-accent-foreground' : ''}`}
                aria-pressed={exactMatch}
                aria-label="Toggle exact match"
                title="Exact match"
                onClick={() => setExactMatch(!exactMatch)}
              >
                <WholeWord className="size-3.5" />
              </button>
              <button
                type="button"
                className={`flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground ${showTagFilter ? 'bg-accent text-accent-foreground' : ''}`}
                aria-pressed={showTagFilter}
                aria-label="Toggle tag filter"
                title="Toggle tag filter"
                onClick={() => setShowTagFilter(!showTagFilter)}
              >
                <Tags className="size-3.5" />
              </button>
            </>
          }
        />
        {showTagFilter ? (
          <TagInput
            className="text-xs [&>div:first-child]:min-h-8 [&>div:first-child]:rounded-none [&>div:first-child]:border-0 [&>div:first-child]:bg-transparent [&>div:first-child]:py-0 [&>div:first-child]:pl-2 [&>div:first-child]:pr-8 [&>div:first-child]:focus-within:ring-0"
            value={filterTags}
            onChange={setFilterTags}
            suggestions={tagSuggestions}
            placeholder="Filter by tag"
            allowCreate={false}
          />
        ) : null}
        {searchResponse?.diagnostics.length ? (
          <div className="text-xs text-destructive">{searchResponse.diagnostics[0]?.message}</div>
        ) : null}
      </div>
      <div ref={treeScrollRef} className="min-h-0 flex-1 overflow-y-auto p-1">
        {tree.map((node) => (
          <ProjectExplorerItem
            key={node.id}
            node={node}
            project={project}
            onContextMenu={setContextMenu}
            onHoverDetails={showInfoOnHover ? setHoverDetails : () => undefined}
            getHoverDetailsX={hoverDetailsX}
          />
        ))}
        {tree.length === 0 && isFiltering ? (
          <div className="p-3 text-xs text-muted-foreground">
            No project records match the current search.
          </div>
        ) : null}
      </div>
      {showInfoOnHover ? (
        <ProjectExplorerHoverDetails state={hoverDetails} project={project} />
      ) : null}
      <ExplorerContextMenu
        state={contextMenu}
        project={project}
        onClose={() => setContextMenu(null)}
        openDialog={setDialogState}
        openCreateWizard={setNewEntityWizard}
        showAlert={setAlert}
      />
      <EntityOperationDialog
        state={dialogState}
        project={project}
        onClose={() => setDialogState(null)}
      />
      <NewEntityWizardDialog
        open={newEntityWizard !== null}
        project={project}
        initialCollection={newEntityWizard?.collection ?? null}
        onOpenChange={(open) => {
          if (!open) setNewEntityWizard(null);
        }}
      />
      <Dialog
        open={alert !== null}
        onOpenChange={(open) => {
          if (!open) setAlert(null);
        }}
      >
        <DialogPopup>
          <DialogTitle>{alert?.title ?? 'Project explorer warning'}</DialogTitle>
          <DialogDescription>{alert?.message}</DialogDescription>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setAlert(null)}>
              OK
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
