import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { MaterialPreview } from '@/material-preview/MaterialPreview';
import { useMaterialPreviewResource } from '@/material-preview/material-preview-provider';
import { useProjectSourceStore } from '@/project/project-source-store';
import { useProjectStore } from '@/project/project-store';
import { seedShaderSourceTabMaterial } from '@/shaders/shader-source-tab-state';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import {
  defaultMaterialData,
  materialCanInheritFrom,
  materialDataWithBase,
  materialTextureFilteringValues,
  parseMaterialData,
  resolvedMaterialUsesCustomShader,
  resolveMaterialData,
  type MaterialData,
  type MaterialParameterOverride,
  type MaterialProvenance,
  type MaterialTextureData,
} from '../../../shared/project-schema/authoring-materials';
import {
  materialPresetIdValues,
  materialPresets,
  type MaterialPresetId,
} from '../../../shared/project-schema/authoring-material-presets';
import {
  isAuthoringProject,
  type AuthoringProject,
} from '../../../shared/project-schema/authoring-project';
import { materialContractRegistry } from '../../../shared/project-schema/material-contract-registry.generated';
import {
  isUniformValueCompatible,
  shaderSamplerBindingValues,
  shaderUniformValueSchema,
  type ShaderUniformType,
  type ShaderUniformValue,
} from '../../../shared/project-schema/authoring-shaders';
import {
  buildEngineShaderSourceTab,
  buildProjectSourceTab,
  type WorkbenchEditorProps,
} from '@/workbench/editor-registry';
import { useWorkbenchStore } from '@/workbench/workbench-store';

function updateMaterial(materialId: string, next: MaterialData, label: string) {
  return useCommandStore.getState().executeCommand({
    type: 'material.replaceData',
    label,
    payload: { materialId, data: next },
    originSaveUnitId: recordSaveUnitId('materials', materialId),
    persistencePolicy: 'manual-save',
  });
}

function parseParameterValue(type: ShaderUniformType, text: string): ShaderUniformValue {
  const raw =
    type === 'float'
      ? Number.parseFloat(text || '0')
      : type === 'int'
        ? Number.parseInt(text || '0', 10)
        : type === 'bool'
          ? text === 'true'
          : text.split(',').map((item) => Number.parseFloat(item.trim() || '0'));
  const parsed = shaderUniformValueSchema.safeParse(raw);
  return parsed.success ? parsed.data : 0;
}

function valueToText(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
}

function provenanceLabel(
  project: AuthoringProject,
  materialId: string,
  provenance: MaterialProvenance | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  if (!provenance) return t('materialEditor.provenance.unknown');
  if (provenance.kind === 'preset')
    return t('materialEditor.provenance.preset', {
      label: materialPresets[provenance.id].label,
    });
  if (provenance.id === materialId) return t('materialEditor.provenance.current');
  return t('materialEditor.provenance.base', {
    label: project.materials[provenance.id]?.label ?? provenance.id,
  });
}

function projectShaderPath(sourceIdentity: string | undefined): string | null {
  if (!sourceIdentity) return null;
  if (sourceIdentity.startsWith('project:/')) return sourceIdentity.slice('project:/'.length);
  return sourceIdentity.startsWith('shaders/') ? sourceIdentity : null;
}

