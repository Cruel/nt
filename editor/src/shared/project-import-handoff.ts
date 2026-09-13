import path from 'node:path';
import { z } from 'zod';

export const NOVELTEA_DESKTOP_PROTOCOL = 'noveltea' as const;
export const NOVELTEA_PROJECT_IMPORT_HOST = 'import' as const;

const sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/i, 'Expected SHA-256 must be 64 hexadecimal characters.');
const projectNameSchema = z.string().trim().min(1).max(200);

const localProjectImportSourceSchema = z.object({
  kind: z.literal('local'),
  bundlePath: z.string().min(1).max(32_768),
});

const remoteProjectArtifactUrlSchema = z
  .string()
  .url()
  .max(16_384)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.pathname.toLocaleLowerCase('en-US').endsWith('.ntproject')
    );
  }, 'Remote Project URL must be credential-free HTTPS and end in .ntproject.');

const remoteProjectImportSourceSchema = z.object({
  kind: z.literal('remote'),
  url: remoteProjectArtifactUrlSchema,
  sha256: sha256Schema,
});

export const desktopProjectImportRequestSchema = z.object({
  source: z.discriminatedUnion('kind', [
    localProjectImportSourceSchema,
    remoteProjectImportSourceSchema,
  ]),
  suggestedName: projectNameSchema,
});

export type DesktopProjectImportRequest = z.infer<typeof desktopProjectImportRequestSchema>;

export const completeDesktopProjectImportRequestSchema = z.object({
  request: desktopProjectImportRequestSchema,
  projectName: projectNameSchema,
  destination: z.string().min(1).max(32_768),
});

export type CompleteDesktopProjectImportRequest = z.infer<
  typeof completeDesktopProjectImportRequestSchema
>;

export interface DesktopProjectImportResult {
  success: boolean;
  projectPath?: string;
  projectFilePath?: string;
  error?: string;
}

function suggestedNameFromBundlePath(value: string): string {
  const decoded = value.replace(/[\\/]+$/, '');
  const base = path
    .basename(decoded)
    .replace(/\.ntproject$/i, '')
    .trim();
  return base || 'Imported Project';
}

function parseRemoteImportUrl(value: string): DesktopProjectImportRequest | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== `${NOVELTEA_DESKTOP_PROTOCOL}:` ||
    url.hostname !== NOVELTEA_PROJECT_IMPORT_HOST
  )
    return null;
  if (url.pathname !== '' && url.pathname !== '/') return null;

  const artifact = url.searchParams.get('url');
  const sha256 = url.searchParams.get('sha256');
  if (!artifact || !sha256 || !sha256Schema.safeParse(sha256).success) return null;

  if (!remoteProjectArtifactUrlSchema.safeParse(artifact).success) return null;
  const remote = new URL(artifact);

  const explicitName = url.searchParams.get('name')?.trim();
  const suggestedName =
    explicitName && projectNameSchema.safeParse(explicitName).success
      ? explicitName
      : suggestedNameFromBundlePath(remote.pathname);

  return {
    source: {
      kind: 'remote',
      url: remote.toString(),
      sha256: sha256.toLocaleLowerCase('en-US'),
    },
    suggestedName,
  };
}

export function normalizeDesktopProjectImportArgument(
  argument: string,
  cwd: string,
): DesktopProjectImportRequest | null {
  const remote = parseRemoteImportUrl(argument);
  if (remote) return remote;

  const candidate = argument.trim();
  if (!candidate.toLocaleLowerCase('en-US').endsWith('.ntproject')) return null;
  const bundlePath = path.resolve(cwd, candidate);
  return {
    source: { kind: 'local', bundlePath },
    suggestedName: suggestedNameFromBundlePath(bundlePath),
  };
}
