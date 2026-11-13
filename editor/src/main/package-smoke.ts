import {
  app,
  BrowserWindow,
  net,
  protocol,
  type BrowserWindow as BrowserWindowType,
} from 'electron';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import sharp from 'sharp';
import type { CreateRaw } from 'sharp';
import { parse as parseYaml } from 'yaml';
import { NOVELTEA_VERSION } from '../shared/product-version';
import type { EnginePreviewServer } from './engine-preview-server';
import { checkMediaTools, prepareMedia } from './services/native-runtime-tool-service';
import { createNativeEditorProject } from './services/native-editor-project-create';
import { resolveNovelTeaCliPath } from '../shared/noveltea-cli-subprocess';
import { characterizePackagedNodePty } from './services/terminal-package-smoke';

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
      env:
        process.platform === 'win32'
          ? {
              PATH: process.env.SystemRoot ? `${process.env.SystemRoot}\\System32` : '',
              SystemRoot: process.env.SystemRoot ?? '',
              USERPROFILE: process.resourcesPath,
            }
          : { HOME: process.resourcesPath, LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' },
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
    // WebAssembly sharp can return SharedArrayBuffer-backed buffers. Fetch
    // Response bodies must own ordinary, non-shared Uint8Array storage.
    return new Response(new Uint8Array(image), {
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
    const created = await createNativeEditorProject({
      projectName: 'Package Smoke Thumbnail',
      projectDirectory: projectRoot,
    });
    if (!created.success || !created.projectFilePath) {
      console.error('[package-smoke:thumbnail] Native Project creation rejected:', created);
      return false;
    }
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
    const { stdout } = await promisify(execFile)(
      resolveNovelTeaCliPath(),
      ['--no-daemon', '--json', '--project', projectRoot, 'asset', 'import', sourcePath],
      { cwd: process.resourcesPath, encoding: 'utf8', windowsHide: true },
    );
    const imported = JSON.parse(stdout) as {
      success?: boolean;
      assets?: Array<{ assetId?: string; projectRelativePath?: string }>;
    };
    const asset = imported.assets?.[0];
    if (
      imported.success !== true ||
      !asset?.assetId ||
      asset.projectRelativePath !== 'assets/images/source.png'
    ) {
      console.error('[package-smoke:thumbnail] Native Asset import rejected:', imported);
      return false;
    }
    const assetId = asset.assetId;
    // Opening the renderer Project creates a resident native authoring worker
    // that holds the clean-cache writer lock on Windows. Close its authority
    // before deleting this temporary Project, even on a failed smoke proof.
    try {
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
        const original = await window.noveltea.resolveProjectOriginalAssetUrl(opened.projectSessionId, ${assetIdLiteral});
        if (!original.ok) return { first: { ok: false }, second: null, original, originalLoaded: false, loaded: false, width: 0, height: 0 };
        const originalImage = await new Promise((resolve) => {
          const element = new Image();
          element.onload = () => resolve({ loaded: true, width: element.naturalWidth, height: element.naturalHeight });
          element.onerror = () => resolve({ loaded: false, width: 0, height: 0 });
          element.src = original.url;
        });
        const first = await window.noveltea.requestImageThumbnail(request);
        if (!first.ok) return { first, second: null, original, originalLoaded: originalImage.loaded, loaded: false, width: 0, height: 0 };
        const image = await new Promise((resolve) => {
          const element = new Image();
          element.onload = () => resolve({ loaded: true, width: element.naturalWidth, height: element.naturalHeight });
          element.onerror = () => resolve({ loaded: false, width: 0, height: 0 });
          element.src = first.url;
        });
        const second = await window.noveltea.requestImageThumbnail(request);
        return { first, second, original, originalLoaded: originalImage.loaded, originalWidth: originalImage.width, originalHeight: originalImage.height, ...image };
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
        original?: { ok: boolean; url?: string };
        originalLoaded?: boolean;
        originalWidth?: number;
        originalHeight?: number;
        loaded: boolean;
        width: number;
        height: number;
      };
      if (
        !proof.first.ok ||
        !proof.second?.ok ||
        !proof.first.url?.startsWith('noveltea-thumbnail://cache/image/') ||
        proof.first.cacheStatus !== 'generated' ||
        proof.second.cacheStatus !== 'hit' ||
        proof.first.cacheKey !== proof.second.cacheKey ||
        proof.first.url !== proof.second.url ||
        !proof.original?.ok ||
        !proof.original.url?.startsWith('noveltea-asset://source/') ||
        !proof.originalLoaded ||
        proof.originalWidth !== 3 ||
        proof.originalHeight !== 2 ||
        !proof.loaded ||
        proof.width !== 3 ||
        proof.height !== 2
      ) {
        console.error('[package-smoke:thumbnail] Renderer/IPC protocol readback failed:', proof);
        return false;
      }
      const response = await net.fetch(proof.first.url);
      const originalResponse = await net.fetch(proof.original!.url!);
      const valid =
        response.ok &&
        response.headers.get('content-type') === 'image/webp' &&
        response.headers.get('cache-control') === 'public, max-age=31536000, immutable' &&
        originalResponse.ok &&
        originalResponse.headers.get('content-type') === 'image/png' &&
        originalResponse.headers.get('content-length') === String(sourceBytes.byteLength) &&
        originalResponse.headers.get('cache-control') === 'no-store' &&
        originalResponse.headers.get('x-content-type-options') === 'nosniff' &&
        (await originalResponse.arrayBuffer()).byteLength === sourceBytes.byteLength &&
        response.headers.get('cross-origin-resource-policy') === 'cross-origin' &&
        response.headers.get('access-control-allow-origin') === '*' &&
        response.headers.get('x-content-type-options') === 'nosniff' &&
        (await response.arrayBuffer()).byteLength > 0;
      if (!valid)
        console.error('[package-smoke:thumbnail] Production protocol response validation failed.');
      return valid;
    } finally {
      await window.webContents.executeJavaScript('window.noveltea.closeActiveProject()', true);
    }
  } finally {
    // Native worker termination is asynchronous after the close IPC
    // acknowledgment. Wait for Windows to release its OS file lock rather
    // than treating a healthy clean-cache writer as a corrupted package.
    await fs.promises.rm(fixtureRoot, {
      recursive: true,
      force: true,
      maxRetries: process.platform === 'win32' ? 20 : 0,
      retryDelay: 150,
    });
  }
}

