import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';
import { useProjectStore } from '@/project/project-store';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import {
  defaultMaterialData,
  materialBlendValues,
  materialTextureFilteringValues,
  parseMaterialData,
  resolveMaterialData,
  type MaterialData,
  type MaterialTextureData,
  type MaterialUniformOverride,
} from '../../../shared/project-schema/authoring-materials';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import { parseShaderData, shaderRoleValues, type ShaderUniformData } from '../../../shared/project-schema/authoring-shaders';
import { buildMaterialPreviewDocumentData, materialPreviewRevision } from '../../../shared/project-schema/shader-material-project';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import { buildRawJsonTabForRecord } from '@/workbench/editor-registry';
import { useWorkbenchStore } from '@/workbench/workbench-store';

function updateMaterial(materialId: string, next: MaterialData, label: string) {
  return useCommandStore.getState().executeCommand({
    type: 'material.replaceData',
    label,
    payload: { materialId, data: next },
  });
}

function parseUniformValue(type: ShaderUniformData['type'], text: string): unknown {
  if (type === 'float') return Number.parseFloat(text || '0');
  if (type === 'int') return Number.parseInt(text || '0', 10);
  if (type === 'bool') return text === 'true';
  if (['vec2', 'vec3', 'vec4', 'color'].includes(type)) return text.split(',').map((item) => Number.parseFloat(item.trim() || '0'));
  return text;
}

function valueToText(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return value === undefined || value === null ? '' : String(value);
}

function inheritedUniform(data: MaterialData, name: string): MaterialUniformOverride | null {
  return data.uniforms.find((item) => item.name === name) ?? null;
}

function inheritedTexture(data: MaterialData, name: string): MaterialTextureData | null {
  return data.textures.find((item) => item.sampler === name) ?? null;
}

