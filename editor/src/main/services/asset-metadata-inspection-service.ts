import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import sharp from 'sharp';
import type { ActiveProjectSessionService } from './active-project-session-service';
import {
  resolveContainedOriginalAsset,
  type ResolvedOriginalAsset,
} from './project-original-asset-service';
import {
  projectOriginalAssetBoundaryCode,
  type ProjectOriginalAssetFailureCode,
} from '../../shared/project-original-asset';
import type {
  AssetMetadataInspectionGroup,
  AssetMetadataInspectionItem,
  AssetMetadataInspectionReadyResponse,
  AssetMetadataInspectionResponse,
  AssetMetadataValueKind,
} from '../../shared/asset-metadata-inspection';
import { inspectC2paMetadata } from './c2pa-metadata-inspection';
import { recognizeComfyUiMetadata } from './comfyui-metadata-recognition';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_TEXT_METADATA_VALUE_BYTES = 8 * 1024 * 1024;
const MAX_CACHED_METADATA_RESULTS = 128;

function sourceFailure(
  code: ProjectOriginalAssetFailureCode,
  message: string,
): AssetMetadataInspectionResponse {
  return {
    ok: false,
    status: 'failure',
    code,
    boundaryCode: projectOriginalAssetBoundaryCode(code),
    message,
  };
}

function decodeFailure(message: string): AssetMetadataInspectionResponse {
  return { ok: false, status: 'failure', code: 'decode-failed', message };
}

function valueKind(value: string): AssetMetadataValueKind {
  try {
    JSON.parse(value);
    return 'json';
  } catch {
    return 'text';
  }
}

function item(
  namespace: string,
  key: string,
  value: string | number | boolean,
  occurrence = 0,
  source = 'field',
): AssetMetadataInspectionItem {
  const kind: AssetMetadataValueKind =
    typeof value === 'string' ? valueKind(value) : typeof value === 'number' ? 'number' : 'boolean';
  return {
    id: `${namespace}/${source}/${encodeURIComponent(key)}/${occurrence}`,
    key,
    value,
    valueKind: kind,
  };
}

function jpegCommentItems(bytes: Buffer): AssetMetadataInspectionItem[] {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return [];
  const items: AssetMetadataInspectionItem[] = [];
  let occurrence = 0;
  let offset = 2;
  while (offset + 1 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) break;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) break;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) break;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) break;
    const dataStart = offset + 2;
    const dataEnd = offset + segmentLength;
    if (marker === 0xfe) {
      items.push(
        item('JPEG', 'Comment', bytes.toString('latin1', dataStart, dataEnd), occurrence, 'COM'),
      );
      occurrence += 1;
    }
    offset = dataEnd;
  }
  return items;
}

function pngTextItems(bytes: Buffer): AssetMetadataInspectionItem[] {
  if (bytes.byteLength < PNG_SIGNATURE.byteLength || !bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    return [];
  const items: AssetMetadataInspectionItem[] = [];
  const occurrences = new Map<string, number>();
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.byteLength) break;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(dataStart, dataEnd);
    let key: string | null = null;
    let value: string | null = null;
    if (type === 'tEXt') {
      const separator = data.indexOf(0);
      if (separator > 0) {
        key = data.toString('latin1', 0, separator);
        const textBytes = data.subarray(separator + 1);
        if (textBytes.byteLength > MAX_TEXT_METADATA_VALUE_BYTES)
          throw new Error('PNG textual metadata exceeds the inspection value limit.');
        value = textBytes.toString('latin1');
      }
    } else if (type === 'zTXt') {
      const separator = data.indexOf(0);
      if (separator > 0 && separator + 2 <= data.byteLength && data[separator + 1] === 0) {
        key = data.toString('latin1', 0, separator);
        value = inflateSync(data.subarray(separator + 2), {
          maxOutputLength: MAX_TEXT_METADATA_VALUE_BYTES,
        }).toString('latin1');
      }
    } else if (type === 'iTXt') {
      const keywordEnd = data.indexOf(0);
      if (keywordEnd > 0 && keywordEnd + 3 <= data.byteLength) {
        const compressionFlag = data[keywordEnd + 1];
        const compressionMethod = data[keywordEnd + 2];
        let cursor = keywordEnd + 3;
        const languageEnd = data.indexOf(0, cursor);
        if (languageEnd >= cursor) {
          cursor = languageEnd + 1;
          const translatedEnd = data.indexOf(0, cursor);
          if (translatedEnd >= cursor) {
            cursor = translatedEnd + 1;
            key = data.toString('latin1', 0, keywordEnd);
            const textBytes = data.subarray(cursor);
            if (compressionFlag === 1 && compressionMethod === 0) {
              value = inflateSync(textBytes, {
                maxOutputLength: MAX_TEXT_METADATA_VALUE_BYTES,
              }).toString('utf8');
            } else if (compressionFlag === 0) {
              if (textBytes.byteLength > MAX_TEXT_METADATA_VALUE_BYTES)
                throw new Error('PNG textual metadata exceeds the inspection value limit.');
              value = textBytes.toString('utf8');
            }
          }
        }
      }
    }
    if (key !== null && value !== null) {
      const occurrence = occurrences.get(key) ?? 0;
      items.push(item('PNG', key, value, occurrence, type));
      occurrences.set(key, occurrence + 1);
    }
    offset = chunkEnd;
    if (type === 'IEND') break;
  }
  return items;
}

