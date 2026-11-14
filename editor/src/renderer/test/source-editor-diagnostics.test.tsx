import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vite-plus/test';
import { SourceEditor } from '@/components/source/SourceEditor';

describe('SourceEditor diagnostic propagation', () => {
  it('replaces CodeMirror markers when diagnostics change without another text edit', async () => {
    const value = 'broken: [';
    const { container, rerender } = render(
      <SourceEditor
        value={value}
        diagnostics={[{ from: 0, to: 6, message: 'Old YAML error', severity: 'error' }]}
      />,
    );
    await waitFor(() => expect(container.querySelector('.cm-lintRange-error')).toBeInTheDocument());

    rerender(<SourceEditor value={value} diagnostics={[]} />);
    await waitFor(() =>
      expect(container.querySelector('.cm-lintRange-error')).not.toBeInTheDocument(),
    );

    rerender(
      <SourceEditor
        value={value}
        diagnostics={[{ from: 0, to: 6, message: 'New YAML error', severity: 'error' }]}
      />,
    );
    await waitFor(() => expect(container.querySelector('.cm-lintRange-error')).toBeInTheDocument());
  });
});
