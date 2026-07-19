import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { ComfyUiStatusIndicator } from '@/comfyui/ComfyUiStatusIndicator';
import { useComfyUiStore } from '@/comfyui/comfyui-store';

describe('ComfyUiStatusIndicator', () => {
  beforeEach(() => {
    useComfyUiStore.setState((state) => ({
      ...state,
      config: { ...state.config, enabled: false },
      status: { ...state.status, state: 'disabled', message: 'ComfyUI disabled' },
    }));
  });

  it('does not render while ComfyUI integration is disabled', () => {
    const { container } = render(<ComfyUiStatusIndicator />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('ComfyUI disabled')).not.toBeInTheDocument();
  });

  it('renders when ComfyUI integration is enabled', () => {
    useComfyUiStore.setState((state) => ({
      ...state,
      config: { ...state.config, enabled: true },
      status: { ...state.status, state: 'unchecked', message: 'ComfyUI not checked' },
    }));

    const { container } = render(<ComfyUiStatusIndicator />);

    expect(screen.getByText('ComfyUI not checked')).toBeInTheDocument();
    expect(container).toHaveTextContent('|');
  });
});