async function readValidatedBytes(resolved: ResolvedOriginalAsset): Promise<Buffer | null> {
  const bytes = Buffer.allocUnsafe(resolved.size);
  let offset = 0;
  while (offset < resolved.size) {
    const { bytesRead } = await resolved.handle.read(bytes, offset, resolved.size - offset, offset);
    if (bytesRead === 0) return null;
    offset += bytesRead;
  }
  const stat = await resolved.handle.stat();
  if (stat.size !== resolved.size) return null;
  const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  return hash === resolved.contentHash ? bytes : null;
}

async function inspectImage(bytes: Buffer): Promise<AssetMetadataInspectionGroup[]> {
  const metadata = await sharp(bytes, { failOn: 'error' }).metadata();
  const namespace = (metadata.format ?? 'image').toUpperCase();
  const items: AssetMetadataInspectionItem[] = [];
  if (metadata.width !== undefined) items.push(item(namespace, 'ImageWidth', metadata.width));
  if (metadata.height !== undefined) items.push(item(namespace, 'ImageHeight', metadata.height));
  if (metadata.bitsPerSample !== undefined)
    items.push(item(namespace, 'BitsPerSample', metadata.bitsPerSample));
  if (metadata.space !== undefined) items.push(item(namespace, 'ColorSpace', metadata.space));
  if (metadata.channels !== undefined) items.push(item(namespace, 'Channels', metadata.channels));
  if (metadata.hasAlpha !== undefined) items.push(item(namespace, 'HasAlpha', metadata.hasAlpha));
  if (metadata.orientation !== undefined)
    items.push(item(namespace, 'Orientation', metadata.orientation));
  if (metadata.chromaSubsampling !== undefined)
    items.push(item(namespace, 'ChromaSubsampling', metadata.chromaSubsampling));
  if (metadata.isProgressive !== undefined)
    items.push(item(namespace, 'IsProgressive', metadata.isProgressive));

  if (namespace === 'PNG') items.push(...pngTextItems(bytes));
  if (namespace === 'JPEG') items.push(...jpegCommentItems(bytes));
  return items.length > 0 ? [{ id: namespace, namespace, items }] : [];
}

export class AssetMetadataInspectionService {
  private readonly cache = new Map<string, AssetMetadataInspectionReadyResponse>();

  constructor(private readonly sessions: ActiveProjectSessionService) {}

  async inspect(
    projectSessionId: string,
    assetId: string,
  ): Promise<AssetMetadataInspectionResponse> {
    if (!this.sessions.isCurrent(projectSessionId))
      return sourceFailure('stale-or-unknown', 'Project session is stale or unknown.');

    let authorized;
    try {
      authorized = this.sessions.requireActiveAsset(projectSessionId, assetId);
    } catch {
      return sourceFailure('unknown-asset', 'Asset is not admitted by the active Project session.');
    }
    if (authorized.asset.kind !== 'image') {
      return {
        ok: true,
        status: 'unsupported',
        kind: authorized.asset.kind,
        ...(authorized.asset.contentHash ? { contentHash: authorized.asset.contentHash } : {}),
        groups: [],
      };
    }

    const resolved = await resolveContainedOriginalAsset(this.sessions, projectSessionId, assetId, {
      requireKind: 'image',
    });
    if (typeof resolved === 'string')
      return sourceFailure(
        resolved,
        'Asset source could not be validated for metadata inspection.',
      );

    try {
      const cached = this.cache.get(resolved.contentHash);
      if (cached) return cached;
      const bytes = await readValidatedBytes(resolved);
      if (!bytes)
        return sourceFailure(
          'revision-mismatch',
          'Asset source changed during metadata inspection.',
        );
      const groups = await inspectImage(bytes);
      const c2pa = inspectC2paMetadata(bytes);
      if (c2pa.group) groups.push(c2pa.group);
      const comfyUi = recognizeComfyUiMetadata(groups);
      const provenanceStages = [
        ...(c2pa.provenance?.stages ?? []),
        ...(comfyUi?.provenance?.stages ?? []),
      ];
      const result: AssetMetadataInspectionReadyResponse = {
        ok: true,
        status: 'ready',
        kind: 'image',
        contentHash: resolved.contentHash,
        groups,
        ...(c2pa.c2pa ? { c2pa: c2pa.c2pa } : {}),
        ...(provenanceStages.length > 0 ? { provenance: { stages: provenanceStages } } : {}),
        ...(comfyUi
          ? {
              generation: {
                ...(comfyUi.prompt !== undefined ? { prompt: comfyUi.prompt } : {}),
                ...(comfyUi.negativePrompt !== undefined
                  ? { negativePrompt: comfyUi.negativePrompt }
                  : {}),
                facts: comfyUi.facts,
              },
            }
          : {}),
      };
      this.cache.set(resolved.contentHash, result);
      while (this.cache.size > MAX_CACHED_METADATA_RESULTS) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      return result;
    } catch (error) {
      return decodeFailure(
        error instanceof Error ? error.message : 'Asset metadata could not be inspected.',
      );
    } finally {
      await resolved.handle.close().catch(() => undefined);
    }
  }
}
