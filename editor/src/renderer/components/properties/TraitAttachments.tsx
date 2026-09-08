import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslation } from 'react-i18next';
import { buildTraitsEditorTab } from '@/workbench/editor-registry';
import { navigateToWorkbenchTarget } from '@/workbench/workbench-navigation';
import { contrastingTextColor } from '@/components/ui/fill-picker/lib/color';

export interface PropertyManagerTraitAttachment {
  id: string;
  label: string;
  color?: string | null;
  inherited?: boolean;
  removable?: boolean;
}

export interface PropertyManagerTraitChoice {
  id: string;
  label: string;
  color?: string | null;
}

export function TraitAttachments({
  attached,
  available,
  selectedId,
  onSelectedIdChange,
  onAttach,
  onDetach,
  compact = false,
}: {
  attached: readonly PropertyManagerTraitAttachment[];
  available: readonly PropertyManagerTraitChoice[];
  selectedId: string;
  onSelectedIdChange: (id: string) => void;
  onAttach: (id: string) => void;
  onDetach: (id: string) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation('workspace');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium">{t('propertyManager.traits.title')}</span>
      {attached.map((trait) => {
        const foreground = trait.color ? contrastingTextColor(trait.color) : null;
        return (
          <div
            key={trait.id}
            className={`group/trait relative flex items-center gap-1 rounded border px-2 ${compact ? 'h-7' : 'h-8'}`}
            style={
              trait.color
                ? { backgroundColor: trait.color, color: foreground ?? undefined }
                : undefined
            }
          >
            <button
              type="button"
              className="absolute inset-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              aria-label={trait.label}
              onClick={() =>
                navigateToWorkbenchTarget({
                  tab: buildTraitsEditorTab(),
                  target: { id: `trait.${trait.id}`, block: 'center', flash: true },
                })
              }
            />
            <span className="pointer-events-none relative z-10 px-1 text-xs">{trait.label}</span>
            {trait.inherited ? (
              <span className="pointer-events-none relative z-10 px-1 text-[10px] opacity-75">
                {t('propertyManager.traits.inherited')}
              </span>
            ) : null}
            {trait.removable !== false ? (
              <Button
                size="icon-xs"
                variant="ghost"
                className="relative z-10 opacity-55 group-hover/trait:opacity-100"
                aria-label={t('propertyManager.traits.detach', { id: trait.id })}
                onClick={() => onDetach(trait.id)}
              >
                <X className="size-3" />
              </Button>
            ) : null}
          </div>
        );
      })}
      {available.length > 0 ? (
        <div className="flex items-center gap-1.5">
          <Select value={selectedId} onValueChange={(value) => onSelectedIdChange(value ?? '')}>
            <SelectTrigger
              className={compact ? '!h-7 min-w-40' : '!h-8 min-w-48'}
              aria-label={t('propertyManager.traits.selectLabel')}
            >
              <SelectValue placeholder={t('propertyManager.traits.choose')}>
                {(value) =>
                  value
                    ? (available.find((trait) => trait.id === value)?.label ?? String(value))
                    : t('propertyManager.traits.choose')
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger>
              <SelectItem value="">{t('propertyManager.traits.choose')}</SelectItem>
              {available.map((trait) => (
                <SelectItem key={trait.id} value={trait.id}>
                  {trait.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            disabled={!selectedId}
            aria-label={t('propertyManager.traits.attach')}
            onClick={() => selectedId && onAttach(selectedId)}
          >
            {t('propertyManager.traits.attachButton')}
          </Button>
        </div>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          navigateToWorkbenchTarget({
            tab: buildTraitsEditorTab(),
            target: { id: 'traits.create' },
          })
        }
      >
        <Plus className="size-4" /> New Trait
      </Button>
    </div>
  );
}
