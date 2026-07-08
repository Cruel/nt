import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { EnginePreviewSession } from '../shared/preview-protocol';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.rcss': 'text/css; charset=utf-8',
  '.lua': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export class PreviewBuildMissingError extends Error {
  constructor(readonly previewRoot: string) {
    super(`Engine preview build not found at ${previewRoot}. Run pnpm engine:preview:build from editor/.`);
  }
}

export class EnginePreviewServer {
  private server: Server | null = null;
  private session: EnginePreviewSession | null = null;
  private previewRoot: string | null = null;
  private editorAssetsRoot: string | null = null;
  private projectRoot: string | null = null;

  setProjectFilePath(projectFilePath: string | null | undefined): void {
    this.projectRoot = projectFilePath ? path.dirname(path.resolve(projectFilePath)) : null;
  }

  async getSession(): Promise<EnginePreviewSession> {
    if (this.session) return this.session;
    return this.start();
  }

  async reload(): Promise<EnginePreviewSession> {
    await this.stop();
    return this.start();
  }

  async start(): Promise<EnginePreviewSession> {
    if (this.session) return this.session;

    this.previewRoot = resolvePreviewRoot();
    this.editorAssetsRoot = resolveEditorAssetsRoot();
    const index = path.join(this.previewRoot, 'index.html');
    if (!existsSync(index)) {
      throw new PreviewBuildMissingError(this.previewRoot);
    }

    this.server = createServer((request, response) => {
      if (!request.url || !this.previewRoot) {
        response.writeHead(404).end('Not found');
        return;
      }

      let pathname = '/';
      try {
        pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      } catch {
        response.writeHead(400).end('Bad request');
        return;
      }

      const assetPrefix = '/editor-assets/';
      if (pathname.startsWith(assetPrefix)) {
        if (!this.editorAssetsRoot) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Editor assets not found');
          return;
        }
        serveFileFromRoot(this.editorAssetsRoot, pathname.slice(assetPrefix.length), response);
        return;
      }

      const projectAssetPrefix = '/project-assets/';
      if (pathname.startsWith(projectAssetPrefix)) {
        if (!this.projectRoot) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Project asset root not set');
          return;
        }
        serveFileFromRoot(this.projectRoot, pathname.slice(projectAssetPrefix.length), response);
        return;
      }

      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      serveFileFromRoot(this.previewRoot, relative, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(0, '127.0.0.1', () => resolve());
    });

    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Engine preview server did not expose a TCP port.');
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const sessionToken = randomBytes(24).toString('base64url');
    this.session = {
      origin,
      sessionToken,
      url: `${origin}/?sessionToken=${encodeURIComponent(sessionToken)}`,
    };
    return this.session;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.session = null;
    this.editorAssetsRoot = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function serveFileFromRoot(root: string, relativePath: string, response: ServerResponse) {
  const filePath = path.resolve(root, relativePath);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (filePath !== root && !filePath.startsWith(rootWithSep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(filePath).pipe(response);
}

function resolvePreviewRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'engine-preview');
  }

  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, '..', 'build', 'web-release', 'apps', 'sandbox'),
    path.resolve(cwd, 'build', 'web-release', 'apps', 'sandbox'),
    path.resolve(app.getAppPath(), '..', 'build', 'web-release', 'apps', 'sandbox'),
    path.resolve(cwd, '..', 'build', 'web-debug', 'apps', 'sandbox'),
    path.resolve(cwd, 'build', 'web-debug', 'apps', 'sandbox'),
    path.resolve(app.getAppPath(), '..', 'build', 'web-debug', 'apps', 'sandbox'),
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, 'index.html'))) ?? candidates[0]!;
}

function resolveEditorAssetsRoot(): string | null {
  if (app.isPackaged) {
    const packagedRoot = path.join(process.resourcesPath, 'editor-assets');
    return existsSync(packagedRoot) && statSync(packagedRoot).isDirectory() ? packagedRoot : null;
  }

  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, 'assets'),
    path.resolve(cwd, 'editor', 'assets'),
    path.resolve(app.getAppPath(), 'assets'),
    path.resolve(app.getAppPath(), 'editor', 'assets'),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isDirectory()) ?? null;
}
