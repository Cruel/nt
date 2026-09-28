import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  DebugReportExportButton,
  debugReportFilename,
} from '@/editors/preview/DebugReportExportButton';
import { devtoolsDebugReportFixture } from './fixtures/devtools-debug-report';

describe('DebugReportExportButton', () => {
  it('requests one typed report and downloads it as JSON', async () => {
    const user = userEvent.setup();
    const report = devtoolsDebugReportFixture();
    const requestReport = vi.fn().mockResolvedValue(report);
    const createObjectUrl = vi.fn((_blob: Blob) => 'blob:debug-report');
    const revokeObjectUrl = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: createObjectUrl,
      revokeObjectURL: revokeObjectUrl,
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<DebugReportExportButton supported={true} requestReport={requestReport} />);
    await user.click(screen.getByRole('button', { name: 'Export Debug Report' }));

    await waitFor(() => expect(requestReport).toHaveBeenCalledTimes(1));
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(createObjectUrl.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:debug-report');
  });

  it('stays disabled when the preview does not advertise debug-report export', () => {
    render(<DebugReportExportButton supported={false} requestReport={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Export Debug Report' })).toBeDisabled();
  });

  it('uses a filesystem-safe timestamped filename', () => {
    expect(debugReportFilename(new Date('2026-09-28T05:12:34.567Z'))).toBe(
      'noveltea-debug-report-2026-09-28T05-12-34-567Z.json',
    );
  });
});
