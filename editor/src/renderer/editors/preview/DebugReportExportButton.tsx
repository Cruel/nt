import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { DevtoolsDebugReport } from '../../../shared/preview-protocol';

export function debugReportFilename(now = new Date()) {
  return `noveltea-debug-report-${now.toISOString().replace(/[:.]/g, '-')}.json`;
}

function downloadDebugReport(report: DevtoolsDebugReport) {
  const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = debugReportFilename();
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function DebugReportExportButton({
  supported,
  requestReport,
}: {
  supported: boolean;
  requestReport: (() => Promise<DevtoolsDebugReport>) | null;
}) {
  const { t } = useTranslation('workspace');
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = !supported || !requestReport || exporting;

  const exportReport = async () => {
    if (disabled || !requestReport) return;
    setExporting(true);
    setError(null);
    try {
      downloadDebugReport(await requestReport());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => void exportReport()}
      >
        <Download className="h-3.5 w-3.5" />
        {exporting ? t('debugReport.exporting') : t('debugReport.export')}
      </Button>
      {error ? <div className="text-xs text-destructive">{error}</div> : null}
    </div>
  );
}
