import { render } from '@testing-library/react';
import { describe, expect, it } from 'vite-plus/test';
import { FillPickerBase } from '@/components/ui/fill-picker-base/fill';
import { GradientPickerBase } from '@/components/ui/fill-picker-base/gradient';

describe('Base UI fill-picker wrappers', () => {
  it('uses the gradient picker root rather than the solid color picker root', () => {
    const view = render(<GradientPickerBase.Root />);

    expect(view.container.firstElementChild).toHaveAttribute('data-slot', 'gradient-picker');
  });

  it('uses the fill picker root rather than the solid color picker root', () => {
    const view = render(<FillPickerBase.Root />);

    expect(view.container.firstElementChild).toHaveAttribute('data-slot', 'fill-picker');
  });
});
