import { Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslation } from 'react-i18next';

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
    <div className={`space-y-2 rounded border bg-muted/20 ${compact ? 'p-1.5' : 'p-2'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">{t('propertyManager.traits.title')}</span>
        {attached.map((trait) => (
          <div
            key={trait.id}
            className="flex items-center gap-1 rounded border bg-background px-2 py-1"
          >
            {trait.color ? (
              <span
                className="size-2 shrink-0 rounded-full border"
                style={{ backgroundColor: trait.color }}
              />
            ) : null}
            <span className="text-xs">{trait.label}</span>
            {trait.removable !== false ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t('propertyManager.traits.detach', { id: trait.id })}
                onClick={() => onDetach(trait.id)}
              >
                <Unlink className="size-3" />
              </Button>
            ) : null}
            {trait.inherited ? (
              <span className="px-1 text-[10px] text-muted-foreground">
                {t('propertyManager.traits.inherited')}
              </span>
            ) : null}
          </div>
        ))}
        {attached.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            {t('propertyManager.traits.noneAttached')}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Select value={selectedId} onValueChange={(value) => onSelectedIdChange(value ?? '')}>
          <SelectTrigger
            className={compact ? '!h-7 min-w-40' : '!h-8 min-w-48'}
            aria-label={t('propertyManager.traits.selectLabel')}
          >
            <SelectValue placeholder={t('propertyManager.traits.choose')} />
          </SelectTrigger>
          <SelectContent>
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
          onClick={() => selectedId && onAttach(selectedId)}
        >
          {t('propertyManager.traits.attach')}
        </Button>
      </div>
    </div>
  );
}
