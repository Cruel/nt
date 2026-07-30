import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  ColorPicker,
  isValidColor,
  parseColor,
  type OklchColor,
} from '@/components/ui/fill-picker/color-picker';

interface ColorFieldProps {
  value: string | null;
  onValueChange: (value: string | null) => void;
  ariaLabel?: string;
}

export function ColorField({ value, onValueChange, ariaLabel = 'Color value' }: ColorFieldProps) {
  const pickerValue = value && isValidColor(value) ? value : '#000000';
  const [pickerColor, setPickerColor] = useState<OklchColor>(
    () => parseColor(pickerValue) ?? { l: 0, c: 0, h: 0, alpha: 1 },
  );
  const lastPickerEmissionRef = useRef<string | null>(null);

  useEffect(() => {
    if (value === lastPickerEmissionRef.current) return;
    setPickerColor(parseColor(pickerValue) ?? { l: 0, c: 0, h: 0, alpha: 1 });
  }, [pickerValue, value]);

  return (
    <div className="flex items-center gap-1.5">
      <Popover>
        <PopoverTrigger
          aria-label={`Choose ${ariaLabel.toLowerCase()}`}
          className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md border border-input bg-input/20 px-2 outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
        >
          <span
            className="block size-4 shrink-0 rounded-sm border border-black/20"
            style={{ background: pickerValue }}
          />
          <span className="min-w-0 truncate font-mono text-xs text-foreground">
            {value || 'Project default'}
          </span>
        </PopoverTrigger>
        <PopoverContent side="bottom" align="start" className="w-[296px] p-2">
          <ColorPicker.Root
            value={pickerColor}
            format="hex"
            formats={['hex']}
            onValueChange={(color, __, formats) => {
              setPickerColor(color);
              lastPickerEmissionRef.current = formats.hex;
              onValueChange(formats.hex);
            }}
            className="max-w-none border-0 bg-transparent p-0 shadow-none"
          >
            <ColorPicker.Area gamut="srgb" showWarningLines={false} className="h-40" />
            <ColorPicker.Hue />
            <div className="flex items-center gap-2">
              <ColorPicker.Preview className="size-7" />
              <ColorPicker.CssInput />
              <ColorPicker.EyeDropper />
            </div>
          </ColorPicker.Root>
        </PopoverContent>
      </Popover>
      {value ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 shrink-0"
          aria-label={`Clear ${ariaLabel.toLowerCase()}`}
          onClick={() => onValueChange(null)}
        >
          <X className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