// Exercise the installed CLI and the actual packaged renderer -> guarded IPC
// -> native Project admission handoff. Unit tests cannot prove that a failed
// candidate leaves an incumbent session usable in the shipped Electron host.
async function characterizePackagedCandidateRepair(
  window: BrowserWindowType,
  cliPath: string,
): Promise<boolean> {
  const root = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'noveltea-repair-smoke-'));
  try {
    const roots = [path.join(root, 'incumbent'), path.join(root, 'candidate')];
    for (const projectRoot of roots) {
      const created = await createNativeEditorProject({
        projectName: 'Repair Smoke',
        projectDirectory: projectRoot,
      });
      if (!created.success || !created.projectFilePath) return false;
      await promisify(execFile)(
        cliPath,
        ['--no-daemon', '--project', projectRoot, 'entity', 'create', 'rooms', 'start'],
        { windowsHide: true },
      );
      await fs.promises.appendFile(
        created.projectFilePath,
        '\nentrypoint:\n  kind: room\n  id: start\n',
      );
    }
    const manifest = path.join(roots[1]!, 'project.yaml');
    const original = await fs.promises.readFile(manifest, 'utf8');
    const room = path.join(roots[1]!, 'records', 'rooms', 'start.yaml');
    const originalRoom = await fs.promises.readFile(room);
    const damaged = `${original}invalid: [\n`;
    await fs.promises.writeFile(manifest, damaged);

    const proof = (await window.webContents.executeJavaScript(
      `(async () => {
        const first = await window.noveltea.openProject(${JSON.stringify(roots[0])});
        if (!first.success || !first.projectSessionId) return { first: false };
        const failed = await window.noveltea.openProject(${JSON.stringify(roots[1])});
        if (failed.success || !failed.repairCandidateId) return { first: true, failed: false };
        const id = failed.repairCandidateId;
        const source = await window.noveltea.readRepairCandidate(id);
        const notReady = await window.noveltea.observeRepairCandidate(id);
        const unchanged = await window.noveltea.nativeProjectValidate(first.projectSessionId, first.nativeWorkingRevision, false);
        const saved = await window.noveltea.saveRepairCandidate(id, source.revision, ${JSON.stringify(original)});
        const ready = await window.noveltea.observeRepairCandidate(id);
        const activeUntilExplicitOpen = await window.noveltea.nativeProjectValidate(first.projectSessionId, first.nativeWorkingRevision, false);
        const opened = ready?.ready && ready.revision
          ? await window.noveltea.openProject({ repairCandidateId: id, readyRevision: ready.revision })
          : null;
        return {
          first: true,
          failed: true,
          originalSource: source.text === ${JSON.stringify(damaged)},
          notReady: notReady?.ready === false,
          incumbentUsable: !!unchanged && !!activeUntilExplicitOpen,
          saved: saved.text === ${JSON.stringify(original)},
          ready: ready?.ready === true,
          explicitlyOpened: opened?.success === true && opened.projectSessionId !== first.projectSessionId,
        };
      })()`,
      true,
    )) as Record<string, boolean>;
    if (Object.values(proof).some((passed) => !passed))
      console.error('[package-smoke:repair] Renderer candidate handoff failed:', proof);
    return (
      Object.values(proof).every(Boolean) &&
      (await fs.promises.readFile(manifest, 'utf8')) === original &&
      (await fs.promises.readFile(room)).equals(originalRoom)
    );
  } catch (error) {
    console.error('[package-smoke:repair] Candidate repair handoff failed:', error);
    return false;
  } finally {
    await window.webContents
      .executeJavaScript('window.noveltea.closeActiveProject()', true)
      .catch(() => undefined);
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

// The same production IPC host must recover an overlap first discovered after
// Close, reject ordinary Save, and apply Use Disk to only the conflicting path.
async function characterizePackagedOfflineRecovery(
  window: BrowserWindowType,
  cliPath: string,
): Promise<boolean> {
  const parent = await fs.promises.mkdtemp(
    path.join(app.getPath('temp'), 'noveltea-offline-smoke-'),
  );
  const root = path.join(parent, 'project');
  try {
    const created = await createNativeEditorProject({
      projectName: 'Offline Recovery Smoke',
      projectDirectory: root,
    });
    if (!created.success || !created.projectFilePath) {
      console.error('[package-smoke:offline-recovery] Create failed:', created);
      return false;
    }
    await promisify(execFile)(
      cliPath,
      ['--no-daemon', '--project', root, 'entity', 'create', 'rooms', 'start'],
      { windowsHide: true },
    );
    await fs.promises.appendFile(
      created.projectFilePath,
      '\nentrypoint:\n  kind: room\n  id: start\n',
    );
    const room = path.join(root, 'records', 'rooms', 'start.yaml');
    const original = await fs.promises.readFile(room, 'utf8');
    if (!original.includes('label: Room start')) {
      console.error('[package-smoke:offline-recovery] CLI Room label unexpected.');
      return false;
    }
    const staged = (await window.webContents.executeJavaScript(
      `(async () => {
        const opened = await window.noveltea.openProject(${JSON.stringify(root)});
        if (!opened.success) return { opened: false, error: opened.error };
        const patch = await window.noveltea.nativeProjectPatch(opened.projectSessionId, opened.nativeWorkingRevision, [
          { op: 'replace', path: '/rooms/start/label', value: 'My offline label' },
          { op: 'replace', path: '/rooms/start/data/displayName', value: 'Unrelated local display' },
        ]);
        await window.noveltea.closeActiveProject();
        return { opened: true, patched: patch.accepted === true, error: patch.error };
      })()`,
      true,
    )) as { opened: boolean; patched?: boolean; error?: string };
    const diskUnmodified = (await fs.promises.readFile(room, 'utf8')) === original;
    if (!staged.opened || !staged.patched || !diskUnmodified) {
      console.error('[package-smoke:offline-recovery] Dirty stage failed:', staged, {
        diskUnmodified,
      });
      return false;
    }
    await fs.promises.writeFile(
      room,
      original.replace('label: Room start', 'label: Disk offline label'),
    );
    const proof = (await window.webContents.executeJavaScript(
      `(async () => {
        const reopened = await window.noveltea.openProject(${JSON.stringify(root)});
        if (!reopened.success) return { reopened: false };
        const conflict = reopened.nativeRecoveredConflicts?.['rooms/start'];
        const ordinary = await window.noveltea.nativeProjectSaveUnit(
          reopened.projectSessionId, reopened.nativeWorkingRevision, 'record:rooms:start', {}
        );
        const adopted = await window.noveltea.nativeProjectUseDiskUnit(
          reopened.projectSessionId, reopened.nativeWorkingRevision, 'record:rooms:start'
        );
        const saved = adopted.accepted
          ? await window.noveltea.nativeProjectSaveUnit(
              reopened.projectSessionId, adopted.snapshot.workingRevision, 'record:rooms:start', {}
            )
          : null;
        return {
          reopened: true,
          reportedConflict: conflict?.paths?.includes('/label') === true,
          ordinarySaveRefused: ordinary.accepted === false,
          useDiskAccepted: adopted.accepted === true,
          independentSaved: saved?.accepted === true,
        };
      })()`,
      true,
    )) as Record<string, boolean>;
    if (Object.values(proof).some((passed) => !passed))
      console.error('[package-smoke:offline-recovery] Native IPC reconciliation failed:', proof);
    const finalRoom = await fs.promises.readFile(room, 'utf8');
    const persisted = parseYaml(finalRoom) as {
      label?: unknown;
      data?: { displayName?: unknown };
    };
    const diskLabelPreserved = persisted.label === 'Disk offline label';
    const otherFieldSaved = persisted.data?.displayName === 'Unrelated local display';
    if (!diskLabelPreserved || !otherFieldSaved)
      console.error('[package-smoke:offline-recovery] Native YAML readback failed:', {
        diskLabelPreserved,
        otherFieldSaved,
        finalRoom,
      });
    return Object.values(proof).every(Boolean) && diskLabelPreserved && otherFieldSaved;
  } catch (error) {
    console.error('[package-smoke:offline-recovery] Failed:', error);
    return false;
  } finally {
    await window.webContents
      .executeJavaScript('window.noveltea.closeActiveProject()', true)
      .catch(() => undefined);
    await fs.promises.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
  const stage = (name: string) => {
    // A native crash bypasses this function's catch block and result marker.
    // Preserve the last reached operation in hosted Release logs.
    if (process.env.CI) console.error(`[package-smoke:stage] ${name}`);
  };
  try {
    stage('renderer');
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
    stage('ipc-boundary');
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

    stage('packaged-protocol');
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

    stage('engine-preview');
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

    stage('native-cli');
    const cliName = process.platform === 'win32' ? 'noveltea.exe' : 'noveltea';
    const cliPath = path.join(process.resourcesPath, 'bin', cliName);
    const cliInfo = await fs.promises.stat(cliPath);
    checks.novelteaCli =
      cliInfo.isFile() &&
      (process.platform === 'win32' || (cliInfo.mode & 0o111) !== 0) &&
      (await characterizeNovelTeaCli(cliPath));

    stage('sharp-formats');
    const sharpFormats = await characterizeSharpFormats();
    checks.sharp = Object.values(sharpFormats).every(Boolean);

    stage('private-media-tools');
    const mediaRoot = await fs.promises.mkdtemp(
      path.join(app.getPath('temp'), 'noveltea media smoke '),
    );
    try {
      const identity = checkMediaTools();
      const source = path.join(mediaRoot, 'source.rgb');
      const prepared = path.join(mediaRoot, 'prepared.webm');
      const decoded = path.join(mediaRoot, 'decoded.rgb');
      const pixels = Buffer.alloc(12);
      await fs.promises.writeFile(source, pixels);
      prepareMedia([
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-s',
        '2x2',
        '-r',
        '1',
        '-i',
        source,
        '-frames:v',
        '1',
        '-c:v',
        'libvpx-vp9',
        '-lossless',
        '1',
        prepared,
      ]);
      prepareMedia([
        '-i',
        prepared,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        decoded,
      ]);
      checks.privateMediaTools =
        identity.bundled && (await fs.promises.readFile(decoded)).equals(pixels);
    } finally {
      await fs.promises.rm(mediaRoot, { recursive: true, force: true });
    }
    for (const [name, passed] of Object.entries(sharpFormats)) {
      checks[`sharp.${name}`] = passed;
    }
    stage('node-pty');
    const ptyChecks = await characterizePackagedNodePty(process.resourcesPath);
    checks.nodePty = Object.values(ptyChecks).every(Boolean);
    for (const [name, passed] of Object.entries(ptyChecks)) {
      checks[`nodePty.${name}`] = passed;
    }
    stage('thumbnail-development-origin');
    checks.thumbnailProtocolDevelopmentOrigin =
      await characterizeThumbnailProtocolFromDevelopmentOrigin();
    stage('thumbnail-production-protocol');
    checks.thumbnailProductionProtocol = await characterizeProductionThumbnailProtocol(window);

    stage('candidate-repair');
    checks.candidateRepair = await characterizePackagedCandidateRepair(window, cliPath);
    stage('offline-recovery');
    checks.offlineRecovery = await characterizePackagedOfflineRecovery(window, cliPath);

    stage('complete');
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
