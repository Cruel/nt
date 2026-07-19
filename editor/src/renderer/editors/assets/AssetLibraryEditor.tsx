import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Images, Pencil, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TagInput } from '@/components/tags/TagInput';
import { SearchInput } from '@/components/ui/search-input';
import { useCommandStore } from '@/commands/command-store';
import { useAssetTrashStore } from '@/assets/asset-trash-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { buildAssetDetailTabForRecord, buildImageGenerationTab } from '@/workbench/editor-registry';
import { parseAssetData, type AssetData } from '../../../shared/project-schema/authoring-assets';
import {
  isAuthoringProject,
  type AuthoringRecordBase,
} from '../../../shared/project-schema/authoring-project';
import { collectProjectTags } from '../../../shared/project-schema/authoring-tags';
import { buildProjectSearchIndex } from '../../../shared/project-search/project-search-index';
import { searchProjectIndex } from '../../../shared/project-search/project-search';
import { AssetPreview } from './AssetPreview';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  useWorkbenchEditorTabState,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';

interface AssetListItem {
  id: string;
  record: AuthoringRecordBase;
  data: AssetData | null;
  label: string;
}

interface AssetContextMenuState {
  asset: AssetListItem;
  x: number;
  y: number;
}

function AssetContextMenu({
  state,
  projectFilePath,
  onClose,
}: {
  state: AssetContextMenuState | null;
  projectFilePath: string | null;
  onClose: () => void;
}) {
  const openTab = useWorkbenchStore((store) => store.openTab);
  const executeCommand = useCommandStore((store) => store.executeCommand);
  const rememberDeletedAsset = useAssetTrashStore((store) => store.rememberDeletedAsset);

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

  if (!state) return null;
  const { asset } = state;
  const itemClass =
    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent disabled:opacity-50';

  function deleteAsset() {
    const result = executeCommand({
      type: 'asset.deleteAsset',
      label: `Delete ${asset.id}`,
      payload: { assetId: asset.id, force: true },
    });
    if (
      projectFilePath &&
      asset.data?.source.path &&
      !result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ) {
      void window.noveltea
        .trashProjectAssetFiles(projectFilePath, [asset.data.source.path])
        .then((trashResult) => {
          const move = trashResult.moved?.[0];
          if (move) rememberDeletedAsset({ assetId: asset.id, projectFilePath, move });
        });
    }
    onClose();
  }

  return (
    <div
      className="fixed z-50 min-w-48 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{ left: state.x, top: state.y }}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        className={itemClass}
        onClick={() => {
          openTab(buildAssetDetailTabForRecord(asset.id, asset.label));
          onClose();
        }}
      >
        <ExternalLink className="h-3.5 w-3.5" /> Open
      </button>
      <button
        className={itemClass}
        disabled={asset.data?.kind !== 'image'}
        onClick={() => {
          if (asset.data?.kind === 'image')
            openTab(
              buildImageGenerationTab({
                sourceAssetId: asset.id,
                sourceProjectRelativePath: asset.data.source.path,
                mode: 'edit',
              }),
            );
          onClose();
        }}
      >
        <Images className="h-3.5 w-3.5" /> Edit Image with ComfyUI
      </button>
      <div className="my-1 h-px bg-border" />
      <button className={`${itemClass} text-destructive`} onClick={deleteAsset}>
        <Trash2 className="h-3.5 w-3.5" /> Delete
      </button>
    </div>
  );
}

const ASSET_LIBRARY_TAB_STATE_SCHEMA = 'noveltea.editor.asset-library-tab-state';

