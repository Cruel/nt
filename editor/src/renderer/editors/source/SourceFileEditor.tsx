import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EditorPreviewSplit } from '@/components/editor-preview-split';
import { SourceEditor } from '@/components/source/SourceEditor';
import { MaterialPreview } from '@/material-preview/MaterialPreview';
import { resolveMaterialPreviewAssetUrl } from '@/material-preview/material-preview-provider';
import {
  MaterialPreviewProjectResources,
  materialPreviewDefaultDecodeImage,
} from '@/material-preview/material-preview-resources';
import { useProjectSourceStore } from '@/project/project-source-store';
import { saveActiveSaveUnit } from '@/project/project-save-coordinator';
import { sourceSaveUnitId } from '@/project/save-unit-registry';
import { useProjectStore } from '@/project/project-store';
import {
  DebouncedShaderPreviewCompiler,
  discoverShaderSourceMaterialUsages,
  shaderSourceOverlays,
  shaderSourcePreviewAuthorityKey,
  type ShaderSourceMaterialUsage,
} from '@/shaders/shader-source-preview';
import {
  parseShaderSourceTabState,
  shaderSourceTabState,
  SHADER_SOURCE_TAB_STATE_SCHEMA,
} from '@/shaders/shader-source-tab-state';
import { useShaderCompileStore } from '@/shaders/shader-compile-store';
import { sourceFileLanguage } from '../../../shared/project-source-files';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import { buildMaterialDetailTabForRecord } from '@/workbench/editor-registry';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import {
  useWorkbenchEditorTabState,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';

function usageForMaterial(
  materialId: string,
  direct: readonly ShaderSourceMaterialUsage[],
  transitive: readonly ShaderSourceMaterialUsage[],
) {
  return (
    direct.find((usage) => usage.materialId === materialId) ??
    transitive.find((usage) => usage.materialId === materialId) ??
    null
  );
}

export function SourceFileEditor({ tab }: WorkbenchEditorProps) {
  const { t } = useTranslation('workspace');
  const files = useProjectSourceStore((state) => state.files);
  const textById = useProjectSourceStore((state) => state.textById);
  const buffersById = useProjectSourceStore((state) => state.buffersById);
  const setText = useProjectSourceStore((state) => state.setText);
  const acceptDisk = useProjectSourceStore((state) => state.useDisk);
  const projectDocument = useProjectStore((state) => state.document);
  const projectSessionId = useProjectStore((state) => state.projectSessionId);
  const projectInstanceId = useProjectStore((state) => state.projectInstanceId);
  const projectRevision = useProjectStore((state) => state.projectRevision);
  const setTabDirty = useWorkbenchStore((state) => state.setTabDirty);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const [saving, setSaving] = useState(false);
  const [attachedMaterialIds, setAttachedMaterialIds] = useState<string[]>([]);
  const [previewDiagnostics, setPreviewDiagnostics] = useState<
    readonly { severity: string; message: string }[]
  >([]);
  const restoredPreviewStateRef = useRef(false);
  const initializedPreviewSetRef = useRef(false);
  const sourceId = tab.resource?.sourceId ?? null;
  const source = useMemo(
    () => (sourceId ? (files.find((candidate) => candidate.id === sourceId) ?? null) : null),
    [files, sourceId],
  );
  const buffer = sourceId ? buffersById[sourceId] : undefined;
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const isShaderSource = source?.kind === 'shader';
  const usages = useMemo(
    () =>
      project && sourceId && isShaderSource
        ? discoverShaderSourceMaterialUsages(project, sourceId, textById)
        : { direct: [], transitive: [], affectedMaterialIds: [] },
    [isShaderSource, project, sourceId, textById],
  );

  useWorkbenchEditorTabState(
    tab.id,
    useMemo(
      () => ({
        schema: SHADER_SOURCE_TAB_STATE_SCHEMA,
        captureTabState: (): WorkbenchTabStatePayload => shaderSourceTabState(attachedMaterialIds),
        restoreTabState: (state: WorkbenchTabStatePayload) => {
          const restored = parseShaderSourceTabState(state);
          if (!restored) return;
          restoredPreviewStateRef.current = true;
          initializedPreviewSetRef.current = true;
          setAttachedMaterialIds(restored.materialIds);
        },
      }),
      [attachedMaterialIds],
    ),
  );

  useEffect(() => {
    if (!isShaderSource || !buffer || initializedPreviewSetRef.current) return;
    initializedPreviewSetRef.current = true;
    if (!restoredPreviewStateRef.current && usages.affectedMaterialIds.length === 1) {
      setAttachedMaterialIds([usages.affectedMaterialIds[0]!]);
    }
  }, [buffer, isShaderSource, usages.affectedMaterialIds]);

  useEffect(() => {
    if (!project || !sourceId || !isShaderSource) return;
    setAttachedMaterialIds((current) =>
      current.filter((materialId) => usages.affectedMaterialIds.includes(materialId)),
    );
  }, [isShaderSource, project, sourceId, usages.affectedMaterialIds]);

  const debouncedCompilerRef = useRef<DebouncedShaderPreviewCompiler<
    Awaited<ReturnType<ReturnType<typeof useShaderCompileStore.getState>['runCompile']>>
  > | null>(null);
  if (!debouncedCompilerRef.current)
    debouncedCompilerRef.current = new DebouncedShaderPreviewCompiler(180);
  const localResourcesRef = useRef<MaterialPreviewProjectResources | null>(null);
  if (!localResourcesRef.current) {
    localResourcesRef.current = new MaterialPreviewProjectResources({
      compileShaders: (compilation, options) =>
        debouncedCompilerRef.current!.run(async () => {
          const response = await useShaderCompileStore
            .getState()
            .runCompile(compilation, undefined, {
              shaderVariants: ['essl-300'],
              sourceOverlays: options?.sourceOverlays ? { ...options.sourceOverlays } : undefined,
            });
          setPreviewDiagnostics(response.diagnostics);
          return response;
        }),
      resolveAssetUrl: resolveMaterialPreviewAssetUrl,
      decodeImage: materialPreviewDefaultDecodeImage,
    });
  }
  const localResources = localResourcesRef.current;
  const overlays = useMemo(() => shaderSourceOverlays(files, buffersById), [buffersById, files]);
  const previewAuthorityKey = useMemo(
    () =>
      `${projectInstanceId ?? projectSessionId ?? 'none'}:${projectRevision}|${shaderSourcePreviewAuthorityKey(
        attachedMaterialIds,
        overlays,
        files,
      )}`,
    [attachedMaterialIds, files, overlays, projectInstanceId, projectRevision, projectSessionId],
  );
  localResources.updateProject(project, previewAuthorityKey, {
    materialIds: attachedMaterialIds,
    sourceOverlays: overlays,
    scopeKey: projectSessionId,
  });

  useEffect(
    () => () => {
      debouncedCompilerRef.current?.dispose();
    },
    [],
  );

  useEffect(() => {
    setTabDirty(tab.id, Boolean(buffer?.dirty));
    return () => setTabDirty(tab.id, false);
  }, [buffer?.dirty, setTabDirty, tab.id]);

  if (!sourceId || !source)
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Source file is no longer available.
      </div>
    );
  if (!source.text || !buffer)
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        This file is not a text source.
      </div>
    );

  async function saveBuffer(acceptExternalBase = false) {
    setSaving(true);
    try {
      await saveActiveSaveUnit(sourceSaveUnitId(sourceId!), {
        acceptExternalSourceBase: acceptExternalBase,
      });
    } finally {
      setSaving(false);
    }
  }

  const sourceBody = (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {source.displayPath}
        </span>
        {isShaderSource ? (
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex h-7 items-center justify-center rounded-md px-3 text-xs font-medium hover:bg-accent hover:text-accent-foreground">
              {t('shaderSourcePreview.affectedUsage', { count: usages.affectedMaterialIds.length })}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t('shaderSourcePreview.affectedMaterials')}</DropdownMenuLabel>
                {usages.affectedMaterialIds.length === 0 ? (
                  <DropdownMenuItem disabled>
                    {t('shaderSourcePreview.noAffectedMaterials')}
                  </DropdownMenuItem>
                ) : (
                  usages.affectedMaterialIds.map((materialId) => (
                    <DropdownMenuItem
                      key={materialId}
                      onClick={() =>
                        openTab(
                          buildMaterialDetailTabForRecord(
                            materialId,
                            project?.materials[materialId]?.label ?? materialId,
                          ),
                        )
                      }
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {project?.materials[materialId]?.label ?? materialId}
                      </span>
                      <span className="ml-2 text-[10px] text-muted-foreground">
                        {usageForMaterial(materialId, usages.direct, usages.transitive)?.kind ===
                        'direct'
                          ? t('shaderSourcePreview.direct')
                          : t('shaderSourcePreview.included')}
                      </span>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {buffer.dirty ? <span className="text-[10px] text-muted-foreground">Modified</span> : null}
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          disabled={!buffer.dirty || saving || Boolean(buffer.conflict)}
          onClick={() => void saveBuffer()}
        >
          Save
        </Button>
      </div>
      {buffer.conflict ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">
            {buffer.conflict.externalExists
              ? 'This source changed outside NovelTea while this tab had unsaved edits.'
              : 'This source was deleted outside NovelTea while this tab had unsaved edits.'}
          </span>
          <Button size="sm" variant="outline" className="h-7" onClick={() => acceptDisk(sourceId)}>
            Use Disk
          </Button>
          <Button size="sm" className="h-7" disabled={saving} onClick={() => void saveBuffer(true)}>
            Keep Mine
          </Button>
        </div>
      ) : null}
      <SourceEditor
        value={buffer.text}
        onChange={(text) => setText(sourceId, text)}
        language={sourceFileLanguage(source)}
        className="min-h-0 flex-1"
      />
    </div>
  );

  if (!isShaderSource) return sourceBody;

  const unattachedDirect = usages.direct.filter(
    (usage) => !attachedMaterialIds.includes(usage.materialId),
  );
  const unattachedTransitive = usages.transitive.filter(
    (usage) => !attachedMaterialIds.includes(usage.materialId),
  );
  const addMaterial = (materialId: string) =>
    setAttachedMaterialIds((current) =>
      current.includes(materialId) ? current : [...current, materialId],
    );
  const preview = (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <span className="min-w-0 flex-1 text-xs font-medium">{t('shaderSourcePreview.title')}</span>
        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex h-7 items-center justify-center rounded-md border border-input bg-background px-3 text-xs font-medium hover:bg-accent hover:text-accent-foreground">
            {t('shaderSourcePreview.addPreview')}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {unattachedDirect.length > 0 ? (
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t('shaderSourcePreview.directConsumers')}</DropdownMenuLabel>
                {unattachedDirect.map((usage) => (
                  <DropdownMenuItem
                    key={`direct:${usage.materialId}:${usage.stage}`}
                    onClick={() => addMaterial(usage.materialId)}
                  >
                    {project?.materials[usage.materialId]?.label ?? usage.materialId}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ) : null}
            {unattachedDirect.length > 0 && unattachedTransitive.length > 0 ? (
              <DropdownMenuSeparator />
            ) : null}
            {unattachedTransitive.length > 0 ? (
              <DropdownMenuGroup>
                <DropdownMenuLabel>
                  {t('shaderSourcePreview.transitiveConsumers')}
                </DropdownMenuLabel>
                {unattachedTransitive.map((usage) => (
                  <DropdownMenuItem
                    key={`included:${usage.materialId}:${usage.stage}`}
                    onClick={() => addMaterial(usage.materialId)}
                  >
                    {project?.materials[usage.materialId]?.label ?? usage.materialId}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ) : null}
            {unattachedDirect.length === 0 && unattachedTransitive.length === 0 ? (
              <DropdownMenuItem disabled>
                {t('shaderSourcePreview.noPreviewsToAdd')}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {attachedMaterialIds.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
          {t('shaderSourcePreview.empty')}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 auto-rows-[minmax(220px,1fr)] grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2 overflow-auto p-2">
          {attachedMaterialIds.map((materialId) => {
            const usage = usageForMaterial(materialId, usages.direct, usages.transitive);
            return (
              <div
                key={materialId}
                className="flex min-h-[220px] min-w-0 flex-col overflow-hidden rounded border"
              >
                <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1.5 text-xs">
                  <button
                    className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                    onClick={() =>
                      openTab(
                        buildMaterialDetailTabForRecord(
                          materialId,
                          project?.materials[materialId]?.label ?? materialId,
                        ),
                      )
                    }
                  >
                    {project?.materials[materialId]?.label ?? materialId}
                  </button>
                  <span className="text-[10px] text-muted-foreground">
                    {usage?.kind === 'direct'
                      ? t('shaderSourcePreview.direct')
                      : t('shaderSourcePreview.included')}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2"
                    onClick={() =>
                      setAttachedMaterialIds((current) =>
                        current.filter((candidate) => candidate !== materialId),
                      )
                    }
                  >
                    {t('shaderSourcePreview.remove')}
                  </Button>
                </div>
                <MaterialPreview
                  materialId={materialId}
                  resources={localResources}
                  className="min-h-0 flex-1"
                />
              </div>
            );
          })}
        </div>
      )}
      {previewDiagnostics.length > 0 ? (
        <div className="max-h-28 shrink-0 overflow-auto border-t bg-muted/30 px-3 py-2 text-[11px]">
          {previewDiagnostics.map((diagnostic, index) => (
            <div key={`${diagnostic.message}:${index}`} className="truncate">
              <span className="mr-2 uppercase text-muted-foreground">{diagnostic.severity}</span>
              {diagnostic.message}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );

  return (
    <EditorPreviewSplit preview={preview} resizeLabel={t('shaderSourcePreview.resize')}>
      {sourceBody}
    </EditorPreviewSplit>
  );
}