function MaterialShaderSourceRow({
  stage,
  materialId,
  project,
  data,
  effectivePath,
  provenance,
  onSetPath,
  onReset,
}: {
  stage: 'vertex' | 'fragment' | 'varying';
  materialId: string;
  project: AuthoringProject;
  data: MaterialData;
  effectivePath: string | undefined;
  provenance: MaterialProvenance | undefined;
  onSetPath: (path: string) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation('workspace');
  const files = useProjectSourceStore((state) => state.files);
  const mutate = useProjectSourceStore((state) => state.mutate);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const local = data.shader?.[stage];
  const sourcePath = projectShaderPath(effectivePath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usageCount = effectivePath
    ? Object.keys(project.materials).filter((candidateId) => {
        const candidate = resolveMaterialData(project, candidateId).data;
        if (!candidate) return false;
        const candidatePath =
          stage === 'vertex'
            ? candidate.vertexSource
            : stage === 'fragment'
              ? candidate.fragmentSource
              : candidate.varyingDefinition;
        return candidatePath === effectivePath;
      }).length
    : 0;

  function openEffectiveSource() {
    if (!effectivePath) return;
    if (effectivePath.startsWith('engine:/')) {
      openTab(buildEngineShaderSourceTab(effectivePath, materialId));
      return;
    }
    const path = projectShaderPath(effectivePath);
    const source = path ? files.find((candidate) => candidate.id === path) : null;
    if (source) {
      const sourceTab = buildProjectSourceTab(source);
      openTab(sourceTab);
      seedShaderSourceTabMaterial(sourceTab.id, materialId);
    }
  }

  async function makeSpecificCopy() {
    setBusy(true);
    setError(null);
    try {
      const result = await mutate({
        kind: 'material-shader-copy',
        materialId,
        stage,
        sourceIdentity: effectivePath!,
      });
      if (!result.success || !result.createdSourceIds?.[0]) {
        setError(result.error ?? t('materialEditor.customizeFailed'));
        return;
      }
      const created = useProjectSourceStore
        .getState()
        .files.find((candidate) => candidate.id === result.createdSourceIds?.[0]);
      if (created) {
        const sourceTab = buildProjectSourceTab(created);
        openTab(sourceTab);
        seedShaderSourceTabMaterial(sourceTab.id, materialId);
      }
    } finally {
      setBusy(false);
    }
  }

  const shared = sourcePath !== null && usageCount > 1;
  const inherited = provenance?.kind === 'material' && provenance.id !== materialId;
  const canCopy = Boolean(
    effectivePath && (effectivePath.startsWith('engine:/') || shared || inherited),
  );

  return (
    <div className="space-y-1 rounded border p-1.5">
      <div className="grid items-center gap-1.5 @3xl:grid-cols-[90px_minmax(160px,1fr)_auto]">
        <div className="self-center">
          <Label className="capitalize">{stage}</Label>
          <div className="mt-1 text-[10px] text-muted-foreground">
            {provenanceLabel(project, materialId, provenance, t)}
          </div>
        </div>
        <Input
          value={local?.path ?? ''}
          placeholder={effectivePath ?? ''}
          onChange={(event) => onSetPath(event.currentTarget.value.trim())}
        />
        <div className="flex flex-wrap justify-end gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            disabled={!effectivePath}
            onClick={openEffectiveSource}
          >
            {t('materialEditor.openSource')}
          </Button>
          {sourcePath ? (
            <Badge variant="outline" className="h-6 px-2 text-[10px]">
              {t('materialEditor.sourceUsage', { count: usageCount })}
            </Badge>
          ) : null}
          {canCopy ? (
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              disabled={busy}
              onClick={() => void makeSpecificCopy()}
            >
              {effectivePath?.startsWith('engine:/')
                ? t('materialEditor.customizeShader')
                : t('materialEditor.makeMaterialSpecific')}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            disabled={!local}
            onClick={onReset}
          >
            {t('materialEditor.reset')}
          </Button>
        </div>
      </div>
      {error ? <div className="text-xs text-destructive">{error}</div> : null}
    </div>
  );
}

export function MaterialEditor({ tab }: WorkbenchEditorProps) {
  const { t } = useTranslation('workspace');
  const projectDocument = useProjectStore((state) => state.document);
  const materialId = tab.resource?.entityId;
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const record = materialId && project ? project.materials[materialId] : null;
  const parsedData = parseMaterialData(record?.data);
  const data = parsedData ?? defaultMaterialData(record?.label ?? materialId ?? 'Material');
  const resolved = useMemo(
    () =>
      project && materialId
        ? resolveMaterialData(project, materialId)
        : { data: null, diagnostics: [] },
    [project, materialId],
  );
  const effective = resolved.data;
  const imageAssets = project
    ? Object.entries(project.assets)
        .filter(([, asset]) => parseAssetData(asset.data)?.kind === 'image')
        .map(([id, asset]) => ({ id, label: asset.label }))
    : [];
  const previewResource = useMaterialPreviewResource(materialId ?? null);

  if (!materialId || !record || !project)
    return <div className="p-4 text-sm text-muted-foreground">{t('materialEditor.missing')}</div>;

  function commit(next: MaterialData, label = t('materialEditor.commands.update')) {
    updateMaterial(materialId!, next, label);
  }

  function setParameter(name: string, patch: MaterialParameterOverride) {
    commit(
      { ...data, parameters: { ...data.parameters, [name]: patch } },
      t('materialEditor.commands.setParameter'),
    );
  }

  function clearParameter(name: string) {
    const parameters = { ...data.parameters };
    delete parameters[name];
    commit({ ...data, parameters }, t('materialEditor.commands.resetParameter'));
  }

  function rebindParameter(from: string, to: string) {
    const source = data.parameters[from];
    if (!source || from === to) return;
    const parameters = { ...data.parameters };
    delete parameters[from];
    parameters[to] = { ...parameters[to], ...source };
    commit({ ...data, parameters }, t('materialEditor.commands.rebindParameter'));
  }

  function setTexture(name: string, patch: MaterialTextureData) {
    commit(
      { ...data, textures: { ...data.textures, [name]: patch } },
      t('materialEditor.commands.setTexture'),
    );
  }

  function clearTexture(name: string) {
    const textures = { ...data.textures };
    delete textures[name];
    commit({ ...data, textures }, t('materialEditor.commands.resetTexture'));
  }

  function rebindTexture(from: string, to: string) {
    const source = data.textures[from];
    if (!source || from === to) return;
    const textures = { ...data.textures };
    delete textures[from];
    textures[to] = { ...textures[to], ...source };
    commit({ ...data, textures }, t('materialEditor.commands.rebindTexture'));
  }

  const baseValue =
    data.base.kind === 'preset'
      ? `preset:${data.base.preset}`
      : `material:${data.base.material.$ref.id}`;
  const customSource = effective ? resolvedMaterialUsesCustomShader(effective) : false;
  const currentDerivedInterface = previewResource?.derivedInterface ?? null;
  const roleContract = effective
    ? materialContractRegistry.roles.find((role) => role.id === effective.role)
    : undefined;
  const presetParameterDeclarations = effective
    ? Object.fromEntries(
        [
          ...new Set([
            ...Object.keys(effective.preset.uniforms),
            ...Object.keys(effective.preset.standardUniforms),
          ]),
        ].flatMap((name) => {
          const parameter = effective.parameters[name];
          if (!parameter?.type) return [];
          return [
            [
              name,
              {
                ...effective.preset.uniforms[name],
                type: parameter.type,
                binding: parameter.binding ?? undefined,
              },
            ],
          ];
        }),
      )
    : {};
  const presetTextureDeclarations = effective
    ? Object.fromEntries(
        Object.entries(effective.preset.samplerCapabilities).flatMap(([name, state]) => {
          if (state === 'disabled') return [];
          const sampler = roleContract?.reservedInterface.samplers.find(
            (candidate) => candidate.name === name,
          );
          if (!sampler) return [];
          const binding = shaderSamplerBindingValues.includes(
            sampler.semantic as (typeof shaderSamplerBindingValues)[number],
          )
            ? (sampler.semantic as (typeof shaderSamplerBindingValues)[number])
            : null;
          return [[name, { type: 'texture2d' as const, stage: sampler.stage, binding }]];
        }),
      )
    : {};
  const rendererOwnedSamplerNames = new Set(
    roleContract?.reservedInterface.samplers
      .filter((sampler) => sampler.sourceOwnership === 'renderer')
      .map((sampler) => sampler.name) ?? [],
  );
  const parameterDeclarations =
    currentDerivedInterface?.uniforms ?? (customSource ? {} : presetParameterDeclarations);
  const textureDeclarations = Object.fromEntries(
    Object.entries(
      currentDerivedInterface?.samplers ?? (customSource ? {} : presetTextureDeclarations),
    ).filter(([name]) => !rendererOwnedSamplerNames.has(name)),
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-background p-3">
      <div className="flex items-start gap-3" data-workbench-anchor="material.summary">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold">{record.label}</h2>
            <Badge variant="outline">{materialId}</Badge>
            {effective ? <Badge variant="secondary">{effective.role}</Badge> : null}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{t('materialEditor.summary')}</p>
        </div>
      </div>

      {!parsedData ? (
        <div className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {t('materialEditor.invalidData')}
        </div>
      ) : null}
      <div className="mt-3 grid gap-3 @7xl:grid-cols-[1fr_320px]">
        <div className="space-y-3">
          <section
            className="grid gap-2 rounded border p-2.5 @3xl:grid-cols-2"
            data-workbench-anchor="material.settings"
          >
            <div className="space-y-1">
              <Label>{t('materialEditor.base')}</Label>
              <Select
                value={baseValue}
                onValueChange={(value) => {
                  const raw = String(value);
                  if (raw.startsWith('preset:')) {
                    commit(
                      materialDataWithBase(data, {
                        kind: 'preset',
                        preset: raw.slice(7) as MaterialPresetId,
                      }),
                      t('materialEditor.commands.setPreset'),
                    );
                  } else {
                    commit(
                      materialDataWithBase(data, {
                        kind: 'material',
                        material: { $ref: { collection: 'materials', id: raw.slice(9) } },
                      }),
                      t('materialEditor.commands.setBase'),
                    );
                  }
                }}
              >
                <SelectTrigger size="sm" className="w-full min-w-0">
                  <SelectValue>
                    {data.base.kind === 'preset'
                      ? `${materialPresets[data.base.preset].label} (${t('materialEditor.presetSuffix')})`
                      : `${
                          project.materials[data.base.material.$ref.id]?.label ??
                          data.base.material.$ref.id
                        } (${data.base.material.$ref.id})`}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="start">
                  {materialPresetIdValues.map((presetId) => (
                    <SelectItem key={presetId} value={`preset:${presetId}`}>
                      {materialPresets[presetId].label} ({t('materialEditor.presetSuffix')})
                    </SelectItem>
                  ))}
                  {Object.entries(project.materials)
                    .filter(([id]) => materialCanInheritFrom(project, materialId, id))
                    .map(([id, materialRecord]) => (
                      <SelectItem key={id} value={`material:${id}`}>
                        {materialRecord.label} ({id})
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>{t('materialEditor.effectiveContract')}</Label>
              <div className="flex h-6 items-center gap-2 rounded border px-2 text-xs">
                <span>{effective?.preset.label ?? t('materialEditor.invalidContract')}</span>
                {effective ? <Badge variant="outline">{effective.role}</Badge> : null}
              </div>
            </div>
          </section>

          <section
            className="space-y-2 rounded border p-2.5"
            data-workbench-anchor="material.shader"
          >
            <h3 className="text-sm font-medium">{t('materialEditor.shaderSources')}</h3>
            <p className="text-[11px] text-muted-foreground">
              {t('materialEditor.shaderSourcesHelp')}
            </p>
            {(['vertex', 'fragment', 'varying'] as const).map((stage) => {
              const effectivePath =
                stage === 'vertex'
                  ? effective?.vertexSource
                  : stage === 'fragment'
                    ? effective?.fragmentSource
                    : effective?.varyingDefinition;
              return (
                <MaterialShaderSourceRow
                  key={stage}
                  stage={stage}
                  materialId={materialId}
                  project={project}
                  data={data}
                  effectivePath={effectivePath}
                  provenance={effective?.provenance[`shader.${stage}`]}
                  onSetPath={(path) => {
                    const shader = { ...data.shader };
                    if (path)
                      shader[stage] = path.startsWith('engine:/')
                        ? { kind: 'engine', path }
                        : { kind: 'project', path };
                    else delete shader[stage];
                    commit(
                      {
                        ...data,
                        shader: Object.keys(shader).length > 0 ? shader : undefined,
                      },
                      t('materialEditor.commands.setShaderSource'),
                    );
                  }}
                  onReset={() => {
                    const shader = { ...data.shader };
                    delete shader[stage];
                    commit(
                      { ...data, shader: Object.keys(shader).length > 0 ? shader : undefined },
                      t('materialEditor.commands.resetShaderSource'),
                    );
                  }}
                />
              );
            })}
          </section>

          <section
            className="space-y-2 rounded border p-2.5"
            data-workbench-anchor="material.parameters"
          >
            <h3 className="text-sm font-medium">{t('materialEditor.parameters')}</h3>
            {Object.entries(parameterDeclarations)
              .filter(([name, declaration]) => {
                const value = data.parameters[name]?.value;
                const binding = data.parameters[name]?.binding;
                return (
                  (value === undefined ||
                    (declaration.binding == null &&
                      isUniformValueCompatible(declaration.type, value))) &&
                  (binding === undefined || binding === declaration.binding)
                );
              })
              .map(([name, declaration]) => {
                const local = data.parameters[name];
                const current = effective?.parameters[name];
                const currentValue =
                  current?.value !== undefined &&
                  isUniformValueCompatible(declaration.type, current.value)
                    ? current.value
                    : undefined;
                const rendererBound = declaration.binding != null;
                const declarationLabel =
                  'label' in declaration ? declaration.label : declaration.editor?.label;
                const range = declaration.range ?? current?.editor?.range;
                const provenance = effective?.provenance[`parameters.${name}`];
                return (
                  <div
                    key={name}
                    className="grid items-center gap-1.5 rounded border p-1.5 @3xl:grid-cols-[150px_140px_minmax(140px,1fr)_auto]"
                  >
                    <div>
                      <div className="text-xs font-medium">{declarationLabel ?? name}</div>
                      <div className="font-mono text-[10px] leading-tight text-muted-foreground">
                        {name} · {declaration.type}
                      </div>
                      {current?.editor?.control ? (
                        <div className="text-[10px] text-muted-foreground">
                          {current.editor.control}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-col items-start justify-center gap-1">
                      <Badge variant={local ? 'default' : 'outline'}>
                        {provenanceLabel(project, materialId, provenance, t)}
                      </Badge>
                      {declaration.binding ? (
                        <span className="text-[10px] text-muted-foreground">
                          {declaration.binding}
                        </span>
                      ) : null}
                    </div>
                    {rendererBound ? (
                      <div className="self-center text-xs text-muted-foreground">
                        {t('materialEditor.runtimeSupplied')}
                      </div>
                    ) : declaration.type === 'bool' ? (
                      <Select
                        value={currentValue === true ? 'true' : 'false'}
                        onValueChange={(value) =>
                          setParameter(name, { ...local, value: value === 'true' })
                        }
                      >
                        <SelectTrigger size="sm" className="w-full min-w-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent align="start">
                          <SelectItem value="false">false</SelectItem>
                          <SelectItem value="true">true</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        value={valueToText(currentValue)}
                        min={range?.[0]}
                        max={range?.[1]}
                        onChange={(event) =>
                          setParameter(name, {
                            ...local,
                            value: parseParameterValue(declaration.type, event.currentTarget.value),
                          })
                        }
                      />
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-xs"
                      disabled={!local}
                      onClick={() => clearParameter(name)}
                    >
                      {t('materialEditor.reset')}
                    </Button>
                  </div>
                );
              })}
            {Object.keys(data.parameters)
              .filter((name) => {
                const declaration = parameterDeclarations[name];
                const value = data.parameters[name]?.value;
                const binding = data.parameters[name]?.binding;
                return (
                  !declaration ||
                  (value !== undefined &&
                    (declaration.binding != null ||
                      !isUniformValueCompatible(declaration.type, value))) ||
                  (binding !== undefined && binding !== declaration?.binding)
                );
              })
              .map((name) => (
                <div
                  key={name}
                  className="grid items-center gap-1.5 rounded border border-dashed p-1.5 text-xs @3xl:grid-cols-[1fr_160px_auto]"
                >
                  <span className="self-center">
                    {t('materialEditor.orphanedParameter', { name })}
                  </span>
                  <Select
                    value="__orphan__"
                    onValueChange={(value) => rebindParameter(name, String(value))}
                  >
                    <SelectTrigger size="sm" className="w-full min-w-0">
                      <SelectValue>{t('materialEditor.rebind')}</SelectValue>
                    </SelectTrigger>
                    <SelectContent align="start">
                      <SelectItem value="__orphan__" disabled>
                        {t('materialEditor.rebind')}
                      </SelectItem>
                      {Object.entries(parameterDeclarations)
                        .filter(([, declaration]) => {
                          const source = data.parameters[name];
                          return (
                            (source?.value === undefined ||
                              (declaration.binding == null &&
                                isUniformValueCompatible(declaration.type, source.value))) &&
                            (source?.binding === undefined ||
                              source.binding === declaration.binding)
                          );
                        })
                        .map(([candidate]) => (
                          <SelectItem key={candidate} value={candidate}>
                            {candidate}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-xs"
                    onClick={() => clearParameter(name)}
                  >
                    {t('materialEditor.remove')}
                  </Button>
                </div>
              ))}
          </section>

          <section
            className="space-y-2 rounded border p-2.5"
            data-workbench-anchor="material.textures"
          >
            <h3 className="text-sm font-medium">{t('materialEditor.textures')}</h3>
            {Object.entries(textureDeclarations)
              .filter(([name, declaration]) => {
                const local = data.textures[name];
                return (
                  (local?.source === undefined ||
                    (declaration.binding == null && !rendererOwnedSamplerNames.has(name))) &&
                  (local?.binding === undefined || local.binding === declaration.binding)
                );
              })
              .map(([name, declaration]) => {
                const local = data.textures[name];
                const current = effective?.textures[name];
                const rendererBound =
                  declaration.binding != null || rendererOwnedSamplerNames.has(name);
                const provenance = effective?.provenance[`textures.${name}`];
                const refId =
                  current?.source && '$ref' in current.source ? current.source.$ref.id : '__none__';
                return (
                  <div
                    key={name}
                    className="grid items-center gap-1.5 rounded border p-1.5 @3xl:grid-cols-[140px_minmax(180px,1fr)_130px_auto]"
                  >
                    <div>
                      <div className="font-mono text-xs">{name}</div>
                      <div className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
                        {provenanceLabel(project, materialId, provenance, t)}
                      </div>
                      {declaration.binding ? (
                        <div className="text-[10px] text-muted-foreground">
                          {declaration.binding}
                        </div>
                      ) : null}
                    </div>
                    {rendererBound ? (
                      <div className="self-center text-xs text-muted-foreground">
                        {t('materialEditor.runtimeSupplied')}
                      </div>
                    ) : (
                      <Select
                        value={refId}
                        onValueChange={(value) => {
                          if (value === '__none__') {
                            const next = { ...local };
                            delete next.source;
                            if (Object.keys(next).length === 0) clearTexture(name);
                            else setTexture(name, next);
                            return;
                          }
                          setTexture(name, {
                            ...local,
                            source: { $ref: { collection: 'assets', id: String(value) } },
                          });
                        }}
                      >
                        <SelectTrigger size="sm" className="w-full min-w-0">
                          <SelectValue>
                            {refId === '__none__'
                              ? t('materialEditor.noTexture')
                              : (() => {
                                  const asset = imageAssets.find(
                                    (candidate) => candidate.id === refId,
                                  );
                                  return asset ? `${asset.label} (${asset.id})` : refId;
                                })()}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent align="start" className="max-w-[28rem]">
                          <SelectItem value="__none__">{t('materialEditor.noTexture')}</SelectItem>
                          {imageAssets.map((asset) => (
                            <SelectItem key={asset.id} value={asset.id}>
                              <span className="block max-w-[24rem] truncate">
                                {asset.label} ({asset.id})
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <Select
                      value={current?.filtering ?? 'clamp-linear'}
                      disabled={rendererBound}
                      onValueChange={(value) =>
                        setTexture(name, {
                          ...local,
                          filtering: value as MaterialTextureData['filtering'],
                        })
                      }
                    >
                      <SelectTrigger size="sm" className="w-full min-w-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="start">
                        {materialTextureFilteringValues.map((filter) => (
                          <SelectItem key={filter} value={filter}>
                            {filter}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-xs"
                      disabled={!local}
                      onClick={() => clearTexture(name)}
                    >
                      {t('materialEditor.reset')}
                    </Button>
                  </div>
                );
              })}
            {Object.keys(data.textures)
              .filter((name) => {
                const declaration = textureDeclarations[name];
                const local = data.textures[name];
                return (
                  !declaration ||
                  (local?.source !== undefined && declaration.binding != null) ||
                  (local?.binding !== undefined && local.binding !== declaration.binding)
                );
              })
              .map((name) => (
                <div
                  key={name}
                  className="grid items-center gap-1.5 rounded border border-dashed p-1.5 text-xs @3xl:grid-cols-[1fr_160px_auto]"
                >
                  <span className="self-center">
                    {t('materialEditor.orphanedTexture', { name })}
                  </span>
                  <Select
                    value="__orphan__"
                    onValueChange={(value) => rebindTexture(name, String(value))}
                  >
                    <SelectTrigger size="sm" className="w-full min-w-0">
                      <SelectValue>{t('materialEditor.rebind')}</SelectValue>
                    </SelectTrigger>
                    <SelectContent align="start">
                      <SelectItem value="__orphan__" disabled>
                        {t('materialEditor.rebind')}
                      </SelectItem>
                      {Object.entries(textureDeclarations)
                        .filter(([, declaration]) => {
                          const source = data.textures[name];
                          return (
                            (source?.source === undefined || declaration.binding == null) &&
                            (source?.binding === undefined ||
                              source.binding === declaration.binding)
                          );
                        })
                        .map(([candidate]) => (
                          <SelectItem key={candidate} value={candidate}>
                            {candidate}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-xs"
                    onClick={() => clearTexture(name)}
                  >
                    {t('materialEditor.remove')}
                  </Button>
                </div>
              ))}
          </section>
        </div>

        <aside
          className="min-h-[420px] overflow-hidden rounded border bg-muted/20"
          data-workbench-anchor="material.preview"
        >
          <MaterialPreview materialId={materialId} />
        </aside>
      </div>
    </div>
  );
}
