import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TagInput } from '@/components/tags/TagInput';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCommandStore } from '@/commands/command-store';
import type { CommandRequest } from '@/commands/command-types';
import { recordSaveUnitId, structuralSaveUnitId } from '@/project/save-unit-registry';
import { useAssetTrashStore } from '@/assets/asset-trash-store';
import {
  buildAssetAliasIndex,
  findAssetAliasUsages,
} from '../../../shared/project-schema/authoring-asset-references';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import {
  collectProjectTags,
  recordEditorMetadata,
} from '../../../shared/project-schema/authoring-tags';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import {
  buildReferenceIndex,
  findUsages,
} from '../../../shared/project-schema/authoring-references';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { buildImageGenerationTab, type WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  useWorkbenchEditorTabState,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';
import { AssetPreview } from './AssetPreview';

function lookupAsset(project: unknown, assetId: string | undefined) {
  if (!assetId || !isAuthoringProject(project)) return null;
  return project.assets[assetId] ?? null;
}

export function AssetEditor({ tab }: WorkbenchEditorProps) {
  const project = useProjectStore((state) => state.document);
  const projectFilePath = useProjectStore((state) => state.projectFilePath);
  const executeCommand = useCommandStore((state) => state.executeCommand);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const rememberDeletedAsset = useAssetTrashStore((state) => state.rememberDeletedAsset);
  const assetId = tab.resource?.entityId;
  const record = lookupAsset(project, assetId);
  const data = parseAssetData(record?.data);
  const [aliasDraft, setAliasDraft] = useState('');
  const [renameFrom, setRenameFrom] = useState('');
  const [renameTo, setRenameTo] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  useWorkbenchEditorTabState(
    tab.id,
    useMemo(
      () => ({
        captureTabState: (): WorkbenchTabStatePayload => ({
          schema: 'noveltea.editor.asset-detail-tab-state',
          schemaVersion: 1,
          payload: { aliasDraft, renameFrom, renameTo },
        }),
        restoreTabState: (state: WorkbenchTabStatePayload) => {
          if (
            state.schema !== 'noveltea.editor.asset-detail-tab-state' ||
            state.schemaVersion !== 1
          )
            return;
          const payload = state.payload;
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
          const values = payload as Record<string, unknown>;
          if (typeof values.aliasDraft === 'string') setAliasDraft(values.aliasDraft);
          if (typeof values.renameFrom === 'string') setRenameFrom(values.renameFrom);
          if (typeof values.renameTo === 'string') setRenameTo(values.renameTo);
        },
      }),
      [aliasDraft, renameFrom, renameTo],
    ),
  );

  const stableUsages = useMemo(() => {
    if (!assetId || !isAuthoringProject(project)) return [];
    return findUsages(buildReferenceIndex(project), { collection: 'assets', id: assetId }).filter(
      (usage) => !(usage.sourceCollection === 'assets' && usage.sourceId === assetId),
    );
  }, [assetId, project]);

  const aliasUsages = useMemo(() => {
    if (!data || !isAuthoringProject(project)) return [];
    const index = buildAssetAliasIndex(project);
    return data.aliases.flatMap((alias) => findAssetAliasUsages(index, alias));
  }, [data, project]);

  const recordTags = useMemo(
    () =>
      isAuthoringProject(project) && assetId
        ? recordEditorMetadata(project, 'assets', assetId).tags
        : [],
    [assetId, project],
  );
  const tagSuggestions = useMemo(() => {
    if (!isAuthoringProject(project)) return [];
    return collectProjectTags(project, recordTags);
  }, [project, recordTags]);

  if (!assetId || !record) {
    return <div className="p-4 text-sm text-muted-foreground">Asset record not found.</div>;
  }
  if (!data) {
    return (
      <div className="space-y-3 p-4 text-sm">
        <div className="font-medium">Invalid asset data</div>
        <p className="text-muted-foreground">
          Validation will report the malformed asset record. Use typed asset import or reimport to
          replace it.
        </p>
      </div>
    );
  }

  const assetData = data;

  function run(
    command: Omit<CommandRequest, 'originSaveUnitId' | 'persistencePolicy'>,
    attribution: Pick<CommandRequest, 'originSaveUnitId' | 'persistencePolicy'> = {
      originSaveUnitId: recordSaveUnitId('assets', assetId!),
      persistencePolicy: 'manual-save',
    },
  ) {
    const result = executeCommand({ ...command, ...attribution });
    const failure = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    setMessage(failure?.message ?? command.label ?? command.type);
    return result.ok && !failure;
  }

  function updateTags(tags: string[]) {
    run({
      type: 'entity.updateMetadata',
      label: `Update ${assetId} tags`,
      payload: { collection: 'assets', entityId: assetId, tags },
    });
  }

  async function reimport() {
    if (!projectFilePath) {
      setMessage('Save the project before reimporting assets.');
      return;
    }
    const result = await window.noveltea.reimportAsset(projectFilePath, assetData.source.path);
    if (!result.success || !result.asset) {
      setMessage(result.error ?? result.diagnostics[0]?.message ?? 'Asset reimport failed.');
      return;
    }
    run({
      type: 'asset.reimportFile',
      label: `Reimport ${assetId}`,
      payload: { assetId, asset: result.asset },
    });
  }

  function confirmDelete() {
    if (
      run(
        {
          type: 'asset.deleteAsset',
          label: `Delete ${assetId}`,
          payload: { assetId, force: true },
        },
        {
          originSaveUnitId: structuralSaveUnitId('assets'),
          persistencePolicy: 'auto-commit',
        },
      )
    ) {
      if (projectFilePath) {
        void window.noveltea
          .trashProjectAssetFiles(projectFilePath, [assetData.source.path])
          .then((trashResult) => {
            const move = trashResult.moved?.[0];
            if (move && assetId) rememberDeletedAsset({ assetId, projectFilePath, move });
          });
      }
      setDeleteDialogOpen(false);
    }
  }

  const deleteUsageCount = stableUsages.length + aliasUsages.length;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4">
      <div className="flex items-start gap-3" data-workbench-anchor="asset.summary">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{record.label}</h2>
            <Badge variant="outline">{assetId}</Badge>
            <Badge variant="secondary">{data.kind}</Badge>
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{data.source.path}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => openTab(buildImageGenerationTab())}>
          Generate Image
        </Button>
        {data.kind === 'image' ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              openTab(
                buildImageGenerationTab({
                  sourceAssetId: assetId,
                  sourceProjectRelativePath: data.source.path,
                  mode: 'edit',
                }),
              )
            }
          >
            Edit with ComfyUI
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => void reimport()}>
          Reimport
        </Button>
        <Button size="sm" variant="destructive" onClick={() => setDeleteDialogOpen(true)}>
          Delete
        </Button>
      </div>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogPopup>
          <DialogTitle>Delete asset?</DialogTitle>
          <DialogDescription>
            {deleteUsageCount > 0
              ? `This asset is referenced by ${deleteUsageCount} usage${deleteUsageCount === 1 ? '' : 's'}. Deleting it will leave missing references for validation to report.`
              : 'This asset has no known stable or alias usages.'}
          </DialogDescription>
          {deleteUsageCount > 0 ? (
            <div className="max-h-56 space-y-3 overflow-auto rounded border p-2 text-xs">
              {stableUsages.length > 0 ? (
                <div>
                  <div className="font-medium">Stable references</div>
                  <div className="mt-1 space-y-1 font-mono text-[10px] text-muted-foreground">
                    {stableUsages.map((usage, index) => (
                      <div key={`stable-${usage.path}-${index}`}>
                        {usage.kind}: {usage.sourceCollection}/{usage.sourceId} {usage.path}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {aliasUsages.length > 0 ? (
                <div>
                  <div className="font-medium">Alias references</div>
                  <div className="mt-1 space-y-1 font-mono text-[10px] text-muted-foreground">
                    {aliasUsages.map((usage, index) => (
                      <div key={`alias-${usage.path}-${index}`}>
                        {usage.alias}: {usage.sourceCollection}/{usage.sourceId} {usage.path}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="destructive" onClick={confirmDelete}>
              Delete Asset
            </Button>
          </div>
        </DialogPopup>
      </Dialog>

      {message ? (
        <div className="mt-3 rounded border p-2 text-xs text-muted-foreground">{message}</div>
      ) : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <section className="rounded border p-3" data-workbench-anchor="asset.tags">
            <h3 className="text-sm font-medium">Tags</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Tags are for user-facing organization and do not affect the asset type.
            </p>
            <div className="mt-3">
              <Label htmlFor="asset-tags">Asset tags</Label>
              <TagInput
                id="asset-tags"
                className="mt-1"
                value={recordTags}
                onChange={updateTags}
                suggestions={tagSuggestions}
                placeholder="Add tag"
              />
            </div>
          </section>

          <section className="rounded border p-3" data-workbench-anchor="asset.aliases">
            <h3 className="text-sm font-medium">Aliases</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {data.aliases.length === 0 ? (
                <span className="text-xs text-muted-foreground">No aliases assigned.</span>
              ) : null}
              {data.aliases.map((alias) => (
                <Badge key={alias} variant="outline" className="gap-2">
                  {alias}
                  <button
                    type="button"
                    onClick={() =>
                      run({
                        type: 'asset.removeAlias',
                        label: `Remove alias ${alias}`,
                        payload: { assetId, alias },
                      })
                    }
                  >
                    ×
                  </button>
                </Badge>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <Input
                value={aliasDraft}
                onChange={(event) => setAliasDraft(event.currentTarget.value)}
                placeholder="ui.click"
              />
              <Button
                size="sm"
                onClick={() => {
                  if (
                    run({
                      type: 'asset.assignAlias',
                      label: `Assign alias ${aliasDraft}`,
                      payload: { assetId, alias: aliasDraft.trim() },
                    })
                  )
                    setAliasDraft('');
                }}
              >
                Add
              </Button>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-[1fr_1fr_auto]">
              <Input
                value={renameFrom}
                onChange={(event) => setRenameFrom(event.currentTarget.value)}
                placeholder="old alias"
              />
              <Input
                value={renameTo}
                onChange={(event) => setRenameTo(event.currentTarget.value)}
                placeholder="new alias"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (
                    run({
                      type: 'asset.renameAlias',
                      label: `Rename alias ${renameFrom}`,
                      payload: { fromAlias: renameFrom.trim(), toAlias: renameTo.trim() },
                    })
                  ) {
                    setRenameFrom('');
                    setRenameTo('');
                  }
                }}
              >
                Rename
              </Button>
            </div>
          </section>

          <section className="rounded border p-3" data-workbench-anchor="asset.metadata">
            <h3 className="text-sm font-medium">Metadata</h3>
            <div className="mt-2 grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
              <div>
                <Label>Original name</Label>
                <div className="font-mono">{data.originalName ?? '—'}</div>
              </div>
              <div>
                <Label>Extension</Label>
                <div className="font-mono">{data.extension ?? '—'}</div>
              </div>
              <div>
                <Label>MIME</Label>
                <div className="font-mono">{data.mimeType ?? '—'}</div>
              </div>
              <div>
                <Label>Imported</Label>
                <div className="font-mono">{data.importedAt ?? '—'}</div>
              </div>
            </div>
          </section>

          <section className="rounded border p-3" data-workbench-anchor="asset.aliasUsages">
            <h3 className="text-sm font-medium">Alias usages</h3>
            {aliasUsages.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">No explicit alias usages found.</p>
            ) : null}
            <div className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">
              {aliasUsages.map((usage, index) => (
                <div key={`${usage.path}-${index}`}>
                  {usage.alias}: {usage.sourceCollection}/{usage.sourceId} {usage.path}
                </div>
              ))}
            </div>
          </section>
        </div>
        <AssetPreview assetId={assetId} label={record.label} data={data} />
      </div>
    </div>
  );
}
