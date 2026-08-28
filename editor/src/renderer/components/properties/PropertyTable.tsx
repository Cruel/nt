import {
  ArrowDown,
  ArrowUp,
  Braces,
  Hash,
  List,
  RotateCcw,
  Text,
  ToggleLeft,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from 'react-i18next';
import type { AuthoredRuntimeValue } from '../../../shared/project-schema/authoring-properties';
import type { VariableType } from '../../../shared/project-schema/authoring-variables';

export interface PropertyManagerTraitSource {
  id: string;
  label: string;
  color?: string | null;
}

export interface PropertyManagerRow {
  id: string;
  label?: string;
  description?: string;
  type: VariableType;
  nullable: boolean;
  enumValues?: readonly string[];
  value?: AuthoredRuntimeValue;
  valueState?: 'normal' | 'missing' | 'conflict';
  sourceLabel?: string;
  usageCount?: number;
  traitSources?: readonly PropertyManagerTraitSource[];
  appearance?: 'normal' | 'local-only';
  editMode?: 'schema' | 'value' | null;
  actionLabel?: string;
  resettable?: boolean;
  deletable?: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}

function typeIcon(type: VariableType) {
  if (type === 'boolean') return ToggleLeft;
  if (type === 'integer' || type === 'number') return Hash;
  if (type === 'string') return Text;
  if (type === 'enum') return List;
  return Braces;
}

function provenanceBackground(sources: readonly PropertyManagerTraitSource[] | undefined) {
  const colors = [...(sources ?? [])]
    .sort((left, right) => left.id.localeCompare(right.id))
    .flatMap((source) => (source.color ? [source.color] : []));
  if (colors.length === 0) return undefined;
  if (colors.length === 1) return colors[0];
  const segment = 100 / colors.length;
  return `linear-gradient(to right, ${colors
    .flatMap((color, index) => [
      `${color} ${index * segment}%`,
      `${color} ${(index + 1) * segment}%`,
    ])
    .join(', ')})`;
}

export function PropertyTable({
  rows,
  propertyColumnLabel,
  valueColumnLabel,
  emptyLabel,
  onEdit,
  onReset,
  onDelete,
  onMove,
  onShowUsages,
  rowAnchor,
}: {
  rows: readonly PropertyManagerRow[];
  propertyColumnLabel?: string;
  valueColumnLabel: string;
  emptyLabel: string;
  onEdit: (row: PropertyManagerRow) => void;
  onReset: (row: PropertyManagerRow) => void;
  onDelete: (row: PropertyManagerRow) => void;
  onMove?: (row: PropertyManagerRow, direction: 'up' | 'down') => void;
  onShowUsages?: (row: PropertyManagerRow) => void;
  rowAnchor?: (row: PropertyManagerRow) => string | undefined;
}) {
  const { t } = useTranslation('workspace');
  const resolvedPropertyColumnLabel = propertyColumnLabel ?? t('propertyManager.table.property');
  const formatValue = (row: PropertyManagerRow) => {
    if (row.valueState === 'conflict') return t('propertyManager.values.conflictingDefaults');
    if (row.valueState === 'missing' || row.value === undefined)
      return t('propertyManager.values.missing');
    if (row.value === null) return t('propertyManager.values.null');
    if (typeof row.value === 'string')
      return row.value === '' ? t('propertyManager.values.emptyString') : JSON.stringify(row.value);
    return String(row.value);
  };
  const typeLabel = (type: VariableType) => t(`propertyManager.types.${type}`);

  return (
    <div className="overflow-hidden rounded border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="w-px whitespace-nowrap px-3 py-2 text-center">
              {t('propertyManager.table.use')}
            </th>
            <th className="whitespace-nowrap px-3 py-2">{resolvedPropertyColumnLabel}</th>
            <th className="w-px whitespace-nowrap px-2 py-2 text-center">
              {t('propertyManager.table.type')}
            </th>
            <th className="whitespace-nowrap px-3 py-2">{valueColumnLabel}</th>
            <th className="px-3 py-2">{t('propertyManager.table.description')}</th>
            <th className="w-px">
              <span className="sr-only">{t('propertyManager.table.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} className="p-8 text-center text-sm text-muted-foreground">
                {emptyLabel}
              </td>
            </tr>
          ) : null}
          {rows.map((row) => {
            const Icon = typeIcon(row.type);
            const displayLabel = row.label || row.id;
            const traitSources = row.traitSources ?? [];
            const provenanceTitle = traitSources.length
              ? t('propertyManager.table.traitSources', {
                  sources: traitSources.map((source) => source.label).join(', '),
                })
              : undefined;
            const editable = row.editMode !== null && row.editMode !== undefined;
            return (
              <tr
                key={row.id}
                className={`group/row border-t align-middle ${editable ? 'cursor-pointer hover:bg-muted/30' : ''} ${row.appearance === 'local-only' ? 'bg-muted/15' : ''}`}
                data-workbench-anchor={rowAnchor?.(row)}
                onClick={() => editable && onEdit(row)}
              >
                <td
                  className="w-px whitespace-nowrap px-3 py-2 text-center"
                  style={{ background: provenanceBackground(traitSources) }}
                  title={provenanceTitle}
                  aria-label={
                    provenanceTitle
                      ? t('propertyManager.table.useCountWithSources', {
                          count: row.usageCount ?? 0,
                          sources: provenanceTitle,
                        })
                      : t('propertyManager.table.useCount', { count: row.usageCount ?? 0 })
                  }
                >
                  {onShowUsages ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 min-w-7 bg-background/85 px-2 font-mono"
                      onClick={(event) => {
                        event.stopPropagation();
                        onShowUsages(row);
                      }}
                      aria-label={t('propertyManager.table.usagesFor', {
                        count: row.usageCount ?? 0,
                        id: row.id,
                      })}
                    >
                      {row.usageCount ?? 0}
                    </Button>
                  ) : (
                    <span className="inline-flex h-7 min-w-7 items-center justify-center rounded bg-background/85 px-2 font-mono text-foreground shadow-sm">
                      {row.usageCount ?? 0}
                    </span>
                  )}
                </td>
                <td className="max-w-64 whitespace-nowrap px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{displayLabel}</div>
                    {displayLabel !== row.id ? (
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {row.id}
                      </div>
                    ) : null}
                  </div>
                </td>
                <td className="w-px whitespace-nowrap px-2 py-2 text-center">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="inline-flex size-7 items-center justify-center rounded text-muted-foreground" />
                        }
                      >
                        <Icon className="size-4" />
                      </TooltipTrigger>
                      <TooltipContent>
                        {row.nullable
                          ? t('propertyManager.table.nullableType', { type: typeLabel(row.type) })
                          : typeLabel(row.type)}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </td>
                <td
                  className="max-w-64 truncate whitespace-nowrap px-3 py-2 font-mono text-xs"
                  title={formatValue(row)}
                >
                  {formatValue(row)}
                  {row.sourceLabel ? (
                    <span className="ml-2 font-sans text-muted-foreground">{row.sourceLabel}</span>
                  ) : null}
                </td>
                <td className="truncate px-3 py-2 text-muted-foreground" title={row.description}>
                  {row.description || '—'}
                </td>
                <td className="sticky right-0 w-px whitespace-nowrap bg-background/90 px-1 py-1 text-right">
                  <div className="flex justify-end gap-0.5">
                    {onMove && (row.canMoveUp !== undefined || row.canMoveDown !== undefined) ? (
                      <>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          disabled={!row.canMoveUp}
                          aria-label={t('propertyManager.actions.moveUp', { id: row.id })}
                          onClick={(event) => {
                            event.stopPropagation();
                            onMove(row, 'up');
                          }}
                        >
                          <ArrowUp className="size-3" />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          disabled={!row.canMoveDown}
                          aria-label={t('propertyManager.actions.moveDown', { id: row.id })}
                          onClick={(event) => {
                            event.stopPropagation();
                            onMove(row, 'down');
                          }}
                        >
                          <ArrowDown className="size-3" />
                        </Button>
                      </>
                    ) : null}
                    {row.resettable ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t('propertyManager.actions.reset', { id: row.id })}
                        onClick={(event) => {
                          event.stopPropagation();
                          onReset(row);
                        }}
                      >
                        <RotateCcw className="size-4" />
                      </Button>
                    ) : null}
                    {row.actionLabel && editable ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(event) => {
                          event.stopPropagation();
                          onEdit(row);
                        }}
                      >
                        {row.actionLabel}
                      </Button>
                    ) : null}
                    {row.deletable ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-destructive"
                        aria-label={t('propertyManager.actions.delete', { label: displayLabel })}
                        onClick={(event) => {
                          event.stopPropagation();
                          onDelete(row);
                        }}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
