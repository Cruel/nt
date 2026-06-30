import { useCallback, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { SourceEditor } from '@/components/source/SourceEditor';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { buildShaderMaterialProject } from '../../../shared/project-schema/shader-material-project';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import {
  defaultShaderData,
  parseShaderData,
  shaderInputBindingValues,
  shaderRoleValues,
  shaderStageValues,
  shaderUniformTypeValues,
  type ShaderData,
  type ShaderStageData,
  type ShaderUniformData,
} from '../../../shared/project-schema/authoring-shaders';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import { buildRawJsonTabForRecord } from '@/workbench/editor-registry';
import { useEditorDraftDirty, useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { useShaderCompileStore } from '@/shaders/shader-compile-store';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';

function updateShader(shaderId: string, next: ShaderData, label: string) {
  return useCommandStore.getState().executeCommand({
    type: 'shader.replaceData',
    label,
    payload: { shaderId, data: next },
  });
}

function parseScalarValue(type: string, value: string): unknown {
  if (type === 'float') return Number.parseFloat(value || '0');
  if (type === 'int') return Number.parseInt(value || '0', 10);
  if (type === 'bool') return value === 'true';
  if (['vec2', 'vec3', 'vec4', 'color'].includes(type)) {
    return value.split(',').map((item) => Number.parseFloat(item.trim() || '0'));
  }
  return value;
}

function valueToText(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return value === undefined || value === null ? '' : String(value);
}

function ShaderStageRow({ tabId, shaderId, data, stage, index, shaderSourceAssets }: { tabId: string; shaderId: string; data: ShaderData; stage: ShaderStageData; index: number; shaderSourceAssets: Array<{ id: string; label: string }> }) {
  const [draft, setDraft] = useState(stage.sourceText ?? '');
  const clearDraftDirty = useDraftDirtyStore((state) => state.clearDraftDirty);
  const draftDirty = stage.sourceMode === 'inline' && draft !== (stage.sourceText ?? '');
  const draftKey = `${tabId}:shader-stage:${index}`;
  const commit = useCallback((nextStage: ShaderStageData, label = 'Update shader stage') => {
    const stages = [...data.stages];
    stages[index] = nextStage;
    updateShader(shaderId, { ...data, stages }, label);
    setDraft(nextStage.sourceText ?? '');
    clearDraftDirty(draftKey);
  }, [clearDraftDirty, data, draftKey, index, shaderId]);
  const applyDraft = useCallback(() => {
    commit({ ...stage, sourceText: draft }, 'Update shader source');
    return true;
  }, [commit, draft, stage]);
  const discardDraft = useCallback(() => {
    setDraft(stage.sourceText ?? '');
    return true;
  }, [stage.sourceText]);
  useEditorDraftDirty(tabId, draftDirty, {
    key: draftKey,
    label: `Unapplied ${stage.stage} shader source`,
    apply: applyDraft,
    discard: discardDraft,
  });
  return (
    <section className="space-y-3 rounded border p-3">
      <div className="flex items-center gap-2">
        <Badge variant="secondary">{stage.stage}</Badge>
        <Select value={stage.stage} onValueChange={(value) => commit({ ...stage, stage: value as ShaderStageData['stage'] })}>
          {shaderStageValues.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
        </Select>
        <Select value={stage.sourceMode} onValueChange={(value) => commit({ ...stage, sourceMode: value as ShaderStageData['sourceMode'] })}>
          <SelectItem value="inline">Inline source</SelectItem>
          <SelectItem value="asset">Source asset</SelectItem>
        </Select>
        <Button size="sm" variant="destructive" className="ml-auto" onClick={() => updateShader(shaderId, { ...data, stages: data.stages.filter((_, itemIndex) => itemIndex !== index) }, 'Remove shader stage')}>Remove</Button>
      </div>
      {stage.sourceMode === 'asset' ? (
        <div className="space-y-1">
          <Label>Shader source asset</Label>
          <Select value={stage.sourceAsset?.$ref.id ?? '__none__'} onValueChange={(value) => commit({ ...stage, sourceAsset: value === '__none__' ? null : { $ref: { collection: 'assets', id: String(value) } } })}>
            <SelectItem value="__none__">No source asset</SelectItem>
            {shaderSourceAssets.map((asset) => <SelectItem key={asset.id} value={asset.id}>{asset.label} ({asset.id})</SelectItem>)}
          </Select>
        </div>
      ) : (
        <div className="space-y-2">
          <Label>Inline source</Label>
          <SourceEditor value={draft} onChange={setDraft} className="h-64" />
        </div>
      )}
      {stage.compiled && Object.keys(stage.compiled).length > 0 ? (
        <div className="space-y-1 font-mono text-[11px] text-muted-foreground">
          {Object.entries(stage.compiled).map(([variant, path]) => <div key={variant}>{variant}: {path}</div>)}
        </div>
      ) : null}
    </section>
  );
}

function UniformRow({ shaderId, data, uniform, index }: { shaderId: string; data: ShaderData; uniform: ShaderUniformData; index: number }) {
  function commit(next: ShaderUniformData) {
    const uniforms = [...data.uniforms];
    uniforms[index] = next;
    updateShader(shaderId, { ...data, uniforms }, 'Update shader uniform');
  }
  return (
    <div className="grid gap-2 rounded border p-2 md:grid-cols-[1fr_130px_1fr_1fr_auto]">
      <Input value={uniform.name} onChange={(event) => commit({ ...uniform, name: event.currentTarget.value })} placeholder="u_value" />
      <Select value={uniform.type} onValueChange={(value) => commit({ ...uniform, type: value as ShaderUniformData['type'] })}>
        {shaderUniformTypeValues.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
      </Select>
      <Input value={valueToText(uniform.default)} onChange={(event) => commit({ ...uniform, default: parseScalarValue(uniform.type, event.currentTarget.value) })} placeholder="default" />
      <Select value={uniform.binding ?? '__none__'} onValueChange={(value) => commit({ ...uniform, binding: value === '__none__' ? null : value as ShaderUniformData['binding'] })}>
        <SelectItem value="__none__">No binding</SelectItem>
        {shaderInputBindingValues.map((binding) => <SelectItem key={binding} value={binding}>{binding}</SelectItem>)}
      </Select>
      <Button size="sm" variant="destructive" onClick={() => updateShader(shaderId, { ...data, uniforms: data.uniforms.filter((_, itemIndex) => itemIndex !== index) }, 'Remove shader uniform')}>Remove</Button>
    </div>
  );
}

export function ShaderEditor({ tab }: WorkbenchEditorProps) {
  const projectDocument = useProjectStore((state) => state.document);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const runCompile = useShaderCompileStore((state) => state.runCompile);
  const setActiveBottomPanel = useBottomPanelStore((state) => state.setActivePanelId);
  const shaderId = tab.resource?.entityId;
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const record = shaderId && project ? project.shaders[shaderId] : null;
  const parsedData = parseShaderData(record?.data);
  const data = parsedData ?? defaultShaderData(record?.label ?? shaderId ?? 'Shader');
  const shaderSourceAssets = useMemo(() => project ? Object.entries(project.assets)
    .filter(([, asset]) => parseAssetData(asset.data)?.kind === 'shader-source')
    .map(([id, asset]) => ({ id, label: asset.label })) : [], [project]);

  if (!shaderId || !record || !project) return <div className="p-4 text-sm text-muted-foreground">Shader record not found.</div>;
  const activeShaderId = shaderId;
  const activeProject = project;

  async function compile() {
    const built = buildShaderMaterialProject(activeProject);
    await runCompile(built.project, { shaderVariants: ['glsl-120', 'essl-100', 'essl-300'] });
    setActiveBottomPanel('shader-compile');
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2"><h2 className="truncate text-lg font-semibold">{record.label}</h2><Badge variant="outline">{activeShaderId}</Badge></div>
          <p className="mt-1 text-xs text-muted-foreground">Shader source, interface declarations, roles, compiled refs, and helper compile actions.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => openTab(buildRawJsonTabForRecord('shaders', activeShaderId, activeShaderId))}>Raw JSON</Button>
        <Button size="sm" onClick={() => void compile()}>Compile</Button>
      </div>

      {!parsedData ? <div className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">Shader data was invalid; showing editable defaults until you apply a change.</div> : null}

      <div className="mt-4 space-y-4">
        <section className="space-y-3 rounded border p-3">
          <h3 className="text-sm font-medium">Roles</h3>
          <div className="flex flex-wrap gap-2">
            {shaderRoleValues.map((role) => {
              const enabled = data.roles.includes(role);
              return <Button key={role} size="sm" variant={enabled ? 'default' : 'outline'} onClick={() => updateShader(activeShaderId, { ...data, roles: enabled ? data.roles.filter((item) => item !== role) : [...data.roles, role] }, 'Update shader roles')}>{role}</Button>;
            })}
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between"><h3 className="text-sm font-medium">Stages</h3><Button size="sm" variant="outline" onClick={() => updateShader(activeShaderId, { ...data, stages: [...data.stages, { stage: 'fragment', sourceMode: 'inline', sourceText: '', compiled: {} }] }, 'Add shader stage')}>Add Stage</Button></div>
          {data.stages.map((stage, index) => <ShaderStageRow key={`${stage.stage}-${index}`} tabId={tab.id} shaderId={activeShaderId} data={data} stage={stage} index={index} shaderSourceAssets={shaderSourceAssets} />)}
        </section>

        <section className="space-y-3 rounded border p-3">
          <div className="flex items-center justify-between"><h3 className="text-sm font-medium">Uniforms</h3><Button size="sm" variant="outline" onClick={() => updateShader(shaderId, { ...data, uniforms: [...data.uniforms, { name: `u_value_${data.uniforms.length + 1}`, type: 'float', default: 0 }] }, 'Add shader uniform')}>Add Uniform</Button></div>
          {data.uniforms.length === 0 ? <p className="text-xs text-muted-foreground">No uniforms declared.</p> : null}
          {data.uniforms.map((uniform, index) => <UniformRow key={`${uniform.name}-${index}`} shaderId={activeShaderId} data={data} uniform={uniform} index={index} />)}
        </section>

        <section className="space-y-3 rounded border p-3">
          <div className="flex items-center justify-between"><h3 className="text-sm font-medium">Samplers</h3><Button size="sm" variant="outline" onClick={() => updateShader(activeShaderId, { ...data, samplers: [...data.samplers, { name: `s_texture_${data.samplers.length + 1}`, type: 'texture2d' }] }, 'Add shader sampler')}>Add Sampler</Button></div>
          {data.samplers.map((sampler, index) => (
            <div key={`${sampler.name}-${index}`} className="flex gap-2 rounded border p-2">
              <Input value={sampler.name} onChange={(event) => {
                const samplers = [...data.samplers];
                samplers[index] = { ...sampler, name: event.currentTarget.value };
                updateShader(activeShaderId, { ...data, samplers }, 'Update shader sampler');
              }} />
              <Badge variant="secondary" className="self-center">texture2d</Badge>
              <Button size="sm" variant="destructive" onClick={() => updateShader(activeShaderId, { ...data, samplers: data.samplers.filter((_, itemIndex) => itemIndex !== index) }, 'Remove shader sampler')}>Remove</Button>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
