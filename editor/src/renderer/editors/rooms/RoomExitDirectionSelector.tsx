import {
  ArrowDown,
  ArrowDownLeft,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  CircleDashed,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { RoomExitData } from '../../../shared/project-schema/authoring-rooms';

type RoomExitDirection = RoomExitData['direction'];

const directionOptions: Array<{
  direction: RoomExitDirection;
  label: string;
  icon: LucideIcon;
}> = [
  { direction: 'northwest', label: 'Northwest', icon: ArrowUpLeft },
  { direction: 'north', label: 'North', icon: ArrowUp },
  { direction: 'northeast', label: 'Northeast', icon: ArrowUpRight },
  { direction: 'west', label: 'West', icon: ArrowLeft },
  { direction: 'custom', label: 'Custom direction', icon: CircleDashed },
  { direction: 'east', label: 'East', icon: ArrowRight },
  { direction: 'southwest', label: 'Southwest', icon: ArrowDownLeft },
  { direction: 'south', label: 'South', icon: ArrowDown },
  { direction: 'southeast', label: 'Southeast', icon: ArrowDownRight },
];

export function RoomExitDirectionSelector({
  value,
  onValueChange,
}: {
  value: RoomExitDirection;
  onValueChange: (value: RoomExitDirection) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Exit direction"
      className="grid w-fit grid-cols-3 gap-px rounded border bg-muted/15 p-0.5"
    >
      {directionOptions.map((option) => {
        const Icon = option.icon;
        const selected = value === option.direction;
        return (
          <Button
            key={option.direction}
            type="button"
            size="icon-xs"
            variant={selected ? 'secondary' : 'ghost'}
            aria-label={option.label}
            aria-pressed={selected}
            title={option.label}
            className={cn(
              'size-5 rounded-sm',
              selected && 'border border-primary/30 bg-primary/15 text-primary shadow-sm',
            )}
            onClick={() => onValueChange(option.direction)}
          >
            <Icon className="size-2.5" aria-hidden="true" />
          </Button>
        );
      })}
    </div>
  );
}
