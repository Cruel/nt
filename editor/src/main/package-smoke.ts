import {
  app,
  BrowserWindow,
  net,
  protocol,
  type BrowserWindow as BrowserWindowType,
} from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import sharp from 'sharp';
import type { CreateRaw } from 'sharp';
import type { EnginePreviewServer } from './engine-preview-server';

export const PACKAGE_SMOKE_FLAG = '--noveltea-package-smoke';
export const PACKAGE_SMOKE_PREFIX = 'NOVELTEA_PACKAGE_SMOKE_RESULT=';
export const THUMBNAIL_PROTOCOL_CHARACTERIZATION_SCHEME = 'noveltea-thumbnail-characterization';

interface PackageSmokeResult {
  success: boolean;
  checks: Record<string, boolean>;
  error?: string;
}

async function waitForRenderer(window: BrowserWindowType): Promise<void> {
  if (!window.webContents.isLoadingMainFrame()) return;
  await new Promise<void>((resolve, reject) => {
    window.webContents.once('did-finish-load', () => resolve());
    window.webContents.once('did-fail-load', (_event, code, description) => {
      reject(new Error(`Renderer load failed (${code}): ${description}`));
    });
  });
}

async function characterizeThumbnailProtocolFromDevelopmentOrigin(): Promise<boolean> {
  const image = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 12, g: 34, b: 56, alpha: 0.5 },
    },
  })
    .webp({ lossless: true })
    .toBuffer();
  protocol.handle(THUMBNAIL_PROTOCOL_CHARACTERIZATION_SCHEME, (request) => {
    if (request.url !== `${THUMBNAIL_PROTOCOL_CHARACTERIZATION_SCHEME}://cache/proof.webp`) {
      return new Response('Not found', { status: 404 });
    }
    return new Response(image, {
      headers: {
        'Content-Type': 'image/webp',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><body>thumbnail protocol characterization</body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Development-origin server failed.');

  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await window.loadURL(`http://127.0.0.1:${address.port}/`);
    return (await window.webContents.executeJavaScript(
      `new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve(image.naturalWidth === 2 && image.naturalHeight === 2);
        image.onerror = () => resolve(false);
        image.src = '${THUMBNAIL_PROTOCOL_CHARACTERIZATION_SCHEME}://cache/proof.webp';
      })`,
      true,
    )) as boolean;
  } finally {
    window.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    protocol.unhandle(THUMBNAIL_PROTOCOL_CHARACTERIZATION_SCHEME);
  }
}

async function characterizeSharpFormats(): Promise<Record<string, boolean>> {
  const opaque = sharp({
    create: { width: 3, height: 2, channels: 3, background: { r: 20, g: 40, b: 60 } },
  });
  const transparent = sharp({
    create: {
      width: 3,
      height: 2,
      channels: 4,
      background: { r: 20, g: 40, b: 60, alpha: 0.5 },
    },
  });
  const animatedRaw = Buffer.from([
    255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255,
    0, 0, 255, 255, 0, 0, 255, 255,
  ]);
  const animatedInput = () =>
    sharp(animatedRaw, {
      raw: { width: 2, height: 4, channels: 4, pageHeight: 2 } as CreateRaw,
    });
  const apng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAACAAAAAgAAAAAAAAAAAAEACgAA6FTcAAAAABRJREFUeJxj/M/A8J+BgYGBiQEKAB8XAgJPlM6+AAAAGmZjVEwAAAABAAAAAgAAAAIAAAAAAAAAAAABAAoAAHMnNtQAAAAYZmRBVAAAAAJ4nGNkYPj/n4GBgYGJAQoAHRkCAunm7jEAAAAASUVORK5CYII=',
    'base64',
  );
  const buffers = {
    png: await transparent.clone().png().toBuffer(),
    jpeg: await opaque.clone().jpeg().toBuffer(),
    webp: await transparent.clone().webp({ lossless: true }).toBuffer(),
    svg: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><rect width="3" height="2" fill="#123456"/></svg>',
    ),
    gif: await animatedInput()
      .gif({ delay: [100, 100], loop: 0 })
      .toBuffer(),
    apng,
    animatedWebp: await animatedInput()
      .webp({ delay: [100, 100], loop: 0 })
      .toBuffer(),
  };
  const results: Record<string, boolean> = {};
  for (const [name, buffer] of Object.entries(buffers)) {
    const metadata = await sharp(buffer, { animated: true }).metadata();
    const firstFrame = await sharp(buffer, { page: 0, pages: 1 })
      .webp({ lossless: true })
      .toBuffer();
    const decoded = await sharp(firstFrame).metadata();
    results[name] = decoded.format === 'webp' && decoded.width === 3 ? true : decoded.width === 2;
    if (name === 'gif' || name === 'animatedWebp') {
      results[name] = results[name] && (metadata.pages ?? 1) > 1;
    }
  }
  const bmp = Buffer.from(
    'Qk1OAAAAAAAAADYAAAAoAAAAAwAAAAIAAAABABgAAAAAABgAAADEDgAAxA4AAAAAAAAAAAAAVjQSVjQSVjQSAAAAVjQSVjQSVjQSAAAA',
    'base64',
  );
  try {
    const metadata = await sharp(bmp).metadata();
    results.bmp =
      String(metadata.format) === 'bmp' && metadata.width === 3 && metadata.height === 2;
  } catch {
    results.bmp = false;
  }
  try {
    await sharp(Buffer.from('not an image')).metadata();
    results.corrupt = false;
  } catch {
    results.corrupt = true;
  }
  try {
    await sharp(path.join(process.resourcesPath, 'missing-thumbnail-input.png')).metadata();
    results.missing = false;
  } catch {
    results.missing = true;
  }
  return results;
}

export async function runPackageSmoke(
  window: BrowserWindowType,
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

    const sharpFormats = await characterizeSharpFormats();
    checks.sharp = Object.values(sharpFormats).every(Boolean);
    for (const [name, passed] of Object.entries(sharpFormats)) {
      checks[`sharp.${name}`] = passed;
    }
    checks.thumbnailProtocolDevelopmentOrigin =
      await characterizeThumbnailProtocolFromDevelopmentOrigin();

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
