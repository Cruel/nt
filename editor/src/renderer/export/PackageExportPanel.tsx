import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { usePackageExportStore, type PackageExportWorkflowResult } from './package-export-store';

function diagnosticBadge(severity: string) {
  return severity === 'error' ? 'destructive' : severity === 'warning' ? 'secondary' : 'outline';
}

function normalizeResult(value: unknown): PackageExportWorkflowResult | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<PackageExportWorkflowResult>;
  if (!('stage' in record) && !('manifestPreview' in record) && !('packageResponse' in record)) return null;
  return record as PackageExportWorkflowResult;
}

function manifestEntries(result: PackageExportWorkflowResult): Array<Record<string, unknown>> {
  const manifest = result.manifest && typeof result.manifest === 'object' ? result.manifest as Record<string, unknown> : null;
  return Array.isArray(manifest?.entries) ? manifest.entries.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object') : [];
}

function ManifestSummary({ result }: { result: PackageExportWorkflowResult }) {
  const manifest = result.manifest && typeof result.manifest === 'object' ? result.manifest as Record<string, unknown> : null;
  const entries = manifestEntries(result);
  const entryCount = entries.length || result.manifestPreview?.entryCount || 0;
  return (
    <section className="space-y-2">
      <div className="font-medium">Manifest</div>
      <div className="grid grid-cols-2 gap-2 rounded border p-2 text-xs">
        <div>Project <span className="font-mono text-muted-foreground">{result.manifestPreview?.projectName ?? String((manifest?.project as Record<string, unknown> | undefined)?.name ?? '—')}</span></div>
        <div>Version <span className="font-mono text-muted-foreground">{result.manifestPreview?.projectVersion ?? String((manifest?.project as Record<string, unknown> | undefined)?.version ?? '—')}</span></div>
        <div>Entries <span className="font-mono text-muted-foreground">{entryCount}</span></div>
        <div>Checksums <span className="font-mono text-muted-foreground">{result.checksums ? Object.keys(result.checksums).length : 0}</span></div>
        <div>Shader variants <span className="font-mono text-muted-foreground">{result.manifestPreview?.shaderVariants.join(', ') || 'none'}</span></div>
        <div>Bytes <span className="font-mono text-muted-foreground">{result.byteCount ?? '—'}</span></div>
      </div>
    </section>
  );
}

function Diagnostics({ result }: { result: PackageExportWorkflowResult }) {
  if (result.diagnostics.length === 0 && result.validationDiagnostics.length === 0 && result.shaderDiagnostics.length === 0) {
    return <p className="text-xs text-muted-foreground">No export diagnostics.</p>;
  }
  const diagnostics = [
    ...result.validationDiagnostics.map((diagnostic) => ({ ...diagnostic, category: diagnostic.category ?? 'validation' })),
    ...result.diagnostics,
    ...result.shaderDiagnostics.map((diagnostic) => ({ severity: diagnostic.severity, category: 'shader', path: diagnostic.path ?? diagnostic.outputPath ?? diagnostic.sourcePath ?? '/', message: diagnostic.message })),
  ];
  return (
    <section className="space-y-2">
      <div className="font-medium">Diagnostics</div>
      {diagnostics.map((diagnostic, index) => (
        <div key={`${diagnostic.category}-${diagnostic.path}-${diagnostic.message}-${index}`} className="rounded border p-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={diagnosticBadge(diagnostic.severity)}>{diagnostic.severity}</Badge>
            <Badge variant="outline">{diagnostic.category ?? 'export'}</Badge>
            <span className="font-mono text-muted-foreground">{diagnostic.path || '/'}</span>
          </div>
          <div className="mt-1">{diagnostic.message}</div>
        </div>
      ))}
    </section>
  );
}

function PackageEntries({ result }: { result: PackageExportWorkflowResult }) {
  const entries = manifestEntries(result);
  if (entries.length === 0) return <p className="text-xs text-muted-foreground">No package manifest entries yet.</p>;
  return (
    <section className="space-y-2">
      <div className="font-medium">Package entries</div>
      {entries.map((entry, index) => {
        const path = typeof entry.path === 'string' ? entry.path : `entry-${index}`;
        const size = typeof entry.size === 'number' ? entry.size : null;
        return (
          <div key={`${path}-${index}`} className="flex items-center gap-2 rounded border p-2 text-xs">
            <span className="font-mono">{path}</span>
            {size !== null ? <span className="ml-auto font-mono text-muted-foreground">{size} bytes</span> : null}
          </div>
        );
      })}
    </section>
  );
}

