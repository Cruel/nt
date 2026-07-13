import { z } from 'zod';
import type { AuthoringRecordBase } from './authoring-project';

export const assetKindValues = [
  'image',
  'font',
  'audio',
  'script',
  'shader-source',
  'text',
  'data',
  'binary',
] as const;

export type AssetKind = (typeof assetKindValues)[number];

export const assetAliasPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export const assetSourceSchema = z.object({
  type: z.literal('project-file'),
  path: z.string().min(1),
}).strict();

export const assetDataSchema = z.object({
  kind: z.enum(assetKindValues),
  source: assetSourceSchema,
  aliases: z.array(z.string()).default([]),
  mimeType: z.string().optional(),
  extension: z.string().optional(),
  byteSize: z.number().nonnegative().optional(),
  contentHash: z.string().optional(),
  importedAt: z.string().optional(),
  originalName: z.string().optional(),
  originalPath: z.string().optional(),
  preview: z.object({
    thumbnailRevision: z.string().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    durationSeconds: z.number().nonnegative().optional(),
  }).strict().optional(),
}).strict();

export type AssetData = z.infer<typeof assetDataSchema>;

const imageExt = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg']);
const fontExt = new Set(['.ttf', '.otf', '.woff', '.woff2']);
const audioExt = new Set(['.mp3', '.ogg', '.wav', '.flac', '.m4a']);
const scriptExt = new Set(['.lua']);
const shaderExt = new Set(['.sc', '.glsl', '.vert', '.frag', '.vs', '.fs']);
const textExt = new Set(['.txt', '.md', '.rml', '.rcss', '.css']);
const dataExt = new Set(['.json', '.toml', '.yaml', '.yml', '.csv']);

export function parseAssetData(value: unknown): AssetData | null {
  const parsed = assetDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function isAssetRecord(record: AuthoringRecordBase | undefined | null): record is AuthoringRecordBase & { data: AssetData } {
  return !!record && parseAssetData(record.data) !== null;
}

export function normalizeExtension(extensionOrFilename: string): string {
  const lower = extensionOrFilename.toLowerCase();
  const lastSlash = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'));
  const basename = lower.slice(lastSlash + 1);
  const index = basename.lastIndexOf('.');
  if (index < 0) return lower.startsWith('.') ? lower : '';
  return basename.slice(index);
}

export function inferAssetKindFromExtension(extensionOrFilename: string): AssetKind {
  const extension = normalizeExtension(extensionOrFilename);
  if (imageExt.has(extension)) return 'image';
  if (fontExt.has(extension)) return 'font';
  if (audioExt.has(extension)) return 'audio';
  if (scriptExt.has(extension)) return 'script';
  if (shaderExt.has(extension)) return 'shader-source';
  if (textExt.has(extension)) return 'text';
  if (dataExt.has(extension)) return 'data';
  return 'binary';
}

export function assetFolderForKind(kind: AssetKind): string {
  switch (kind) {
    case 'image': return 'assets/images';
    case 'font': return 'assets/fonts';
    case 'audio': return 'assets/audio';
    case 'script': return 'assets/scripts';
    case 'shader-source': return 'assets/shaders';
    case 'text': return 'assets/text';
    case 'data': return 'assets/data';
    case 'binary': return 'assets/binary';
  }
}

export function defaultAssetIdFromFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() ?? filename;
  const withoutExtension = basename.replace(/\.[^.]*$/, '');
  const normalized = withoutExtension
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return /^[a-z]/.test(normalized) ? normalized : `asset-${normalized || 'file'}`;
}

export function normalizeAssetAlias(alias: string): string {
  return alias.trim().replace(/\s+/g, '-');
}

export function validateAssetAlias(alias: string): string | null {
  if (!alias.trim()) return 'Alias is required.';
  if (!assetAliasPattern.test(alias)) {
    return 'Alias must start with a lowercase letter and contain lowercase letters, numbers, dots, underscores, or hyphens.';
  }
  return null;
}

export function isSafeProjectAssetPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('\\') || path.includes(':') || path.includes('\\')) return false;
  if (path.includes('//')) return false;
  const parts = path.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

export function assetDataFromImportMetadata(metadata: {
  kind: AssetKind;
  projectRelativePath: string;
  aliases?: string[];
  mimeType?: string;
  extension?: string;
  byteSize?: number;
  contentHash?: string;
  importedAt?: string;
  originalName?: string;
  originalPath?: string;
}): AssetData {
  return {
    kind: metadata.kind,
    source: { type: 'project-file', path: metadata.projectRelativePath },
    aliases: metadata.aliases ?? [],
    mimeType: metadata.mimeType,
    extension: metadata.extension,
    byteSize: metadata.byteSize,
    contentHash: metadata.contentHash,
    importedAt: metadata.importedAt,
    originalName: metadata.originalName,
    originalPath: metadata.originalPath,
    preview: metadata.contentHash ? { thumbnailRevision: metadata.contentHash } : undefined,
  };
}
