'use client';

// Re-export the Base UI gradient-picker public surface (which itself
// re-exports the Base UI color-picker), so a single import point covers
// the whole Base UI fill-picker public surface: color + gradient + the
// fill switcher below.
export * from './gradient';
export { ColorPickerBase, GradientPickerBase } from './gradient';

// Root/Tabs/Tab/Pane are plain markup (role="tablist"/"tab", no Radix
// primitive underneath) — reused unmodified from the original.
import { Root as FillRoot } from '@/components/ui/fill-picker/parts/fill/root';
import { Tabs as FillTabs, Tab as FillTab } from '@/components/ui/fill-picker/parts/fill/tabs';
import { Pane as FillPane } from '@/components/ui/fill-picker/parts/fill/pane';

export type { Fill, ColorFill, GradientFill } from '@/components/ui/fill-picker/lib/gradient';
export { formatFill, parseFill } from '@/components/ui/fill-picker/lib/gradient';
export { useFillPicker } from '@/components/ui/fill-picker/hooks/use-fill-picker';
export type {
  UseFillPickerProps,
  FillPickerState,
  FillMode,
} from '@/components/ui/fill-picker/hooks/use-fill-picker';

export const FillPickerBase = {
  Root: FillRoot,
  Tabs: FillTabs,
  Tab: FillTab,
  Pane: FillPane,
};

// Plain-name alias — see `GradientPicker` / `ColorPicker` in gradient.tsx.
export const FillPicker = FillPickerBase;
