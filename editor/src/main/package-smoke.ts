import {
  app,
  BrowserWindow,
  net,
  protocol,
  type BrowserWindow as BrowserWindowType,
} from 'electron';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import sharp from 'sharp';
import type { CreateRaw } from 'sharp';
import { assetDataFromImportMetadata } from '../shared/project-schema/authoring-assets';
import { isAuthoringProject } from '../shared/project-schema/authoring-project';
import { NOVELTEA_VERSION } from '../shared/product-version';
import type { EnginePreviewServer } from './engine-preview-server';
import { openProject } from './services/editor-tool-service';
import { createProject, saveProjectContent } from './services/project-file-service';
import { importUntrackedProjectAssets } from './services/project-asset-audit-service';

export const PACKAGE_SMOKE_FLAG = '--noveltea-package-smoke';
export const PACKAGE_SMOKE_PREFIX = 'NOVELTEA_PACKAGE_SMOKE_RESULT=';
export const THUMBNAIL_PROTOCOL_CHARACTERIZATION_SCHEME = 'noveltea-thumbnail-characterization';

interface PackageSmokeResult {
  success: boolean;
  checks: Record<string, boolean>;
  error?: string;
}

async function characterizeNovelTeaCli(cliPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cliPath, ['--json', '--version'], {
      cwd: process.resourcesPath,
      env: { HOME: process.resourcesPath, LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', () => resolve(false));
    child.once('close', (code) => {
      try {
        const payload = JSON.parse(stdout) as Record<string, unknown>;
        resolve(
          code === 0 &&
            stderr === '' &&
            payload.success === true &&
            payload.exitCode === 0 &&
            payload.version === NOVELTEA_VERSION,
        );
      } catch {
        resolve(false);
      }
    });
  });
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

async function characterizeProductionThumbnailProtocol(
  window: BrowserWindowType,
): Promise<boolean> {
  const fixtureRoot = await fs.promises.mkdtemp(
    path.join(app.getPath('temp'), 'noveltea-thumbnail-package-smoke-'),
  );
  try {
    const projectRoot = path.join(fixtureRoot, 'project');
    const created = await createProject({
      projectName: 'Package Smoke Thumbnail',
      projectDirectory: projectRoot,
    });
    if (!created.success || !created.projectFilePath) return false;
    const projectFilePath = created.projectFilePath;
    const sourceDirectory = path.join(projectRoot, 'assets', 'images');
    const sourcePath = path.join(sourceDirectory, 'source.png');
    await fs.promises.mkdir(sourceDirectory, { recursive: true });
    const sourceBytes = await sharp({
      create: {
        width: 3,
        height: 2,
        channels: 4,
        background: { r: 80, g: 120, b: 160, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();
    await fs.promises.writeFile(sourcePath, sourceBytes);
    const imported = await importUntrackedProjectAssets(projectFilePath, [
      'assets/images/source.png',
    ]);
    const opened = await openProject(projectRoot);
    if (
      !imported.success ||
      !imported.assets?.[0] ||
      !opened.success ||
      !opened.workspaceRevision ||
      !opened.editorState ||
      !isAuthoringProject(opened.contentProject)
    )
      return false;
    const assetId = 'package-smoke-image';
    opened.contentProject.assets[assetId] = {
      id: assetId,
      label: 'Package Smoke Image',
      data: assetDataFromImportMetadata(imported.assets[0]),
    };
    const saved = await saveProjectContent(
      projectRoot,
      opened.workspaceRevision,
      opened.contentProject,
      opened.editorState,
      opened.scriptSourcePaths ?? {},
    );
    if (!saved.success) return false;
    const openedLiteral = JSON.stringify(projectRoot);
    const source = {
      projectRelativePath: 'assets/images/source.png',
      contentHash: `sha256:${crypto.createHash('sha256').update(sourceBytes).digest('hex')}`,
      width: 3,
      height: 2,
      orientation: 1,
    };
    const sourceLiteral = JSON.stringify(source);
    const assetIdLiteral = JSON.stringify(assetId);
    const proof = (await window.webContents.executeJavaScript(
      `(async () => {
        const opened = await window.noveltea.openProject(${openedLiteral});
        if (!opened.success || !opened.projectSessionId) return { first: { ok: false }, second: null, loaded: false, width: 0, height: 0 };
        const request = {
          source: {
            projectSessionId: opened.projectSessionId,
            assetId: ${assetIdLiteral},
            ...${sourceLiteral},
          },
          variant: { kind: 'profile', profile: 'list' },
        };
        const first = await window.noveltea.requestImageThumbnail(request);
        if (!first.ok) return { first, second: null, loaded: false, width: 0, height: 0 };
        const image = await new Promise((resolve) => {
          const element = new Image();
          element.onload = () => resolve({ loaded: true, width: element.naturalWidth, height: element.naturalHeight });
          element.onerror = () => resolve({ loaded: false, width: 0, height: 0 });
          element.src = first.url;
        });
        const second = await window.noveltea.requestImageThumbnail(request);
        return { first, second, ...image };
      })()`,
      true,
    )) as {
      first: {
        ok: boolean;
        url?: string;
        cacheKey?: string;
        cacheStatus?: string;
      };
      second: {
        ok: boolean;
        url?: string;
        cacheKey?: string;
        cacheStatus?: string;
      } | null;
      loaded: boolean;
      width: number;
      height: number;
    };
    if (
      !proof.first.ok ||
      !proof.second?.ok ||
      !proof.first.url?.startsWith('noveltea-thumbnail://cache/image-v2/') ||
      proof.first.cacheStatus !== 'generated' ||
      proof.second.cacheStatus !== 'hit' ||
      proof.first.cacheKey !== proof.second.cacheKey ||
      proof.first.url !== proof.second.url ||
      !proof.loaded ||
      proof.width !== 3 ||
      proof.height !== 2
    ) {
      return false;
    }
    const response = await net.fetch(proof.first.url);
    return (
      response.ok &&
      response.headers.get('content-type') === 'image/webp' &&
      response.headers.get('cache-control') === 'public, max-age=31536000, immutable' &&
      response.headers.get('cross-origin-resource-policy') === 'cross-origin' &&
      response.headers.get('access-control-allow-origin') === '*' &&
      response.headers.get('x-content-type-options') === 'nosniff' &&
      (await response.arrayBuffer()).byteLength > 0
    );
  } finally {
    await fs.promises.rm(fixtureRoot, { recursive: true, force: true });
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
    await sharp(bmp).metadata();
    results.bmpUnsupported = false;
  } catch {
    results.bmpUnsupported = true;
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
    const boundaryFailure = (await window.webContents.executeJavaScript(
      `window.noveltea.selectDirectory({ unexpected: true }).then(
        () => null,
        (error) => ({ name: error?.name, code: error?.code, message: error?.message })
      )`,
      true,
    )) as { name?: string; code?: string; message?: string } | null;
    checks.ipcInvalidRequest = boundaryFailure?.message === 'invalid-request';
    if (!checks.ipcInvalidRequest) {
      throw new Error(
        `Unexpected renderer-visible IPC boundary failure: ${JSON.stringify(boundaryFailure)}`,
      );
    }

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

    const cliName = process.platform === 'win32' ? 'noveltea.exe' : 'noveltea';
    const cliPath = path.join(process.resourcesPath, 'bin', cliName);
    const cliInfo = await fs.promises.stat(cliPath);
    checks.novelteaCli =
      cliInfo.isFile() &&
      (process.platform === 'win32' || (cliInfo.mode & 0o111) !== 0) &&
      (await characterizeNovelTeaCli(cliPath));

    const sharpFormats = await characterizeSharpFormats();
    checks.sharp = Object.values(sharpFormats).every(Boolean);
    for (const [name, passed] of Object.entries(sharpFormats)) {
      checks[`sharp.${name}`] = passed;
    }
    checks.thumbnailProtocolDevelopmentOrigin =
      await characterizeThumbnailProtocolFromDevelopmentOrigin();
    checks.thumbnailProductionProtocol = await characterizeProductionThumbnailProtocol(window);

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
