import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { MaterialPreview } from '@/material-preview/MaterialPreview';
import { useMaterialPreviewResource } from '@/material-preview/material-preview-provider';
import type { MaterialPreviewResource } from '@/material-preview/material-preview-resources';
import { cn } from '@/lib/utils';
import type { MaterialStandardFacet } from '../../../shared/project-schema/authoring-material-applications';
import type { AuthoringProject } from '../../../shared/project-schema/authoring-project';
import { materialContractRegistry } from '../../../shared/project-schema/material-contract-registry.generated';
import { resolveMaterialData } from '../../../shared/project-schema/authoring-materials';
import {
  isUniformValueCompatible,
  type ShaderRole,
  type ShaderUniformType,
  type ShaderUniformValue,
} from '../../../shared/project-schema/authoring-shaders';

export interface MaterialSelectorParameterOverride {
  type: ShaderUniformType;
  value?: ShaderUniformValue;
  standardFacet?: MaterialStandardFacet;
}

export interface MaterialSelectorTextureOverride {
  assetId: string;
}

export interface MaterialSelectorOccurrenceOverrides {
  parameters: Readonly<Record<string, MaterialSelectorParameterOverride>>;
  textures?: Readonly<Record<string, MaterialSelectorTextureOverride>>;
}

export interface MaterialSelectorCompatibilityResult {
  compatible: boolean;
  reason?: string;
}

export interface MaterialSelectorCandidateContext {
  project: AuthoringProject;
  materialId: string;
  role: ShaderRole | null;
}

export interface MaterialSelectorProps {
  project: AuthoringProject;
  value: string | null;
  onValueChange: (materialId: string) => void;
  expectedRole?: ShaderRole;
  compatibility?: (
    candidate: MaterialSelectorCandidateContext,
  ) => MaterialSelectorCompatibilityResult;
  occurrenceOverrides?: MaterialSelectorOccurrenceOverrides;
  ariaLabel?: string;
  className?: string;
}

interface CandidateDescriptor {
  id: string;
  label: string;
  compatible: boolean;
  reason: string | null;
}

export interface MaterialSelectorOverrideTransfer {
  values: Readonly<
    Record<string, ShaderUniformValue | { kind: 'standard-facet'; facet: MaterialStandardFacet }>
  >;
  textures: Readonly<Record<string, string>>;
  appliedCount: number;
  totalCount: number;
}

export function transferMaterialSelectorOverrides(
  resource: MaterialPreviewResource | null,
  overrides: MaterialSelectorOccurrenceOverrides | undefined,
): MaterialSelectorOverrideTransfer {
  const parameterEntries = Object.entries(overrides?.parameters ?? {});
  const textureEntries = Object.entries(overrides?.textures ?? {});
  const values: Record<
    string,
    ShaderUniformValue | { kind: 'standard-facet'; facet: MaterialStandardFacet }
  > = {};
  const textures: Record<string, string> = {};
  if (resource?.derivedInterface) {
    const rendererOwnedSamplers = new Set(
      materialContractRegistry.roles
        .find((role) => role.id === resource.resolved.role)
        ?.reservedInterface.samplers.filter((sampler) => sampler.sourceOwnership === 'renderer')
        .map((sampler) => sampler.name) ?? [],
    );
    for (const [name, override] of parameterEntries) {
      const declaration = resource.derivedInterface.uniforms[name];
      if (!declaration || declaration.binding != null || declaration.type !== override.type)
        continue;
      if (override.standardFacet && declaration.type === 'float')
        values[name] = { kind: 'standard-facet', facet: override.standardFacet };
      else if (
        override.value !== undefined &&
        isUniformValueCompatible(declaration.type, override.value)
      )
        values[name] = override.value;
    }
    for (const [name, override] of textureEntries) {
      const declaration = resource.derivedInterface.samplers[name];
      if (declaration && declaration.binding == null && !rendererOwnedSamplers.has(name))
        textures[name] = override.assetId;
    }
  }
  return {
    values,
    textures,
    appliedCount: Object.keys(values).length + Object.keys(textures).length,
    totalCount: parameterEntries.length + textureEntries.length,
  };
}

function MaterialSelectorPreview({
  materialId,
  occurrenceOverrides,
  applyOverrides,
  className,
}: {
  materialId: string;
  occurrenceOverrides?: MaterialSelectorOccurrenceOverrides;
  applyOverrides: boolean;
  className?: string;
}) {
  const resource = useMaterialPreviewResource(materialId);
  const transfer = transferMaterialSelectorOverrides(resource, occurrenceOverrides);
  return (
    <MaterialPreview
      materialId={materialId}
      compact
      className={className}
      parameterOverrides={applyOverrides ? transfer.values : undefined}
      textureOverrides={applyOverrides ? transfer.textures : undefined}
    />
  );
}