export function MaterialEditor({ tab }: WorkbenchEditorProps) {
  const projectDocument = useProjectStore((state) => state.document);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const requestEntityPreview = usePreviewManagerStore((state) => state.requestEntityPreview);
  const requestThumbnail = usePreviewManagerStore((state) => state.requestThumbnail);
  const materialId = tab.resource?.entityId;
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const record = materialId && project ? project.materials[materialId] : null;
  const parsedData = parseMaterialData(record?.data);
  const data = parsedData ?? defaultMaterialData(record?.label ?? materialId ?? 'Material');
  const resolved = useMemo(() => project && materialId ? resolveMaterialData(project, materialId) : { data: null, diagnostics: [] }, [project, materialId]);
  const resolvedData = resolved.data ?? data;
  const shaderId = data.shader?.$ref.id ?? null;
  const shader = shaderId && project ? parseShaderData(project.shaders[shaderId]?.data) : null;
  const shaderRecords = project ? Object.entries(project.shaders) : [];
  const imageAssets = project ? Object.entries(project.assets).filter(([, asset]) => parseAssetData(asset.data)?.kind === 'image').map(([id, asset]) => ({ id, label: asset.label })) : [];
  const localUniforms = new Map(data.uniforms.map((item) => [item.name, item]));
  const localTextures = new Map(data.textures.map((item) => [item.sampler, item]));

  if (!materialId || !record || !project) return <div className="p-4 text-sm text-muted-foreground">Material record not found.</div>;
  const activeMaterialId = materialId;
  const activeRecord = record;
  const activeProject = project;

  const revision = materialPreviewRevision(activeProject, activeMaterialId);
  const previewDocument = {
    kind: 'material-preview' as const,
    recordId: activeMaterialId,
    revision,
    data: buildMaterialPreviewDocumentData(activeProject, activeMaterialId),
  };
  const thumbnail = requestThumbnail({
    target: { collection: 'materials', entityId: activeMaterialId, kind: 'material', label: activeRecord.label },
    document: previewDocument,
    revision,
  });

  function commit(next: MaterialData, label = 'Update material') {
    updateMaterial(activeMaterialId, next, label);
  }

  function requestPreview() {
    requestEntityPreview({
      ownerId: `material-editor:${activeMaterialId}`,
      target: { collection: 'materials', entityId: activeMaterialId, kind: 'material', label: activeRecord.label },
      document: previewDocument,
      mode: 'material',
    });
  }

  function setUniform(declaration: ShaderUniformData, value: unknown) {
    const uniforms = data.uniforms.filter((item) => item.name !== declaration.name);
    commit({ ...data, uniforms: [...uniforms, { name: declaration.name, value }] }, 'Set material uniform');
  }

  function clearUniform(name: string) {
    commit({ ...data, uniforms: data.uniforms.filter((item) => item.name !== name) }, 'Clear material uniform');
  }

  function setTexture(sampler: string, patch: Partial<MaterialTextureData>) {
    const existing = localTextures.get(sampler) ?? inheritedTexture(resolvedData, sampler) ?? { sampler, source: { uri: '' }, filtering: 'clamp-linear' as const };
    const textures = data.textures.filter((item) => item.sampler !== sampler);
    commit({ ...data, textures: [...textures, { ...existing, ...patch, sampler }] }, 'Set material texture');
  }

  function clearTexture(sampler: string) {
    commit({ ...data, textures: data.textures.filter((item) => item.sampler !== sampler) }, 'Clear material texture');
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2"><h2 className="truncate text-lg font-semibold">{activeRecord.label}</h2><Badge variant="outline">{activeMaterialId}</Badge><Badge variant="secondary">{thumbnail.status}</Badge></div>
          <p className="mt-1 text-xs text-muted-foreground">Material shader, role, uniform overrides, texture slots, inheritance, and preview requests.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => openTab(buildRawJsonTabForRecord('materials', activeMaterialId, activeMaterialId))}>Raw JSON</Button>
        <Button size="sm" onClick={requestPreview}>Request Preview</Button>
      </div>

      {!parsedData ? <div className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">Material data was invalid; showing editable defaults until you apply a change.</div> : null}
      {resolved.diagnostics.length > 0 ? <div className="mt-3 rounded border p-2 text-xs text-muted-foreground">{resolved.diagnostics[0]?.message}</div> : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <section className="grid gap-3 rounded border p-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label>Shader</Label>
              <Select value={shaderId ?? '__none__'} onValueChange={(value) => commit({ ...data, shader: value === '__none__' ? null : { $ref: { collection: 'shaders', id: String(value) } } }, 'Set material shader')}>
                <SelectItem value="__none__">No shader</SelectItem>
                {shaderRecords.map(([id, shaderRecord]) => <SelectItem key={id} value={id}>{shaderRecord.label} ({id})</SelectItem>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Role</Label>
              <Select value={data.role} onValueChange={(value) => commit({ ...data, role: value as MaterialData['role'] }, 'Set material role')}>
                {shaderRoleValues.map((role) => <SelectItem key={role} value={role}>{role}{shader && !shader.roles.includes(role) ? ' (unsupported)' : ''}</SelectItem>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Blend</Label>
              <Select value={data.blend} onValueChange={(value) => commit({ ...data, blend: value as MaterialData['blend'] }, 'Set material blend')}>
                {materialBlendValues.map((blend) => <SelectItem key={blend} value={blend}>{blend}</SelectItem>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Inherits</Label>
              <Select value={activeRecord.inherits?.collection === 'materials' ? activeRecord.inherits.id : '__none__'} onValueChange={(value) => useCommandStore.getState().executeCommand({ type: 'material.setInherits', label: 'Set material inheritance', payload: { materialId: activeMaterialId, inheritsId: value === '__none__' ? null : String(value) } })}>
                <SelectItem value="__none__">No inherited material</SelectItem>
                {Object.entries(activeProject.materials).filter(([id]) => id !== activeMaterialId).map(([id, materialRecord]) => <SelectItem key={id} value={id}>{materialRecord.label} ({id})</SelectItem>)}
              </Select>
            </div>
          </section>

          <section className="space-y-3 rounded border p-3">
            <h3 className="text-sm font-medium">Uniform Overrides</h3>
            {!shader ? <p className="text-xs text-muted-foreground">Choose a valid shader to edit uniform overrides.</p> : null}
            {shader?.uniforms.map((uniform) => {
              const local = localUniforms.get(uniform.name);
              const inherited = inheritedUniform(resolvedData, uniform.name);
              const display = local ?? inherited;
              return (
                <div key={uniform.name} className="grid gap-2 rounded border p-2 md:grid-cols-[160px_120px_1fr_auto]">
                  <div><div className="font-mono text-xs">{uniform.name}</div><div className="text-[10px] text-muted-foreground">{uniform.type}{local ? ' local' : inherited ? ' inherited' : ' default'}</div></div>
                  <Badge variant={local ? 'default' : 'outline'} className="h-7 self-center justify-center">{uniform.binding ?? 'manual'}</Badge>
                  {uniform.type === 'bool' ? (
                    <Select value={String(display?.value ?? uniform.default ?? false)} onValueChange={(value) => setUniform(uniform, value === 'true')}>
                      <SelectItem value="false">false</SelectItem>
                      <SelectItem value="true">true</SelectItem>
                    </Select>
                  ) : (
                    <Input value={valueToText(display?.value ?? uniform.default)} onChange={(event) => setUniform(uniform, parseUniformValue(uniform.type, event.currentTarget.value))} />
                  )}
                  <Button size="sm" variant="outline" onClick={() => clearUniform(uniform.name)} disabled={!local}>Reset</Button>
                </div>
              );
            })}
          </section>

          <section className="space-y-3 rounded border p-3">
            <h3 className="text-sm font-medium">Texture Slots</h3>
            {!shader ? <p className="text-xs text-muted-foreground">Choose a valid shader to edit texture slots.</p> : null}
            {shader?.samplers.map((sampler) => {
              const local = localTextures.get(sampler.name);
              const inherited = inheritedTexture(resolvedData, sampler.name);
              const display = local ?? inherited;
              const refId = display?.source && '$ref' in display.source ? display.source.$ref.id : '__none__';
              return (
                <div key={sampler.name} className="grid gap-2 rounded border p-2 md:grid-cols-[160px_1fr_160px_auto]">
                  <div><div className="font-mono text-xs">{sampler.name}</div><div className="text-[10px] text-muted-foreground">{local ? 'local' : inherited ? 'inherited' : 'empty'}</div></div>
                  <Select value={refId} onValueChange={(value) => setTexture(sampler.name, { source: value === '__none__' ? { uri: '' } : { $ref: { collection: 'assets', id: String(value) } } })}>
                    <SelectItem value="__none__">No texture</SelectItem>
                    {imageAssets.map((asset) => <SelectItem key={asset.id} value={asset.id}>{asset.label} ({asset.id})</SelectItem>)}
                  </Select>
                  <Select value={display?.filtering ?? 'clamp-linear'} onValueChange={(value) => setTexture(sampler.name, { filtering: value as MaterialTextureData['filtering'] })}>
                    {materialTextureFilteringValues.map((filter) => <SelectItem key={filter} value={filter}>{filter}</SelectItem>)}
                  </Select>
                  <Button size="sm" variant="outline" onClick={() => clearTexture(sampler.name)} disabled={!local}>Reset</Button>
                </div>
              );
            })}
          </section>
        </div>
        <aside className="rounded border bg-muted/20 p-4">
          <div className="flex items-center gap-2"><Badge variant="secondary">Preview</Badge><span className="font-mono text-xs text-muted-foreground">{thumbnail.status}</span></div>
          <div className="mt-4 flex h-40 items-center justify-center rounded border border-dashed bg-background text-center text-sm text-muted-foreground">
            Material preview request is cached through PreviewManager. Engine material rendering can fill this when preview mode is supported.
          </div>
          <div className="mt-3 overflow-hidden font-mono text-[10px] text-muted-foreground">revision {revision.slice(0, 80)}</div>
        </aside>
      </div>
    </div>
  );
}
