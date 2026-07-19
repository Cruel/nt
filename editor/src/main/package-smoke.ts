import { app, net, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { EnginePreviewServer } from './engine-preview-server';

export const PACKAGE_SMOKE_FLAG = '--noveltea-package-smoke';
export const PACKAGE_SMOKE_PREFIX = 'NOVELTEA_PACKAGE_SMOKE_RESULT=';

interface PackageSmokeResult {
  success: boolean;
  checks: Record<string, boolean>;
  error?: string;
}

async function waitForRenderer(window: BrowserWindow): Promise<void> {
  if (!window.webContents.isLoadingMainFrame()) return;
  await new Promise<void>((resolve, reject) => {
    window.webContents.once('did-finish-load', () => resolve());
    window.webContents.once('did-fail-load', (_event, code, description) => {
      reject(new Error(`Renderer load failed (${code}): ${description}`));
    });
  });
}

export async function runPackageSmoke(
  window: BrowserWindow,
  enginePreviewServer: EnginePreviewServer,
): Promise<PackageSmokeResult> {
  const checks: Record<string, boolean> = {};
  try {
    await waitForRenderer(window);

    const renderer = (await window.webContents.executeJavaScript(
      `({
      title: document.title,
      hasRoot: document.getElementById('root') !== null,
      hasPreloadApi: typeof window.noveltea?.getAppInfo === 'function',
      url: location.href
    })`,
      true,
    )) as { title: string; hasRoot: boolean; hasPreloadApi: boolean; url: string };
    checks.mainProcess = true;
    checks.applicationName = app.getName() === 'NovelTea Editor';
    checks.userDataNamespace = path.basename(app.getPath('userData')) === 'noveltea-editor';
    checks.renderer = renderer.hasRoot && renderer.title.length > 0;
    checks.preload = renderer.hasPreloadApi;
    checks.packagedProtocol = renderer.url.startsWith('noveltea-editor://');

    const packagedDocument = await net.fetch('noveltea-editor://app/index.html');
    checks.packagedProtocolHeaders =
      packagedDocument.ok &&
      packagedDocument.headers.get('cross-origin-opener-policy') === 'same-origin' &&
      packagedDocument.headers.get('cross-origin-embedder-policy') === 'require-corp' &&
      packagedDocument.headers.get('cache-control') === 'no-store';
    const traversalAttempt = await net.fetch(
      'noveltea-editor://app/%2e%2e%2f%2e%2e%2fpackage.json',
    );
    checks.packagedProtocolTraversal = traversalAttempt.status === 403;

    const preview = await enginePreviewServer.getSession();
    const previewResponse = await fetch(`${preview.origin}/index.html`);
    checks.enginePreview = previewResponse.ok && (await previewResponse.text()).length > 0;
    checks.enginePreviewHeaders =
      previewResponse.headers.get('cross-origin-opener-policy') === 'same-origin' &&
      previewResponse.headers.get('cross-origin-embedder-policy') === 'require-corp' &&
      previewResponse.headers.get('cross-origin-resource-policy') === 'cross-origin';

    const assetResponse = await fetch(
      `${preview.origin}/editor-assets/internal-preview/layout-fragment-host.rml`,
    );
    checks.editorAssets =
      assetResponse.ok && (await assetResponse.text()).includes('nt-layout-preview-root');

    const editorToolName =
      process.platform === 'win32' ? 'noveltea-editor-tool.exe' : 'noveltea-editor-tool';
    const editorToolPath = path.join(process.resourcesPath, 'bin', editorToolName);
    const editorToolInfo = await fs.promises.stat(editorToolPath);
    checks.nativeEditorTool =
      editorToolInfo.isFile() &&
      (process.platform === 'win32' || (editorToolInfo.mode & 0o111) !== 0);

    const image = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 12, g: 34, b: 56, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const metadata = await sharp(image).metadata();
    checks.sharp = metadata.format === 'png' && metadata.width === 2 && metadata.height === 2;

    const success = Object.values(checks).every(Boolean);
    return {
      success,
      checks,
      ...(!success ? { error: 'One or more package smoke checks failed.' } : {}),
    };
  } catch (error) {
    return {
      success: false,
      checks,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
