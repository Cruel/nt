import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createEditorFormatters } from '@/i18n/formatting';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { recordSaveUnitId, structuralSaveUnitId } from '@/project/save-unit-registry';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { buildAssetDetailTabForRecord } from '@/workbench/editor-registry';
import {
  assetAttachmentPatches,
  attachmentUsages,
} from '../../../shared/project-schema/authoring-asset-attachments';
import {
  assetAttachmentPurposeValues,
  isSafeProjectAttachmentPath,
  parseAssetData,
  type AssetAttachment,
  type AssetAttachmentPurpose,
} from '../../../shared/project-schema/authoring-assets';
import {
  isAuthoringProject,
  type AuthoringProject,
} from '../../../shared/project-schema/authoring-project';
import type {
  ProjectAttachmentFileInfo,
  ProjectAttachmentInspection,
} from '../../../shared/project-asset-attachments';

interface Props {
  assetId: string;
  project: AuthoringProject;
  projectSessionId: string | null;
}

export function AssetAttachments({ assetId, project, projectSessionId }: Props) {
  const { t, i18n } = useTranslation('workspace');
  const format = createEditorFormatters(i18n.language);
  const executeCommand = useCommandStore((state) => state.executeCommand);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const assetData = useMemo(
    () => parseAssetData(project.assets[assetId]?.data),
    [project.assets, assetId],
  );
  const attachments = useMemo(() => assetData?.attachments ?? [], [assetData]);
  const [files, setFiles] = useState<ProjectAttachmentFileInfo[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [purpose, setPurpose] = useState<AssetAttachmentPurpose>('reference');
  const [relativePath, setRelativePath] = useState('');
  const [destinationDirectory, setDestinationDirectory] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [editPath, setEditPath] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [movePath, setMovePath] = useState<string | null>(null);
  const [moveValue, setMoveValue] = useState('');
  const [nameEdits, setNameEdits] = useState<Record<string, string>>({});
  const [inspections, setInspections] = useState<Record<string, ProjectAttachmentInspection>>({});
  const assetSourcePath = assetData?.source.path;
  const assetRevision = assetSourcePath
    ? (inspections[assetSourcePath]?.contentHash ??
      (/^sha256:[0-9a-f]{64}$/u.test(assetData?.contentHash ?? '')
        ? (assetData?.contentHash as `sha256:${string}`)
        : undefined))
    : undefined;
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [sharePath, setSharePath] = useState<string | null>(null);
  const [shareTargets, setShareTargets] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    if (!projectSessionId) return;
    try {
      const result = await window.noveltea.listProjectAttachmentFiles(projectSessionId);
      setFiles(result.files);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t('assetAttachments.unavailable'));
    }
  }, [projectSessionId, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!projectSessionId) return;
    let active = true;
    const check = async () => {
      const results = await Promise.all(
        [
          ...new Set([
            ...attachments.map((item) => item.path),
            ...(assetSourcePath && isSafeProjectAttachmentPath(assetSourcePath)
              ? [assetSourcePath]
              : []),
          ]),
        ].map((filePath) =>
          window.noveltea
            .inspectProjectAttachmentFile(projectSessionId, filePath)
            .catch((error) => ({
              path: filePath,
              exists: false,
              error: String(error),
            })),
        ),
      );
      if (active) setInspections(Object.fromEntries(results.map((value) => [value.path, value])));
    };
    void check();
    const stop = window.noveltea.onProjectWorkspaceChanged((event) => {
      if (event.projectSessionId === projectSessionId) {
        void check();
        void refresh();
      }
    });
    return () => {
      active = false;
      stop();
    };
  }, [attachments, assetSourcePath, projectSessionId, refresh]);

  const availableAssets = useMemo(
    () =>
      Object.entries(project.assets)
        .filter(([id]) => id !== assetId)
        .map(([id, record]) => ({ id, label: record.label })),
    [project, assetId],
  );

  async function freshAssetRevision(): Promise<`sha256:${string}` | undefined> {
    if (!projectSessionId || !assetSourcePath || !isSafeProjectAttachmentPath(assetSourcePath))
      return assetRevision;
    const inspected = await window.noveltea.inspectProjectAttachmentFile(
      projectSessionId,
      assetSourcePath,
    );
    return inspected.contentHash;
  }

  async function acknowledgeSourceRevision(item: AssetAttachment) {
    if (!projectSessionId) return;
    const inspected = await window.noveltea.inspectProjectAttachmentFile(
      projectSessionId,
      item.path,
    );
    if (!inspected.contentHash) {
      setStatus(inspected.error ?? t('assetAttachments.missing'));
      return;
    }
    const assetHash = await freshAssetRevision();
    apply(
      [assetId],
      {
        kind: 'replace',
        attachment: {
          ...item,
          sourceBaselineHash: inspected.contentHash,
          ...(assetHash ? { assetBaselineHash: assetHash } : {}),
        },
      },
      t('assetAttachments.history.acknowledgeSource'),
    );
  }

  function apply(
    ids: string[],
    change: { kind: 'add' | 'remove' | 'replace'; attachment: AssetAttachment; priorPath?: string },
    label: string,
    assetRevisionsById: Readonly<Record<string, string>> = {},
  ): boolean {
    try {
      const current = useProjectStore.getState();
      if (current.projectSessionId !== projectSessionId || !isAuthoringProject(current.document)) {
        setStatus(t('assetAttachments.sessionChanged'));
        return false;
      }
      const patches = assetAttachmentPatches(current.document, ids, change, assetRevisionsById);
      if (!patches.length) {
        setStatus(t('assetAttachments.alreadyAttached'));
        return false;
      }
      const result = executeCommand({
        type: 'project.applyPatch',
        label,
        payload: patches,
        originSaveUnitId:
          ids.length > 1 ? structuralSaveUnitId('assets') : recordSaveUnitId('assets', ids[0]),
        persistencePolicy: 'manual-save',
      });
      const error = result.diagnostics.find((item) => item.severity === 'error');
      setStatus(
        error?.message ??
          (result.ok ? t('assetAttachments.updated') : t('assetAttachments.failed')),
      );
      return result.ok && !error;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t('assetAttachments.failed'));
      return false;
    }
  }

  async function addExisting() {
    if (!projectSessionId) return;
    if (!isSafeProjectAttachmentPath(relativePath)) {
      setStatus(t('assetAttachments.invalidPath'));
      return;
    }
    const inspected = await window.noveltea.inspectProjectAttachmentFile(
      projectSessionId,
      relativePath,
    );
    if (!inspected.exists) {
      setStatus(inspected.error ?? t('assetAttachments.missing'));
      return;
    }
    const assetHash = purpose === 'authoring-source' ? await freshAssetRevision() : undefined;
    if (
      apply(
        [assetId],
        {
          kind: 'add',
          attachment: {
            path: relativePath,
            purpose,
            ...(purpose === 'authoring-source' && inspected.contentHash
              ? {
                  sourceBaselineHash: inspected.contentHash,
                  ...(assetHash ? { assetBaselineHash: assetHash } : {}),
                }
              : {}),
            ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
          },
        },
        t('assetAttachments.history.attachExisting'),
      )
    ) {
      setRelativePath('');
      setDisplayName('');
    }
  }

  async function importFiles() {
    if (!projectSessionId) return;
    const initialProjectInstanceId = useProjectStore.getState().projectInstanceId;
    const importPurpose = purpose;
    setBusy(true);
    try {
      const result = await window.noveltea.importProjectAttachmentFiles({
        projectSessionId,
        purpose: importPurpose,
        ...(destinationDirectory.trim()
          ? { destinationDirectory: destinationDirectory.trim() }
          : {}),
      });
      if (result.error) {
        setStatus(result.error);
        return;
      }
      if (result.canceled || !result.paths.length) return;
      const latest = useProjectStore.getState();
      if (
        latest.projectSessionId !== projectSessionId ||
        latest.projectInstanceId !== initialProjectInstanceId ||
        !isAuthoringProject(latest.document)
      ) {
        setStatus(t('assetAttachments.sessionChanged'));
        return;
      }
      // One command for the entire selection, so undo removes associations together, not files.
      const record = latest.document.assets[assetId];
      const liveAttachments = record && parseAssetData(record.data)?.attachments;
      if (!record || !liveAttachments) {
        setStatus(t('assetAttachments.sessionChanged'));
        return;
      }
      const current = new Set(liveAttachments.map((item) => item.path));
      const items = [...new Set(result.paths)].filter((value) => !current.has(value));
      if (items.length) {
        const assetHash =
          importPurpose === 'authoring-source' ? await freshAssetRevision() : undefined;
        const sourceInspections =
          importPurpose === 'authoring-source'
            ? await Promise.all(
                items.map((filePath) =>
                  window.noveltea.inspectProjectAttachmentFile(projectSessionId, filePath),
                ),
              )
            : [];
        const sourceHashes = new Map(
          sourceInspections.map((value) => [value.path, value.contentHash]),
        );
        const next = [
          ...liveAttachments,
          ...items.map((filePath) => ({
            path: filePath,
            purpose: importPurpose,
            ...(sourceHashes.get(filePath)
              ? { sourceBaselineHash: sourceHashes.get(filePath) }
              : {}),
            ...(assetHash ? { assetBaselineHash: assetHash } : {}),
          })),
        ];
        const response = executeCommand({
          type: 'project.applyPatch',
          label: t('assetAttachments.importFiles'),
          payload: [
            {
              op: Object.hasOwn(record.data as object, 'attachments') ? 'replace' : 'add',
              path: `/assets/${assetId}/data/attachments`,
              value: next,
            },
          ],
          originSaveUnitId: recordSaveUnitId('assets', assetId),
          persistencePolicy: 'manual-save',
        });
        setStatus(
          response.ok
            ? t('assetAttachments.imported', { count: items.length })
            : (response.diagnostics[0]?.message ?? t('assetAttachments.failed')),
        );
      }
      await refresh();
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function relink(item: AssetAttachment) {
    if (!projectSessionId || !isSafeProjectAttachmentPath(editValue)) {
      setStatus(t('assetAttachments.invalidPath'));
      return;
    }
    const check = await window.noveltea.inspectProjectAttachmentFile(projectSessionId, editValue);
    if (!check.exists) {
      setStatus(check.error ?? t('assetAttachments.missing'));
      return;
    }
    if (
      apply(
        [assetId],
        {
          kind: 'replace',
          attachment: {
            ...item,
            path: editValue,
            ...(editValue !== item.path
              ? {
                  sourceBaselineHash:
                    item.purpose === 'authoring-source' ? check.contentHash : undefined,
                  assetBaselineHash:
                    item.purpose === 'authoring-source' ? assetRevision : undefined,
                }
              : {}),
          },
          priorPath: item.path,
        },
        t('assetAttachments.history.relink'),
      )
    ) {
      setEditPath(null);
      setEditValue('');
    }
  }

  async function moveFile(item: AssetAttachment) {
    if (!projectSessionId || !isSafeProjectAttachmentPath(moveValue)) {
      setStatus(t('assetAttachments.invalidPath'));
      return;
    }
    const store = useProjectStore.getState();
    const originalInstanceId = store.projectInstanceId;
    const saved = store.savedDocument;
    if (
      store.projectSessionId !== projectSessionId ||
      useCommandStore.getState().persistencePending ||
      useCommandStore.getState().history.activeTransaction
    ) {
      setStatus(t('assetAttachments.saveBeforeMove'));
      return;
    }
    if (
      !isAuthoringProject(saved) ||
      !isAuthoringProject(store.document) ||
      Object.entries(store.document.assets).some(([id, asset]) => {
        const current = parseAssetData(asset.data);
        const baseline = parseAssetData(saved.assets[id]?.data);
        return (
          JSON.stringify(current?.attachments) !== JSON.stringify(baseline?.attachments) ||
          current?.source.path !== baseline?.source.path
        );
      })
    ) {
      setStatus(t('assetAttachments.saveBeforeMove'));
      return;
    }
    setBusy(true);
    try {
      const result = await window.noveltea.mutateProjectSources({
        projectSessionId,
        operation: { kind: 'move-attachment', fromPath: item.path, toPath: moveValue },
      });
      if (!result.success) {
        setStatus(result.error ?? t('assetAttachments.failed'));
        return;
      }
      if (
        useProjectStore.getState().projectSessionId !== projectSessionId ||
        useProjectStore.getState().projectInstanceId !== originalInstanceId
      )
        return;
      if (result.pathRemap) {
        if (useProjectStore.getState().applyCommittedSourcePathRemap(result.pathRemap))
          useCommandStore.getState().invalidateHistoryAfterCommittedFileMove();
      }
      setMovePath(null);
      setMoveValue('');
      setStatus(t('assetAttachments.updated'));
      await refresh();
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function openFile(item: AssetAttachment, action: 'open' | 'reveal') {
    if (!projectSessionId) return;
    try {
      await window.noveltea.openProjectAttachmentFile(projectSessionId, item.path, action);
    } catch (error) {
      setStatus(String(error));
    }
  }

  async function bulkAttach() {
    const item = attachments.find((attachment) => attachment.path === sharePath);
    if (!item || !shareTargets.length || !projectSessionId) return;
    const latest =
      item.purpose === 'authoring-source'
        ? await window.noveltea.inspectProjectAttachmentFile(projectSessionId, item.path)
        : null;
    if (latest && !latest.exists) {
      setStatus(latest.error ?? t('assetAttachments.missing'));
      return;
    }
    const liveProject = useProjectStore.getState().document;
    if (!isAuthoringProject(liveProject)) return;
    const assetRevisionsById = Object.fromEntries(
      (
        await Promise.all(
          shareTargets.map(async (id) => {
            const sourcePath = parseAssetData(liveProject.assets[id]?.data)?.source.path;
            if (!sourcePath || !isSafeProjectAttachmentPath(sourcePath)) return null;
            const inspected = await window.noveltea.inspectProjectAttachmentFile(
              projectSessionId,
              sourcePath,
            );
            return inspected.contentHash ? ([id, inspected.contentHash] as const) : null;
          }),
        )
      ).filter((value): value is readonly [string, `sha256:${string}`] => value !== null),
    );
    if (
      apply(
        shareTargets,
        {
          kind: 'add',
          attachment: latest?.contentHash
            ? { ...item, sourceBaselineHash: latest.contentHash, assetBaselineHash: undefined }
            : item,
        },
        t('assetAttachments.history.share'),
        assetRevisionsById,
      )
    ) {
      setSharePath(null);
      setShareTargets([]);
    }
  }

  const categories = assetAttachmentPurposeValues.map((value) => ({
    value,
    label: t(`assetAttachments.purposes.${value}`),
    items: attachments.filter((attachment) => attachment.purpose === value),
  }));

  return (
    <section className="space-y-3 rounded border p-3" data-workbench-anchor="asset.attachments">
      <h3 className="text-sm font-medium">{t('assetAttachments.title')}</h3>
      <p className="text-xs text-muted-foreground">{t('assetAttachments.description')}</p>
      <div className="grid gap-2 @xl:grid-cols-2">
        <div>
          <Label>{t('assetAttachments.purpose')}</Label>
          <Select
            value={purpose}
            onValueChange={(value) => setPurpose(value as AssetAttachmentPurpose)}
          >
            {categories.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="attachment-destination">{t('assetAttachments.destination')}</Label>
          <Input
            id="attachment-destination"
            placeholder="support/references"
            value={destinationDirectory}
            onChange={(event) => setDestinationDirectory(event.target.value)}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="attachment-existing">{t('assetAttachments.existing')}</Label>
        <Input
          id="attachment-existing"
          list="project-attachment-files"
          value={relativePath}
          onChange={(event) => setRelativePath(event.target.value)}
          placeholder="support/references/example.md"
        />
        <datalist id="project-attachment-files">
          {files
            .filter((file) => file.path.toLowerCase().includes(relativePath.toLowerCase()))
            .slice(0, 100)
            .map((file) => (
              <option key={file.path} value={file.path} />
            ))}
        </datalist>
        <Input
          aria-label={t('assetAttachments.displayName')}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder={t('assetAttachments.displayName')}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!projectSessionId || busy}
            onClick={() => void addExisting()}
          >
            {t('assetAttachments.attachExisting')}
          </Button>
          <Button size="sm" disabled={!projectSessionId || busy} onClick={() => void importFiles()}>
            {t('assetAttachments.importFiles')}
          </Button>
        </div>
      </div>
      {categories.map((category) =>
        category.items.length ? (
          <div key={category.value} className="space-y-2">
            <h4 className="text-xs font-semibold">{category.label}</h4>
            {category.items.map((item) => {
              const usage = attachmentUsages(project, item.path);
              const check = inspections[item.path];
              return (
                <div
                  key={item.path}
                  className="space-y-2 rounded border p-2 text-xs"
                  data-workbench-anchor={`asset.attachment.${encodeURIComponent(item.path)}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 break-all font-mono">
                      {item.displayName || item.path}
                    </span>
                    {check && !check.exists ? (
                      <span className="text-destructive">{t('assetAttachments.missing')}</span>
                    ) : null}
                    {check?.exists && typeof check.byteSize === 'number' ? (
                      <span className="text-muted-foreground">
                        {format.fileSize(check.byteSize)}
                      </span>
                    ) : null}
                    {item.purpose === 'authoring-source' &&
                    check?.contentHash &&
                    item.sourceBaselineHash !== check.contentHash ? (
                      <span className="text-amber-600">
                        {item.sourceBaselineHash
                          ? t('assetAttachments.possiblyOutdated')
                          : t('assetAttachments.sourceBaselineMissing')}
                      </span>
                    ) : null}
                  </div>
                  {item.displayName ? (
                    <p className="break-all font-mono text-muted-foreground">{item.path}</p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    {item.purpose === 'authoring-source' &&
                    check?.contentHash &&
                    item.sourceBaselineHash !== check.contentHash ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void acknowledgeSourceRevision(item)}
                      >
                        {t('assetAttachments.acknowledgeSource')}
                      </Button>
                    ) : null}
                    <Select
                      value={item.purpose}
                      onValueChange={(value) =>
                        apply(
                          [assetId],
                          {
                            kind: 'replace',
                            attachment: {
                              ...item,
                              purpose: value as AssetAttachmentPurpose,
                              ...(value !== 'authoring-source'
                                ? { sourceBaselineHash: undefined, assetBaselineHash: undefined }
                                : {
                                    sourceBaselineHash: inspections[item.path]?.contentHash,
                                    assetBaselineHash: assetRevision,
                                  }),
                            },
                          },
                          t('assetAttachments.history.changePurpose'),
                        )
                      }
                    >
                      {categories.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </Select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!check?.exists}
                      onClick={() => void openFile(item, 'open')}
                    >
                      {t('assetAttachments.open')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!check?.exists}
                      onClick={() => void openFile(item, 'reveal')}
                    >
                      {t('assetAttachments.reveal')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setPreviewPath(previewPath === item.path ? null : item.path)}
                    >
                      {t('assetAttachments.preview')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditPath(item.path);
                        setEditValue(item.path);
                      }}
                    >
                      {t('assetAttachments.relink')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setMovePath(item.path);
                        setMoveValue(item.path);
                      }}
                    >
                      {t('assetAttachments.move')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        apply(
                          [assetId],
                          { kind: 'remove', attachment: item },
                          t('assetAttachments.history.remove'),
                        )
                      }
                    >
                      {t('assetAttachments.remove')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setSharePath(item.path);
                        setShareTargets([]);
                      }}
                    >
                      {t('assetAttachments.share')}
                    </Button>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      aria-label={t('assetAttachments.editName', { path: item.path })}
                      placeholder={t('assetAttachments.displayName')}
                      value={nameEdits[item.path] ?? item.displayName ?? ''}
                      onChange={(event) =>
                        setNameEdits((state) => ({ ...state, [item.path]: event.target.value }))
                      }
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const name = (nameEdits[item.path] ?? '').trim();
                        apply(
                          [assetId],
                          {
                            kind: 'replace',
                            attachment: {
                              path: item.path,
                              purpose: item.purpose,
                              ...(name ? { displayName: name } : {}),
                            },
                          },
                          t('assetAttachments.history.rename'),
                        );
                      }}
                    >
                      {t('assetAttachments.saveName')}
                    </Button>
                  </div>
                  {editPath === item.path ? (
                    <div className="flex gap-2">
                      <Input
                        aria-label={t('assetAttachments.newPath')}
                        value={editValue}
                        onChange={(event) => setEditValue(event.target.value)}
                      />
                      <Button size="sm" onClick={() => void relink(item)}>
                        {t('assetAttachments.relink')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditPath(null)}>
                        {t('assetAttachments.cancel')}
                      </Button>
                    </div>
                  ) : null}
                  {movePath === item.path ? (
                    <div className="flex gap-2">
                      <Input
                        aria-label={t('assetAttachments.moveDestination')}
                        value={moveValue}
                        onChange={(event) => setMoveValue(event.target.value)}
                      />
                      <Button
                        size="sm"
                        disabled={busy || moveValue === item.path}
                        onClick={() => void moveFile(item)}
                      >
                        {t('assetAttachments.confirmMove')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setMovePath(null)}>
                        {t('assetAttachments.cancel')}
                      </Button>
                    </div>
                  ) : null}
                  {previewPath === item.path ? (
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2">
                      {check?.preview ?? t('assetAttachments.noPreview')}
                      {check?.previewLimited ? `\n${t('assetAttachments.previewLimited')}` : ''}
                    </pre>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                    <span>{t('assetAttachments.usedBy', { count: usage.length })}</span>
                    {usage.map((related) => (
                      <button
                        key={related.assetId}
                        type="button"
                        className="underline"
                        onClick={() =>
                          openTab(buildAssetDetailTabForRecord(related.assetId, related.label))
                        }
                      >
                        {related.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null,
      )}
      {attachments.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('assetAttachments.empty')}</p>
      ) : null}
      {sharePath ? (
        <div className="space-y-2 rounded border p-2 text-xs">
          <h4 className="font-medium">{t('assetAttachments.shareTitle', { path: sharePath })}</h4>
          {availableAssets
            .filter(
              (asset) =>
                !attachmentUsages(project, sharePath).some((usage) => usage.assetId === asset.id),
            )
            .map((asset) => (
              <label key={asset.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={shareTargets.includes(asset.id)}
                  onChange={(event) =>
                    setShareTargets((current) =>
                      event.target.checked
                        ? [...current, asset.id]
                        : current.filter((value) => value !== asset.id),
                    )
                  }
                />
                {asset.label}
              </label>
            ))}
          <Button size="sm" disabled={!shareTargets.length} onClick={bulkAttach}>
            {t('assetAttachments.attachSelected')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSharePath(null)}>
            {t('assetAttachments.cancel')}
          </Button>
        </div>
      ) : null}
      {status ? (
        <p role="status" className="text-xs text-muted-foreground">
          {status}
        </p>
      ) : null}
    </section>
  );
}