function FileEntries({ result }: { result: PackageExportWorkflowResult }) {
  if (result.fileEntries.length === 0) return <p className="text-xs text-muted-foreground">No explicit asset file entries.</p>;
  return (
    <section className="space-y-2">
      <div className="font-medium">Asset file entries</div>
      {result.fileEntries.map((entry) => (
        <div key={`${entry.assetId ?? entry.packagePath}-${entry.packagePath}`} className="rounded border p-2 text-xs">
          <div className="flex items-center gap-2">
            <Badge variant="outline">{entry.kind ?? 'asset'}</Badge>
            <span className="font-mono">{entry.packagePath}</span>
          </div>
          <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{entry.source}</div>
        </div>
      ))}
    </section>
  );
}

function ShaderOutputs({ result }: { result: PackageExportWorkflowResult }) {
  if (result.shaderOutputs.length === 0) return null;
  return (
    <section className="space-y-2">
      <div className="font-medium">Shader outputs</div>
      {result.shaderOutputs.map((output, index) => (
        <div key={`${output.shader}-${output.stage}-${output.variant}-${index}`} className="rounded border p-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={output.cacheHit ? 'outline' : 'secondary'}>{output.cacheHit ? 'cache hit' : 'compiled'}</Badge>
            <span className="font-mono">{output.shader}</span>
            <span className="font-mono text-muted-foreground">{output.stage}</span>
            <span className="font-mono text-muted-foreground">{output.variant}</span>
          </div>
          <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{output.runtimePath}</div>
        </div>
      ))}
    </section>
  );
}

export function PackageExportPanel() {
  const [showRaw, setShowRaw] = useState(false);
  const storeResult = usePackageExportStore((state) => state.lastResult);
  const running = usePackageExportStore((state) => state.running);
  const stage = usePackageExportStore((state) => state.stage);
  const workspaceResult = useWorkspaceStore((state) => state.lastExportResult);
  const setLastExportResult = useWorkspaceStore((state) => state.setLastExportResult);
  const setStatusMessage = useWorkspaceStore((state) => state.setStatusMessage);
  const addTimelineEntry = useWorkspaceStore((state) => state.addTimelineEntry);
  const result = storeResult ?? normalizeResult(workspaceResult);

  if (!result) {
    return <p className="p-3 text-xs text-muted-foreground">No package export result yet.</p>;
  }

  async function previewPackage() {
    if (!result?.outputPath) return;
    const response = await window.noveltea.previewExportedPackage(result.outputPath);
    const next = {
      ...result,
      diagnostics: [...result.diagnostics, ...(response.diagnostics ?? [])],
      stage: 'failed' as const,
      success: false,
    };
    setLastExportResult(next);
    usePackageExportStore.getState().finish(next);
    setStatusMessage(response.error ?? 'Package preview failed');
    addTimelineEntry({ source: 'export', message: response.error ?? 'Package preview failed', detail: response });
  }

  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={result.success ? 'default' : result.ok ? 'secondary' : 'destructive'}>
          {running ? stage : result.success ? 'exported' : 'failed'}
        </Badge>
        <span className="font-medium">{result.profile?.label ?? 'Package Export'}</span>
        {result.outputPath ? <span className="truncate font-mono text-muted-foreground">{result.outputPath}</span> : null}
        <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={() => setShowRaw(!showRaw)}>{showRaw ? 'Hide Raw' : 'Show Raw'}</Button>
        {result.outputPath ? <Button size="sm" variant="outline" className="h-7" onClick={() => window.noveltea.showItemInFolder(result.outputPath!)}>Reveal</Button> : null}
        {result.outputPath && result.success ? <Button size="sm" className="h-7" onClick={previewPackage}>Preview Package</Button> : null}
      </div>
      <ManifestSummary result={result} />
      <Diagnostics result={result} />
      <PackageEntries result={result} />
      <FileEntries result={result} />
      <ShaderOutputs result={result} />
      {showRaw ? (
        <pre className="overflow-auto rounded border p-3 font-mono text-[11px] leading-relaxed">
          {JSON.stringify(result, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