function MaterialCandidate({
  candidate,
  selected,
  occurrenceOverrides,
  applyOverrides,
  onSelect,
}: {
  candidate: CandidateDescriptor;
  selected: boolean;
  occurrenceOverrides?: MaterialSelectorOccurrenceOverrides;
  applyOverrides: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation('workspace');
  const resource = useMaterialPreviewResource(candidate.id);
  const transfer = transferMaterialSelectorOverrides(resource, occurrenceOverrides);
  const partial =
    applyOverrides &&
    transfer.totalCount > 0 &&
    transfer.appliedCount > 0 &&
    transfer.appliedCount < transfer.totalCount;

  return (
    <button
      type="button"
      className={cn(
        'group flex min-w-0 flex-col overflow-hidden rounded-md border bg-background text-left outline-none transition hover:border-ring focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30',
        selected && 'border-ring ring-1 ring-ring/30',
        !candidate.compatible && 'cursor-not-allowed opacity-70',
      )}
      disabled={!candidate.compatible}
      aria-label={`${t('materialSelector.select')} ${candidate.label}`}
      data-material-selector-candidate={candidate.id}
      data-applied-overrides={applyOverrides ? transfer.appliedCount : 0}
      data-total-overrides={transfer.totalCount}
      onClick={onSelect}
    >
      <div className="h-28 w-full bg-black">
        <MaterialPreview
          materialId={candidate.id}
          compact
          parameterOverrides={applyOverrides ? transfer.values : undefined}
          textureOverrides={applyOverrides ? transfer.textures : undefined}
        />
      </div>
      <div className="min-w-0 space-y-0.5 px-2 py-1.5">
        <div className="truncate text-xs font-medium">{candidate.label}</div>
        <div className="truncate text-[10px] text-muted-foreground">{candidate.id}</div>
        {!candidate.compatible && candidate.reason ? (
          <div className="text-[10px] text-destructive">{candidate.reason}</div>
        ) : partial ? (
          <div className="text-[10px] text-amber-600 dark:text-amber-400">
            {t('materialSelector.partialOverrides', {
              applied: transfer.appliedCount,
              total: transfer.totalCount,
            })}
          </div>
        ) : null}
      </div>
    </button>
  );
}

export function MaterialSelector({
  project,
  value,
  onValueChange,
  expectedRole,
  compatibility,
  occurrenceOverrides,
  ariaLabel,
  className,
}: MaterialSelectorProps) {
  const { t } = useTranslation('workspace');
  const [open, setOpen] = useState(false);
  const [showIncompatible, setShowIncompatible] = useState(false);
  const [previewOccurrenceOverrides, setPreviewOccurrenceOverrides] = useState(true);
  const [search, setSearch] = useState('');
  const incompatibleId = useId();
  const overridesId = useId();
  const selected = value ? project.materials[value] : null;
  const overrideCount =
    Object.keys(occurrenceOverrides?.parameters ?? {}).length +
    Object.keys(occurrenceOverrides?.textures ?? {}).length;
  const candidates = useMemo<CandidateDescriptor[]>(
    () =>
      Object.entries(project.materials)
        .map(([id, record]) => {
          const resolved = resolveMaterialData(project, id).data;
          const result: MaterialSelectorCompatibilityResult = !resolved
            ? { compatible: false, reason: t('materialSelector.invalidMaterial') }
            : expectedRole && resolved.role !== expectedRole
              ? {
                  compatible: false,
                  reason: t('materialSelector.roleMismatch', {
                    expected: expectedRole,
                    actual: resolved.role,
                  }),
                }
              : (compatibility?.({ project, materialId: id, role: resolved.role }) ?? {
                  compatible: true,
                });
          return {
            id,
            label: record.label,
            compatible: result.compatible,
            reason: result.reason ?? null,
          };
        })
        .sort(
          (left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id),
        ),
    [compatibility, expectedRole, project, t],
  );
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleCandidates = candidates.filter(
    (candidate) =>
      (candidate.compatible || showIncompatible) &&
      (!normalizedSearch ||
        candidate.label.toLocaleLowerCase().includes(normalizedSearch) ||
        candidate.id.toLocaleLowerCase().includes(normalizedSearch)),
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={ariaLabel ?? t('materialSelector.choose')}
        className={cn(
          'flex h-24 w-full min-w-0 overflow-hidden rounded-md border bg-background text-left outline-none hover:border-ring focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30',
          className,
        )}
      >
        {value && selected ? (
          <>
            <div className="h-full w-32 shrink-0 bg-black">
              <MaterialSelectorPreview
                materialId={value}
                occurrenceOverrides={occurrenceOverrides}
                applyOverrides
              />
            </div>
            <div className="min-w-0 self-center px-3">
              <div className="truncate text-sm font-medium">{selected.label}</div>
              <div className="truncate text-xs text-muted-foreground">{value}</div>
            </div>
          </>
        ) : (
          <div className="flex h-full w-full items-center px-3 text-sm text-muted-foreground">
            {t('materialSelector.unassigned')}
          </div>
        )}
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        className="w-[560px] max-w-[90vw] p-2"
      >
        <div className="space-y-2">
          <Input
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder={t('materialSelector.search')}
            aria-label={t('materialSelector.search')}
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <label htmlFor={incompatibleId} className="flex items-center gap-2">
              <input
                id={incompatibleId}
                type="checkbox"
                checked={showIncompatible}
                onChange={(event) => setShowIncompatible(event.currentTarget.checked)}
              />
              {t('materialSelector.showIncompatible')}
            </label>
            {overrideCount > 0 ? (
              <label htmlFor={overridesId} className="flex items-center gap-2">
                <input
                  id={overridesId}
                  type="checkbox"
                  checked={previewOccurrenceOverrides}
                  onChange={(event) => setPreviewOccurrenceOverrides(event.currentTarget.checked)}
                />
                {t('materialSelector.previewOccurrenceOverrides')}
              </label>
            ) : null}
          </div>
          <div className="grid max-h-[420px] grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2 overflow-y-auto pr-1">
            {visibleCandidates.map((candidate) => (
              <MaterialCandidate
                key={candidate.id}
                candidate={candidate}
                selected={candidate.id === value}
                occurrenceOverrides={occurrenceOverrides}
                applyOverrides={previewOccurrenceOverrides}
                onSelect={() => {
                  if (candidate.id !== value) onValueChange(candidate.id);
                  setOpen(false);
                }}
              />
            ))}
          </div>
          {visibleCandidates.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted-foreground">
              {t('materialSelector.noMatches')}
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
