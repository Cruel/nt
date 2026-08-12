import { execFile } from 'node:child_process';
import { lstat, statfs } from 'node:fs/promises';
import { promisify } from 'node:util';

export interface PlatformProcessRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  maxBuffer?: number;
}

export interface PlatformProcessResult {
  stdout: string;
  stderr: string;
}

export interface PlatformImageMetadata {
  width: number;
  height: number;
  hasAlpha: boolean;
  space?: string;
  alphaBounds?: { left: number; top: number; right: number; bottom: number };
}

export interface PlatformImageRequest {
  sourcePath: string;
  outputPath: string;
  size: number;
}

export interface PlatformHostService {
  runProcess(request: PlatformProcessRequest): Promise<PlatformProcessResult>;
  inspectImage?(sourcePath: string): Promise<PlatformImageMetadata>;
  resizeImageToPng?(request: PlatformImageRequest): Promise<void>;
  fileMode?(path: string): Promise<number>;
  availableDiskSpace?(path: string): Promise<number>;
}

const nodeExecFile = promisify(execFile);

const nodeHost: PlatformHostService = {
  async runProcess(request) {
    const result = await nodeExecFile(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      maxBuffer: request.maxBuffer,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  },
  async fileMode(filePath) {
    return (await lstat(filePath)).mode & 0o777;
  },
  async availableDiskSpace(filePath) {
    const disk = await statfs(filePath);
    return Number(disk.bavail) * Number(disk.bsize);
  },
};

let configuredHost: PlatformHostService = nodeHost;

export function configurePlatformHostService(host: PlatformHostService): void {
  configuredHost = host;
}

export function resetPlatformHostService(): void {
  configuredHost = nodeHost;
}

export function configurePlatformImageService(
  image: Required<Pick<PlatformHostService, 'inspectImage' | 'resizeImageToPng'>>,
): void {
  configuredHost = { ...configuredHost, ...image };
}

export function runPlatformProcess(
  command: string,
  args: string[],
  options: Omit<PlatformProcessRequest, 'command' | 'args'> = {},
): Promise<PlatformProcessResult> {
  return configuredHost.runProcess({ command, args, ...options });
}

export function inspectPlatformImage(sourcePath: string): Promise<PlatformImageMetadata> | null {
  return configuredHost.inspectImage?.(sourcePath) ?? null;
}

export function resizePlatformImageToPng(request: PlatformImageRequest): Promise<void> | null {
  return configuredHost.resizeImageToPng?.(request) ?? null;
}

export async function platformFileMode(filePath: string, fallback: number): Promise<number> {
  return configuredHost.fileMode ? configuredHost.fileMode(filePath) : fallback;
}

export async function platformAvailableDiskSpace(filePath: string): Promise<number | null> {
  return configuredHost.availableDiskSpace ? configuredHost.availableDiskSpace(filePath) : null;
}
