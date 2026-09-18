import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { DerivedPreviewPane } from '@/preview/DerivedPreviewPane';
import { useProjectStore } from '@/project/project-store';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import {
  defaultMaterialData,
  materialTextureFilteringValues,
  parseMaterialData,
  resolveMaterialData,
  type MaterialData,
  type MaterialParameterOverride,
  type MaterialTextureData,
} from '../../../shared/project-schema/authoring-materials';
import {
  materialPresetIdValues,
  materialPresets,
  type MaterialPresetId,
} from '../../../shared/project-schema/authoring-material-presets';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import {
  shaderUniformValueSchema,
  type ShaderUniformType,
  type ShaderUniformValue,
} from '../../../shared/project-schema/authoring-shaders';
import {
  buildMaterialPreviewDocumentData,
  buildShaderMaterialProject,
  materialPreviewRevision,
} from '../../../shared/project-schema/shader-material-project';
import { useShaderCompileStore } from '@/shaders/shader-compile-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import type { ShaderCompileOutput } from '../../../shared/editor-tooling';

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
  const [previewData, setPreviewData] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    let active = true;
    if (!project || !materialId) {
      setPreviewData(null);
      return () => {
        active = false;
      };
    }
    void (async () => {
      const shaderProject = await buildShaderMaterialProject(project);
      let outputs: ShaderCompileOutput[] = [];
      if (Object.keys(shaderProject.compilation.programs).length > 0) {
        const response = await useShaderCompileStore
          .getState()
          .runCompile(shaderProject.compilation, undefined, { shaderVariants: ['essl-300'] });
        if (!response.success) return;
        outputs = response.outputs;
      }
      const next = await buildMaterialPreviewDocumentData(project, materialId, outputs);
      if (active) setPreviewData(next);
    })();
    return () => {
      active = false;
    };
  }, [project, materialId]);

  if (!materialId || !record || !project)
    return <div className="p-4 text-sm text-muted-foreground">{t('materialEditor.missing')}</div>;

  const revision = materialPreviewRevision(project, materialId);
  const previewDocument = previewData
    ? {
        kind: 'material-preview' as const,
        recordId: materialId,
        revision,
        data: previewData,
      }
    : undefined;

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

  const baseValue =
    data.base.kind === 'preset'
      ? `preset:${data.base.preset}`
      : `material:${data.base.material.$ref.id}`;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4">
      <div className="flex items-start gap-3" data-workbench-anchor="material.summary">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{record.label}</h2>
            <Badge variant="outline">{materialId}</Badge>
            {effective ? <Badge variant="secondary">{effective.role}</Badge> : null}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t('materialEditor.summary')}</p>
        </div>
      </div>

      {!parsedData ? (
        <div className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {t('materialEditor.invalidData')}
        </div>
      ) : null}
      {resolved.diagnostics.length > 0 ? (
        <div className="mt-3 space-y-1 rounded border p-2 text-xs text-muted-foreground">
          {resolved.diagnostics.map((item) => (
            <div key={`${item.path}:${item.message}`}>{item.message}</div>
          ))}
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 @7xl:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <section
            className="grid gap-3 rounded border p-3 @3xl:grid-cols-2"
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
                      {
                        ...data,
                        base: { kind: 'preset', preset: raw.slice(7) as MaterialPresetId },
                      },
                      t('materialEditor.commands.setPreset'),
                    );
                  } else {
                    commit(
                      {
                        ...data,
                        base: {
                          kind: 'material',
                          material: { $ref: { collection: 'materials', id: raw.slice(9) } },
                        },
                      },
                      t('materialEditor.commands.setBase'),
                    );
                  }
                }}
              >
                {materialPresetIdValues.map((presetId) => (
                  <SelectItem key={presetId} value={`preset:${presetId}`}>
                    {materialPresets[presetId].label} ({t('materialEditor.presetSuffix')})
                  </SelectItem>
                ))}
                {Object.entries(project.materials)
                  .filter(([id]) => id !== materialId)
                  .map(([id, materialRecord]) => (
                    <SelectItem key={id} value={`material:${id}`}>
                      {materialRecord.label} ({id})
                    </SelectItem>
                  ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>{t('materialEditor.effectiveContract')}</Label>
              <div className="flex h-9 items-center gap-2 rounded border px-3 text-xs">
                <span>{effective?.preset.label ?? t('materialEditor.invalidContract')}</span>
                {effective ? <Badge variant="outline">{effective.role}</Badge> : null}
              </div>
            </div>
          </section>

          <section className="space-y-3 rounded border p-3" data-workbench-anchor="material.shader">
            <h3 className="text-sm font-medium">{t('materialEditor.shaderSources')}</h3>
            <p className="text-xs text-muted-foreground">{t('materialEditor.shaderSourcesHelp')}</p>
            {(['vertex', 'fragment', 'varying'] as const).map((stage) => {
              const local = data.shader?.[stage];
              const effectivePath =
                stage === 'vertex'
                  ? effective?.vertexSource
                  : stage === 'fragment'
                    ? effective?.fragmentSource
                    : effective?.varyingDefinition;
              return (
                <div key={stage} className="grid gap-2 @3xl:grid-cols-[100px_1fr_auto]">
                  <Label className="self-center capitalize">{stage}</Label>
                  <Input
                    value={local?.path ?? ''}
                    placeholder={effectivePath ?? ''}
                    onChange={(event) => {
                      const path = event.currentTarget.value.trim();
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
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!local}
                    onClick={() => {
                      const shader = { ...data.shader };
                      delete shader[stage];
                      commit(
                        { ...data, shader: Object.keys(shader).length > 0 ? shader : undefined },
                        t('materialEditor.commands.resetShaderSource'),
                      );
                    }}
                  >
                    {t('materialEditor.reset')}
                  </Button>
                </div>
              );
            })}
          </section>

          <section
            className="space-y-3 rounded border p-3"
            data-workbench-anchor="material.parameters"
          >
            <h3 className="text-sm font-medium">{t('materialEditor.parameters')}</h3>
            {Object.entries(effective?.preset.uniforms ?? {}).map(([name, declaration]) => {
              const local = data.parameters[name];
              const current = effective?.parameters[name];
              const rendererBound = declaration.binding !== undefined;
              return (
                <div
                  key={name}
                  className="grid gap-2 rounded border p-2 @3xl:grid-cols-[160px_120px_1fr_auto]"
                >
                  <div>
                    <div className="font-mono text-xs">{name}</div>
                    <div className="text-[10px] text-muted-foreground">{declaration.type}</div>
                  </div>
                  <Badge
                    variant={local ? 'default' : 'outline'}
                    className="h-7 self-center justify-center"
                  >
                    {declaration.binding ??
                      (local ? t('materialEditor.override') : t('materialEditor.inherited'))}
                  </Badge>
                  {rendererBound ? (
                    <div className="self-center text-xs text-muted-foreground">
                      {t('materialEditor.runtimeSupplied')}
                    </div>
                  ) : declaration.type === 'bool' ? (
                    <Select
                      value={current?.value === true ? 'true' : 'false'}
                      onValueChange={(value) =>
                        setParameter(name, { ...local, value: value === 'true' })
                      }
                    >
                      <SelectItem value="false">false</SelectItem>
                      <SelectItem value="true">true</SelectItem>
                    </Select>
                  ) : (
                    <Input
                      value={valueToText(current?.value)}
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
                    disabled={!local}
                    onClick={() => clearParameter(name)}
                  >
                    {t('materialEditor.reset')}
                  </Button>
                </div>
              );
            })}
            {Object.keys(data.parameters)
              .filter((name) => !effective?.preset.uniforms[name])
              .map((name) => (
                <div
                  key={name}
                  className="flex items-center justify-between rounded border border-dashed p-2 text-xs"
                >
                  <span>{t('materialEditor.orphanedParameter', { name })}</span>
                  <Button size="sm" variant="outline" onClick={() => clearParameter(name)}>
                    {t('materialEditor.remove')}
                  </Button>
                </div>
              ))}
          </section>

          <section
            className="space-y-3 rounded border p-3"
            data-workbench-anchor="material.textures"
          >
            <h3 className="text-sm font-medium">{t('materialEditor.textures')}</h3>
            {Object.entries(effective?.preset.samplers ?? {}).map(([name, declaration]) => {
              const local = data.textures[name];
              const current = effective?.textures[name];
              const rendererBound = declaration.binding !== undefined;
              const refId =
                current?.source && '$ref' in current.source ? current.source.$ref.id : '__none__';
              return (
                <div
                  key={name}
                  className="grid gap-2 rounded border p-2 @3xl:grid-cols-[160px_1fr_160px_auto]"
                >
                  <div>
                    <div className="font-mono text-xs">{name}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {declaration.binding ??
                        (local ? t('materialEditor.override') : t('materialEditor.inherited'))}
                    </div>
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
                      <SelectItem value="__none__">{t('materialEditor.noTexture')}</SelectItem>
                      {imageAssets.map((asset) => (
                        <SelectItem key={asset.id} value={asset.id}>
                          {asset.label} ({asset.id})
                        </SelectItem>
                      ))}
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
                    {materialTextureFilteringValues.map((filter) => (
                      <SelectItem key={filter} value={filter}>
                        {filter}
                      </SelectItem>
                    ))}
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!local}
                    onClick={() => clearTexture(name)}
                  >
                    {t('materialEditor.reset')}
                  </Button>
                </div>
              );
            })}
            {Object.keys(data.textures)
              .filter((name) => !effective?.preset.samplers[name])
              .map((name) => (
                <div
                  key={name}
                  className="flex items-center justify-between rounded border border-dashed p-2 text-xs"
                >
                  <span>{t('materialEditor.orphanedTexture', { name })}</span>
                  <Button size="sm" variant="outline" onClick={() => clearTexture(name)}>
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
          {previewDocument ? (
            <DerivedPreviewPane
              ownerTabId={tab.id}
              previewMode="material"
              previewDocument={previewDocument}
              resetBeforeLoad
            />
          ) : null}
        </aside>
      </div>
    </div>
  );
}