export function AssetLibraryEditor({ tab }: WorkbenchEditorProps) {
  const projectDocument = useProjectStore((state) => state.document);
  const projectFilePath = useProjectStore((state) => state.projectFilePath);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<AssetContextMenuState | null>(null);
  const [editingAssetId, setEditingAssetId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  useWorkbenchEditorTabState(
    tab.id,
    useMemo(
      () => ({
        captureTabState: (): WorkbenchTabStatePayload => ({
          schema: ASSET_LIBRARY_TAB_STATE_SCHEMA,
          schemaVersion: 1,
          payload: { query, kind, selectedTags },
        }),
        restoreTabState: (state: WorkbenchTabStatePayload) => {
          if (state.schema !== ASSET_LIBRARY_TAB_STATE_SCHEMA || state.schemaVersion !== 1) return;
          const payload = state.payload;
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
          const values = payload as Record<string, unknown>;
          if (typeof values.query === 'string') setQuery(values.query);
          if (typeof values.kind === 'string') setKind(values.kind);
          if (
            Array.isArray(values.selectedTags) &&
            values.selectedTags.every((tag: unknown) => typeof tag === 'string')
          ) {
            setSelectedTags(values.selectedTags as string[]);
          }
        },
      }),
      [kind, query, selectedTags],
    ),
  );
  const executeCommand = useCommandStore((store) => store.executeCommand);
  const allAssets = useMemo(() => {
    if (!project) return [];
    return Object.entries(project.assets)
      .map(([id, record]) => ({
        id,
        record,
        data: parseAssetData(record.data),
        label: record.label || id,
      }))
      .sort(
        (left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id),
      );
  }, [project]);
  const searchIndex = useMemo(() => (project ? buildProjectSearchIndex(project) : null), [project]);
  const assets = useMemo(() => {
    if (!project || !searchIndex) return [];
    const response = searchProjectIndex(searchIndex, {
      text: query,
      collections: ['assets'],
      assetTypes: kind === 'all' ? undefined : [kind],
      tags: selectedTags,
      tagMode: 'all',
      tokenMode: 'all',
      sort: { kind: 'label' },
    });
    return response.results.flatMap((result) => {
      const id = result.document.entityId;
      if (!id) return [];
      const record = project.assets[id];
      if (!record) return [];
      return [{ id, record, data: parseAssetData(record.data), label: record.label || id }];
    });
  }, [kind, project, query, searchIndex, selectedTags]);
  const kinds = useMemo(
    () => [...new Set(allAssets.map((asset) => asset.data?.kind).filter(Boolean))].sort(),
    [allAssets],
  );
  const tagSuggestions = useMemo(
    () => (project ? collectProjectTags(project, selectedTags) : []),
    [project, selectedTags],
  );

  function beginRename(asset: AssetListItem) {
    setEditingAssetId(asset.id);
    setEditingName(asset.label);
  }

  function cancelRename() {
    setEditingAssetId(null);
    setEditingName('');
  }

  function saveRename(asset: AssetListItem) {
    const nextName = editingName.trim();
    if (!nextName || nextName === asset.label) {
      cancelRename();
      return;
    }
    const result = executeCommand({
      type: 'entity.updateMetadata',
      label: `Rename asset ${asset.label}`,
      payload: { collection: 'assets', entityId: asset.id, label: nextName },
    });
    if (!result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) cancelRename();
  }

  if (!project)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Open an authoring project to browse assets.
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background p-3">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Assets</h2>
        </div>
        <Button
          size="sm"
          className="h-7 gap-1.5 px-2.5"
          onClick={() => openTab(buildImageGenerationTab())}
        >
          <Images className="h-3.5 w-3.5" /> Generate
        </Button>
        <SearchInput
          className="w-44"
          inputClassName="h-7 text-xs"
          value={query}
          onValueChange={setQuery}
          placeholder="Search assets"
          aria-label="Search assets"
          clearAriaLabel="Clear asset search"
        />
        <select
          className="h-7 rounded-md border border-input bg-background px-2 text-xs"
          value={kind}
          onChange={(event) => setKind(event.currentTarget.value)}
          aria-label="Asset type"
        >
          <option value="all">All types</option>
          {kinds.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <TagInput
          className="min-w-48 max-w-xs flex-1"
          value={selectedTags}
          onChange={setSelectedTags}
          suggestions={tagSuggestions}
          placeholder="Filter by tag"
          allowCreate={false}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-1">
          {assets.map((asset) => (
            <div
              key={asset.id}
              className="group min-w-0 rounded-md border border-transparent p-1.5 text-left transition-colors hover:border-border hover:bg-accent/50"
              onContextMenu={(event) => {
                event.preventDefault();
                setContextMenu({ asset, x: event.clientX, y: event.clientY });
              }}
            >
              <div className="space-y-1.5">
                <button
                  type="button"
                  className="block aspect-square w-full overflow-hidden rounded border bg-muted/30 text-left transition-shadow group-hover:border-muted-foreground/30 group-hover:shadow-sm"
                  onClick={() => openTab(buildAssetDetailTabForRecord(asset.id, asset.label))}
                  aria-label={`Open ${asset.label}`}
                >
                  {asset.data ? (
                    <AssetPreview
                      assetId={asset.id}
                      label={asset.label}
                      data={asset.data}
                      compact
                    />
                  ) : (
                    <span className="flex h-full items-center justify-center text-xs text-muted-foreground">
                      Invalid
                    </span>
                  )}
                </button>
                <div className="group/name relative flex h-6 min-w-0 items-center">
                  {editingAssetId === asset.id ? (
                    <div className="absolute inset-0 z-20 flex items-center gap-0.5 bg-background">
                      <input
                        autoFocus
                        className="h-6 min-w-0 flex-1 rounded border bg-background px-1.5 text-xs outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
                        value={editingName}
                        onChange={(event) => setEditingName(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') saveRename(asset);
                          if (event.key === 'Escape') cancelRename();
                        }}
                        aria-label={`Edit name for ${asset.label}`}
                      />
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        className="size-6 shrink-0"
                        onClick={cancelRename}
                        aria-label="Cancel asset name edit"
                      >
                        <X className="size-3.5" />
                      </Button>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="block min-w-0 flex-1 truncate px-0.5 text-left text-xs font-medium hover:text-foreground group-hover:pr-6"
                        onClick={() => openTab(buildAssetDetailTabForRecord(asset.id, asset.label))}
                        title={asset.label}
                      >
                        {asset.label}
                      </button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        className="invisible absolute right-0 top-1/2 z-10 size-6 -translate-y-1/2 opacity-0 transition-opacity group-hover:visible group-hover:opacity-100 focus-visible:visible focus-visible:opacity-100"
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          beginRename(asset);
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          beginRename(asset);
                        }}
                        aria-label={`Edit name for ${asset.label}`}
                      >
                        <Pencil className="size-3" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
        {assets.length === 0 ? (
          <div className="mt-3 rounded border p-3 text-sm text-muted-foreground">
            No assets match the current filter.
          </div>
        ) : null}
      </div>
      <AssetContextMenu
        state={contextMenu}
        projectFilePath={projectFilePath}
        onClose={() => setContextMenu(null)}
      />
    </div>
  );
}
