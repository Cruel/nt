import { useCallback, useEffect, useMemo, useState } from 'react';
import { Group, Panel, Separator as ResizeSeparator } from 'react-resizable-panels';
import { EnginePreview } from '@/components/engine-preview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SourceEditor } from '@/components/source/SourceEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import { restoredDraftPayload, useEditorDraftDirty, useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import {
  defaultLayoutData,
  getDefaultLayoutSetting,
  layoutKindValues,
  layoutPreviewBackgroundValues,
  layoutSourceModeValues,
  layoutTargetValues,
  parseLayoutData,
  validateLayoutData,
  type LayoutAssetRef,
  type LayoutData,
  type LayoutMaterialRef,
  type LayoutSourceData,
} from '../../../shared/project-schema/authoring-layouts';
import { isAuthoringProject, type AuthoringProject } from '../../../shared/project-schema/authoring-project';
import { parseMaterialData } from '../../../shared/project-schema/authoring-materials';
import { buildLayoutPreviewDocumentData, layoutPreviewRevision } from '../../../shared/project-schema/layout-project';

function assetRef(assetId: string): LayoutAssetRef {
  return { $ref: { collection: 'assets', id: assetId } };
}

function materialRef(materialId: string): LayoutMaterialRef {
  return { $ref: { collection: 'materials', id: materialId } };
}

const LAYOUT_SOURCE_DRAFT_SCHEMA = 'noveltea.editor.draft.layout-sources';
const LAYOUT_SAMPLE_STATE_DRAFT_SCHEMA = 'noveltea.editor.draft.layout-sample-state';

function sourceWithDraft(source: LayoutSourceData, sourceText: string): LayoutSourceData {
  return { ...source, sourceText };
}

function refIds<T extends { $ref: { id: string } }>(refs: T[]): string[] {
  return refs.map((ref) => ref.$ref.id);
}

function toggleRef<T extends { $ref: { id: string } }>(refs: T[], ref: T): T[] {
  const id = ref.$ref.id;
  return refs.some((item) => item.$ref.id === id) ? refs.filter((item) => item.$ref.id !== id) : [...refs, ref];
}

function parseSampleState(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return { ok: true, value: value as Record<string, unknown> };
    return { ok: false, message: 'Sample state must be a JSON object.' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Invalid sample state JSON.' };
  }
}

function updateLayout(layoutId: string, next: LayoutData, label: string) {
  return useCommandStore.getState().executeCommand({
    type: 'layout.replaceData',
    label,
    payload: { layoutId, data: next },
  });
}

function selectableAssets(project: AuthoringProject, predicate: (kind: string | null, extension: string | null) => boolean) {
  return Object.entries(project.assets)
    .map(([id, record]) => {
      const data = parseAssetData(record.data);
      return { id, label: record.label, kind: data?.kind ?? null, extension: data?.extension?.toLowerCase() ?? null };
    })
    .filter((asset) => predicate(asset.kind, asset.extension));
}

function DependencySelector({
  title,
  options,
  selectedIds,
  onToggle,
}: {
  title: string;
  options: Array<{ id: string; label: string; detail?: string | null }>;
  selectedIds: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="space-y-2 rounded border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <Badge variant="outline">{selectedIds.length}</Badge>
      </div>
      {options.length === 0 ? <p className="text-xs text-muted-foreground">No matching records yet.</p> : null}
      <div className="flex max-h-32 flex-wrap gap-2 overflow-auto">
        {options.map((option) => {
          const selected = selectedIds.includes(option.id);
          return (
            <Button key={option.id} size="sm" variant={selected ? 'default' : 'outline'} onClick={() => onToggle(option.id)}>
              {option.label} <span className="font-mono text-[10px] opacity-70">({option.id})</span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}

export function LayoutEditor({ tab }: WorkbenchEditorProps) {
  const projectDocument = useProjectStore((state) => state.document);
  const clearDraftDirty = useDraftDirtyStore((state) => state.clearDraftDirty);
  const executeCommand = useCommandStore((state) => state.executeCommand);
  const layoutId = tab.resource?.entityId;
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const record = layoutId && project ? project.layouts[layoutId] : null;
  const parsedData = useMemo(() => parseLayoutData(record?.data), [record?.data]);
  const fallbackData = useMemo(
    () => defaultLayoutData(record?.label ?? layoutId ?? 'Layout'),
    [layoutId, record?.label],
  );
  const data = parsedData ?? fallbackData;
  const sampleStateText = useMemo(() => JSON.stringify(data.sampleState, null, 2), [data.sampleState]);
  const sourceDraftKey = `${tab.id}:layout-sources`;
  const sampleStateDraftKey = `${tab.id}:layout-sample-state`;
  const restoredSourceDraft = restoredDraftPayload<{ rml: string; rcss: string; lua: string }>(sourceDraftKey, LAYOUT_SOURCE_DRAFT_SCHEMA);
  const restoredSampleStateDraft = restoredDraftPayload<{ text: string }>(sampleStateDraftKey, LAYOUT_SAMPLE_STATE_DRAFT_SCHEMA);
  const [rmlDraft, setRmlDraft] = useState(restoredSourceDraft?.rml ?? data.rml.sourceText);
  const [rcssDraft, setRcssDraft] = useState(restoredSourceDraft?.rcss ?? data.rcss.sourceText);
  const [luaDraft, setLuaDraft] = useState(restoredSourceDraft?.lua ?? data.lua.sourceText);
  const [sampleStateDraft, setSampleStateDraft] = useState(restoredSampleStateDraft?.text ?? sampleStateText);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!restoredSourceDraft) {
      setRmlDraft(data.rml.sourceText);
      setRcssDraft(data.rcss.sourceText);
      setLuaDraft(data.lua.sourceText);
    }
    if (!restoredSampleStateDraft) setSampleStateDraft(sampleStateText);
    setMessage(null);
  }, [data.rml.sourceText, data.rcss.sourceText, data.lua.sourceText, restoredSampleStateDraft, restoredSourceDraft, sampleStateText]);

  const draftData = useMemo(() => {
    const parsedSampleState = parseSampleState(sampleStateDraft);
    return {
      ...data,
      rml: sourceWithDraft(data.rml, rmlDraft),
      rcss: sourceWithDraft(data.rcss, rcssDraft),
      lua: sourceWithDraft(data.lua, luaDraft),
      sampleState: parsedSampleState.ok ? parsedSampleState.value : data.sampleState,
    } satisfies LayoutData;
  }, [data, luaDraft, rcssDraft, rmlDraft, sampleStateDraft]);

  const sourceDraftDirty = rmlDraft !== data.rml.sourceText || rcssDraft !== data.rcss.sourceText || luaDraft !== data.lua.sourceText;
  const sampleStateDirty = sampleStateDraft !== sampleStateText;

  const applyDrafts = useCallback(() => {
    if (!layoutId) return false;
    const sampleState = parseSampleState(sampleStateDraft);
    if (!sampleState.ok) {
      setMessage(sampleState.message);
      return false;
    }
    const next: LayoutData = {
      ...data,
      rml: { ...data.rml, sourceText: rmlDraft },
      rcss: { ...data.rcss, sourceText: rcssDraft },
      lua: { ...data.lua, sourceText: luaDraft },
      sampleState: sampleState.value,
    };
    const result = updateLayout(layoutId, next, 'Update layout source');
    const failure = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    if (!result.ok || failure) {
      setMessage(failure?.message ?? 'Layout update failed.');
      return false;
    }
    clearDraftDirty(sourceDraftKey);
    clearDraftDirty(sampleStateDraftKey);
    setMessage(null);
    return true;
  }, [clearDraftDirty, data, layoutId, luaDraft, rcssDraft, rmlDraft, sampleStateDraft, sampleStateDraftKey, sourceDraftKey]);

  const discardDrafts = useCallback(() => {
    setRmlDraft(data.rml.sourceText);
    setRcssDraft(data.rcss.sourceText);
    setLuaDraft(data.lua.sourceText);
    setSampleStateDraft(sampleStateText);
    setMessage(null);
    return true;
  }, [data.rml.sourceText, data.rcss.sourceText, data.lua.sourceText, sampleStateText]);

  useEditorDraftDirty(tab.id, sourceDraftDirty, {
    key: sourceDraftKey,
    label: 'Unapplied layout source edits',
    schema: LAYOUT_SOURCE_DRAFT_SCHEMA,
    schemaVersion: 1,
    payload: { rml: rmlDraft, rcss: rcssDraft, lua: luaDraft },
    apply: applyDrafts,
    discard: discardDrafts,
  });
  useEditorDraftDirty(tab.id, sampleStateDirty, {
    key: sampleStateDraftKey,
    label: 'Unapplied layout sample state',
    schema: LAYOUT_SAMPLE_STATE_DRAFT_SCHEMA,
    schemaVersion: 1,
    payload: { text: sampleStateDraft },
    apply: applyDrafts,
    discard: discardDrafts,
  });

  const validationDiagnostics = useMemo(() => project && record && layoutId ? validateLayoutData(project, layoutId, { ...record, data: draftData }) : [], [draftData, layoutId, project, record]);
  const defaultLayout = project ? getDefaultLayoutSetting(project) : null;
  const isDefaultLayout = !!layoutId && defaultLayout?.$ref.id === layoutId;
  const sourceAssetOptions = useMemo(() => project ? selectableAssets(project, (kind, extension) => kind === 'text' || kind === 'data' || kind === 'script' || ['.rml', 'rml', '.rcss', 'rcss', '.css', 'css', '.lua', 'lua'].includes(extension ?? '')) : [], [project]);
  const imageAssets = useMemo(() => project ? selectableAssets(project, (kind) => kind === 'image') : [], [project]);
  const fontAssets = useMemo(() => project ? selectableAssets(project, (kind) => kind === 'font') : [], [project]);
  const stylesheetAssets = useMemo(() => project ? selectableAssets(project, (_kind, extension) => ['.rcss', 'rcss', '.css', 'css'].includes(extension ?? '')) : [], [project]);
  const scriptAssets = useMemo(() => project ? selectableAssets(project, (kind, extension) => kind === 'script' || ['.lua', 'lua'].includes(extension ?? '')) : [], [project]);
  const materialOptions = useMemo(() => project ? Object.entries(project.materials).map(([id, material]) => {
    const materialData = parseMaterialData(material.data);
    return { id, label: material.label, detail: materialData?.role ?? null };
  }) : [], [project]);

  if (!layoutId || !record || !project) return <div className="p-4 text-sm text-muted-foreground">Layout record not found.</div>;
  const activeLayoutId: string = layoutId;
  const activeRecord = record;
  const activeProject = project;

  const revision = layoutPreviewRevision(activeProject, activeLayoutId);
  const previewDocument = {
    kind: 'layout-preview' as const,
    recordId: activeLayoutId,
    revision,
    data: buildLayoutPreviewDocumentData(activeProject, activeLayoutId),
  };
  function commit(next: LayoutData, label = 'Update layout') {
    const result = updateLayout(activeLayoutId, next, label);
    const failure = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    setMessage(failure?.message ?? null);
  }

  function setSourceMode(which: 'rml' | 'rcss' | 'lua', sourceMode: LayoutSourceData['sourceMode']) {
    commit({ ...data, [which]: { ...data[which], sourceMode } }, `Set ${which.toUpperCase()} source mode`);
  }

  function setSourceAsset(which: 'rml' | 'rcss' | 'lua', assetId: string) {
    commit({
      ...data,
      [which]: { ...data[which], sourceAsset: assetId === '__none__' ? null : assetRef(assetId) },
    }, `Set ${which.toUpperCase()} source asset`);
  }

  function setDefaultLayout(layoutId: string | null) {
    const result = executeCommand({
      type: 'project.setDefaultLayout',
      label: layoutId ? `Set default layout ${layoutId}` : 'Clear default layout',
      payload: { layoutId },
    });
    const failure = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    setMessage(failure?.message ?? null);
  }

  function setDependency(kind: keyof LayoutData['dependencies'], ids: string[]) {
    const dependencies = {
      ...data.dependencies,
      [kind]: kind === 'materials' ? ids.map(materialRef) : ids.map(assetRef),
    } as LayoutData['dependencies'];
    commit({ ...data, dependencies }, 'Update layout dependencies');
  }

  const rmlDiagnostics = validationDiagnostics.filter((diagnostic) => diagnostic.path.includes('/rml/')).map((diagnostic) => ({ message: diagnostic.message, severity: diagnostic.severity }));
  const rcssDiagnostics = validationDiagnostics.filter((diagnostic) => diagnostic.path.includes('/rcss/')).map((diagnostic) => ({ message: diagnostic.message, severity: diagnostic.severity }));
  const luaDiagnostics = validationDiagnostics.filter((diagnostic) => diagnostic.path.includes('/lua/') || diagnostic.path.includes('/script/')).map((diagnostic) => ({ message: diagnostic.message, severity: diagnostic.severity }));

  return (
    <Group orientation="horizontal" className="h-full min-h-0 bg-background">
      <Panel defaultSize={62} minSize={35}>
        <div className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{activeRecord.label}</h2>
            <Badge variant="outline">{activeLayoutId}</Badge>
            <Badge variant="secondary">{data.layoutKind}</Badge>
            {isDefaultLayout ? <Badge>Default UI</Badge> : null}
            <Badge variant={validationDiagnostics.some((item) => item.severity === 'error') ? 'destructive' : 'secondary'}>
              {validationDiagnostics.length} diagnostic{validationDiagnostics.length === 1 ? '' : 's'}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Source-first RmlUi layout authoring with RML, RCSS, Lua behavior, explicit dependencies, and live preview.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setDefaultLayout(isDefaultLayout ? null : activeLayoutId)}>{isDefaultLayout ? 'Clear Default' : 'Set Default'}</Button>
      </div>

      {!parsedData ? <div className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">Layout data was invalid; showing editable defaults until you apply a change.</div> : null}
      {message ? <div className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{message}</div> : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <section className="grid gap-3 rounded border p-3 md:grid-cols-3">
            <div className="space-y-1">
              <Label>Layout kind</Label>
              <Select value={data.layoutKind} onValueChange={(value) => commit({ ...data, layoutKind: value as LayoutData['layoutKind'] }, 'Set layout kind')}>
                {layoutKindValues.map((kind) => <SelectItem key={kind} value={kind}>{kind}</SelectItem>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Target</Label>
              <Select value={data.target} onValueChange={(value) => commit({ ...data, target: value as LayoutData['target'] }, 'Set layout target')}>
                {layoutTargetValues.map((target) => <SelectItem key={target} value={target}>{target}</SelectItem>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Default layout</Label>
              <Select value={defaultLayout?.$ref.id ?? '__none__'} onValueChange={(value) => setDefaultLayout(value === '__none__' ? null : String(value))}>
                <SelectItem value="__none__">No default</SelectItem>
                {Object.entries(activeProject.layouts).map(([id, layout]) => <SelectItem key={id} value={id}>{layout.label} ({id})</SelectItem>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Preview background</Label>
              <Select value={data.preview.background} onValueChange={(value) => commit({ ...data, preview: { ...data.preview, background: value as LayoutData['preview']['background'] } }, 'Set layout preview background')}>
                {layoutPreviewBackgroundValues.map((background) => <SelectItem key={background} value={background}>{background}</SelectItem>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Preview width</Label>
              <Input type="number" value={data.preview.width} onChange={(event) => commit({ ...data, preview: { ...data.preview, width: Number(event.currentTarget.value) } }, 'Set layout preview width')} />
            </div>
            <div className="space-y-1">
              <Label>Preview height</Label>
              <Input type="number" value={data.preview.height} onChange={(event) => commit({ ...data, preview: { ...data.preview, height: Number(event.currentTarget.value) } }, 'Set layout preview height')} />
            </div>
          </section>

          <section className="space-y-3 rounded border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">RML Source</h3>
              <Select value={data.rml.sourceMode} onValueChange={(value) => setSourceMode('rml', value as LayoutSourceData['sourceMode'])}>
                {layoutSourceModeValues.map((mode) => <SelectItem key={mode} value={mode}>{mode}</SelectItem>)}
              </Select>
              {data.rml.sourceMode === 'asset' ? (
                <Select value={data.rml.sourceAsset?.$ref.id ?? '__none__'} onValueChange={(value) => setSourceAsset('rml', String(value))}>
                  <SelectItem value="__none__">No RML asset</SelectItem>
                  {sourceAssetOptions.map((asset) => <SelectItem key={asset.id} value={asset.id}>{asset.label} ({asset.id})</SelectItem>)}
                </Select>
              ) : null}
              <Button size="sm" variant="outline" className="ml-auto" onClick={() => void applyDrafts()} disabled={!sourceDraftDirty && !sampleStateDirty}>Apply Sources</Button>
              <Button size="sm" variant="ghost" onClick={discardDrafts} disabled={!sourceDraftDirty && !sampleStateDirty}>Discard</Button>
            </div>
            {data.rml.sourceMode === 'inline' ? <SourceEditor language="rml" value={rmlDraft} onChange={setRmlDraft} diagnostics={rmlDiagnostics} className="h-72" /> : <p className="rounded border p-3 text-xs text-muted-foreground">RML source is loaded from the selected asset. Inline draft is preserved for switching back.</p>}
          </section>

          <section className="space-y-3 rounded border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">RCSS Source</h3>
              <Select value={data.rcss.sourceMode} onValueChange={(value) => setSourceMode('rcss', value as LayoutSourceData['sourceMode'])}>
                {layoutSourceModeValues.map((mode) => <SelectItem key={mode} value={mode}>{mode}</SelectItem>)}
              </Select>
              {data.rcss.sourceMode === 'asset' ? (
                <Select value={data.rcss.sourceAsset?.$ref.id ?? '__none__'} onValueChange={(value) => setSourceAsset('rcss', String(value))}>
                  <SelectItem value="__none__">No RCSS asset</SelectItem>
                  {sourceAssetOptions.map((asset) => <SelectItem key={asset.id} value={asset.id}>{asset.label} ({asset.id})</SelectItem>)}
                </Select>
              ) : null}
            </div>
            {data.rcss.sourceMode === 'inline' ? <SourceEditor language="rcss" value={rcssDraft} onChange={setRcssDraft} diagnostics={rcssDiagnostics} className="h-64" /> : <p className="rounded border p-3 text-xs text-muted-foreground">RCSS source is loaded from the selected asset. Inline draft is preserved for switching back.</p>}
          </section>

          <section className="space-y-3 rounded border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">Lua Source</h3>
              <Select value={data.lua.sourceMode} onValueChange={(value) => setSourceMode('lua', value as LayoutSourceData['sourceMode'])}>
                {layoutSourceModeValues.map((mode) => <SelectItem key={mode} value={mode}>{mode}</SelectItem>)}
              </Select>
              {data.lua.sourceMode === 'asset' ? (
                <Select value={data.lua.sourceAsset?.$ref.id ?? '__none__'} onValueChange={(value) => setSourceAsset('lua', String(value))}>
                  <SelectItem value="__none__">No Lua asset</SelectItem>
                  {scriptAssets.map((asset) => <SelectItem key={asset.id} value={asset.id}>{asset.label} ({asset.id})</SelectItem>)}
                </Select>
              ) : null}
              <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                Script enabled
                <Switch checked={data.script.enabled} onCheckedChange={(checked) => commit({ ...data, script: { ...data.script, enabled: Boolean(checked) } }, 'Toggle layout script')} />
              </label>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label>Namespace</Label>
                <Input value={data.script.namespace ?? ''} onChange={(event) => commit({ ...data, script: { ...data.script, namespace: event.currentTarget.value.trim() || undefined } }, 'Set layout Lua namespace')} placeholder="layout_preview" />
              </div>
              <div className="space-y-1">
                <Label>Fragment parent</Label>
                <Input value={data.mount.defaultParent ?? ''} onChange={(event) => commit({ ...data, mount: { ...data.mount, defaultParent: event.currentTarget.value.trim() || undefined } }, 'Set layout mount parent')} placeholder="nt-layout-preview-mount" />
              </div>
            </div>
            {data.lua.sourceMode === 'inline' ? <SourceEditor language="lua" value={luaDraft} onChange={setLuaDraft} diagnostics={luaDiagnostics} className="h-56" /> : <p className="rounded border p-3 text-xs text-muted-foreground">Lua source is loaded from the selected asset. Inline draft is preserved for switching back.</p>}
          </section>

          <section className="space-y-3 rounded border p-3">
            <h3 className="text-sm font-medium">Sample State JSON</h3>
            <SourceEditor language="json" value={sampleStateDraft} onChange={setSampleStateDraft} className="h-40" />
          </section>
        </div>

        <aside className="space-y-4">
          <DependencySelector title="Image Assets" options={imageAssets} selectedIds={refIds(data.dependencies.images)} onToggle={(id) => setDependency('images', toggleRef(data.dependencies.images, assetRef(id)).map((ref) => ref.$ref.id))} />
          <DependencySelector title="Font Assets" options={fontAssets} selectedIds={refIds(data.dependencies.fonts)} onToggle={(id) => setDependency('fonts', toggleRef(data.dependencies.fonts, assetRef(id)).map((ref) => ref.$ref.id))} />
          <DependencySelector title="Stylesheet Assets" options={stylesheetAssets} selectedIds={refIds(data.dependencies.stylesheets)} onToggle={(id) => setDependency('stylesheets', toggleRef(data.dependencies.stylesheets, assetRef(id)).map((ref) => ref.$ref.id))} />
          <DependencySelector title="Script Assets" options={scriptAssets} selectedIds={refIds(data.dependencies.scripts)} onToggle={(id) => setDependency('scripts', toggleRef(data.dependencies.scripts, assetRef(id)).map((ref) => ref.$ref.id))} />
          <DependencySelector title="Materials" options={materialOptions} selectedIds={refIds(data.dependencies.materials)} onToggle={(id) => setDependency('materials', toggleRef(data.dependencies.materials, materialRef(id)).map((ref) => ref.$ref.id))} />

          {validationDiagnostics.length ? (
            <section className="space-y-2 rounded border p-3">
              <h3 className="text-sm font-medium">Diagnostics</h3>
              {validationDiagnostics.slice(0, 8).map((diagnostic, index) => (
                <div key={`${diagnostic.path}-${index}`} className="rounded border p-2 text-xs">
                  <Badge variant={diagnostic.severity === 'error' ? 'destructive' : 'secondary'}>{diagnostic.severity}</Badge>
                  <div className="mt-1">{diagnostic.message}</div>
                  <div className="mt-1 font-mono text-[10px] text-muted-foreground">{diagnostic.path}</div>
                </div>
              ))}
            </section>
          ) : null}
        </aside>
      </div>
        </div>
      </Panel>
      <ResizeSeparator className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/40 data-[resize-handle-active]:bg-primary" />
      <Panel defaultSize={38} minSize={24}>
        <div className="h-full min-h-0 border-l bg-background">
          <EnginePreview chrome="minimal" previewMode="layout" previewDocument={previewDocument} />
        </div>
      </Panel>
    </Group>
  );
}
