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
  AssetMetadataInspectionWarning,
  AssetMetadataValueKind,
} from '../../shared/asset-metadata-inspection';
import { inspectC2paMetadata } from './c2pa-metadata-inspection';
import {
  identifyComfyUiWorkflowMetadata,
  recognizeComfyUiMetadata,
} from './comfyui-metadata-recognition';
import { inspectAudioMetadata } from './audio-metadata-inspection';
import { inspectExifMetadata } from './exif-metadata-inspection';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_TEXT_METADATA_VALUE_BYTES = 8 * 1024 * 1024;
const MAX_AGGREGATE_METADATA_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_RECOGNIZED_SUMMARY_TEXT_BYTES = 256 * 1024;
const MAX_XMP_ITEMS = 8192;
const MAX_XMP_DEPTH = 64;
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

function binaryItem(
  namespace: string,
  key: string,
  byteSize: number,
  occurrence = 0,
  source = 'field',
): AssetMetadataInspectionItem {
  return {
    id: `${namespace}/${source}/${encodeURIComponent(key)}/${occurrence}`,
    key,
    value: '',
    valueKind: 'binary',
    byteSize,
  };
}

function limitedItem(
  namespace: string,
  key: string,
  byteSize: number | undefined,
  occurrence = 0,
  source = 'field',
  limitReason: 'value-too-large' | 'aggregate-limit' = 'value-too-large',
): AssetMetadataInspectionItem {
  return {
    id: `${namespace}/${source}/${encodeURIComponent(key)}/${occurrence}`,
    key,
    value: '',
    valueKind: 'limited',
    ...(byteSize !== undefined ? { byteSize } : {}),
    limitReason,
  };
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/gu, (entity) => {
    if (entity === '&amp;') return '&';
    if (entity === '&lt;') return '<';
    if (entity === '&gt;') return '>';
    if (entity === '&quot;') return '"';
    if (entity === '&apos;') return "'";
    const numeric = entity.startsWith('&#x')
      ? Number.parseInt(entity.slice(3, -1), 16)
      : Number.parseInt(entity.slice(2, -1), 10);
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 0x10ffff
      ? String.fromCodePoint(numeric)
      : entity;
  });
}

function xmpItems(value: string): {
  items: AssetMetadataInspectionItem[];
  partial: boolean;
} {
  const items: AssetMetadataInspectionItem[] = [];
  const occurrences = new Map<string, number>();
  const stack: Array<{ name: string; path: string; text: string }> = [];
  const tokenPattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>/gu;
  let cursor = 0;
  let partial = false;

  const appendText = (text: string) => {
    if (stack.length === 0 || !text) return;
    stack[stack.length - 1]!.text += text;
  };
  const addTextItem = (key: string, path: string, text: string, source: string) => {
    const normalized = decodeXmlEntities(text.trim());
    if (!normalized) return;
    const occurrenceKey = `${path}/${source}`;
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    if (Buffer.byteLength(normalized, 'utf8') > MAX_TEXT_METADATA_VALUE_BYTES)
      items.push(
        limitedItem('XMP', key, Buffer.byteLength(normalized, 'utf8'), occurrence, occurrenceKey),
      );
    else items.push(item('XMP', key, normalized, occurrence, occurrenceKey));
  };

  for (const match of value.matchAll(tokenPattern)) {
    if (items.length >= MAX_XMP_ITEMS) {
      partial = true;
      break;
    }
    const index = match.index;
    appendText(value.slice(cursor, index));
    const token = match[0];
    cursor = index + token.length;
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) {
      appendText(token.slice(9, -3));
      continue;
    }
    if (token.startsWith('</')) {
      const closeName = token.slice(2, -1).trim();
      const current = stack.pop();
      if (!current || current.name !== closeName) {
        partial = true;
        continue;
      }
      addTextItem(current.name, current.path, current.text, 'text');
      continue;
    }
    if (token.startsWith('<!')) continue;
    const selfClosing = token.endsWith('/>');
    const body = token.slice(1, selfClosing ? -2 : -1).trim();
    const nameMatch = /^([^\s/>]+)/u.exec(body);
    if (!nameMatch) {
      partial = true;
      continue;
    }
    const name = nameMatch[1]!;
    const parentPath = stack.map((entry) => entry.name).join('/');
    const path = parentPath ? `${parentPath}/${name}` : name;
    const attributeText = body.slice(name.length);
    const attributePattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
    for (const attribute of attributeText.matchAll(attributePattern)) {
      const attributeName = attribute[1]!;
      const attributeValue = decodeXmlEntities(attribute[2] ?? attribute[3] ?? '');
      const occurrenceKey = `${path}/@${attributeName}`;
      const occurrence = occurrences.get(occurrenceKey) ?? 0;
      occurrences.set(occurrenceKey, occurrence + 1);
      items.push(item('XMP', attributeName, attributeValue, occurrence, occurrenceKey));
      if (items.length >= MAX_XMP_ITEMS) break;
    }
    if (!selfClosing) {
      if (stack.length >= MAX_XMP_DEPTH) {
        partial = true;
        break;
      }
      stack.push({ name, path, text: '' });
    }
  }
  appendText(value.slice(cursor));
  if (stack.length > 0) partial = true;
  return { items, partial };
}

function recognizedSummaryText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Buffer.byteLength(value, 'utf8') <= MAX_RECOGNIZED_SUMMARY_TEXT_BYTES ? value : undefined;
}

function applyAggregateMetadataLimit(groups: AssetMetadataInspectionGroup[]): {
  groups: AssetMetadataInspectionGroup[];
  limited: boolean;
} {
  let decodedTextBytes = 0;
  let limited = false;
  const nextGroups = groups.map((group) => ({
    ...group,
    items: group.items.map((metadataItem) => {
      if (metadataItem.valueKind === 'limited') {
        if (metadataItem.limitReason === 'aggregate-limit') limited = true;
        return metadataItem;
      }
      if (typeof metadataItem.value !== 'string' || metadataItem.valueKind === 'binary')
        return metadataItem;
      const byteSize = Buffer.byteLength(metadataItem.value, 'utf8');
      if (decodedTextBytes + byteSize <= MAX_AGGREGATE_METADATA_TEXT_BYTES) {
        decodedTextBytes += byteSize;
        return metadataItem;
      }
      limited = true;
      return {
        ...metadataItem,
        value: '',
        valueKind: 'limited' as const,
        byteSize,
        limitReason: 'aggregate-limit' as const,
      };
    }),
  }));
  return { groups: nextGroups, limited };
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

function pngTextItems(bytes: Buffer): {
  items: AssetMetadataInspectionItem[];
  warnings: AssetMetadataInspectionWarning[];
} {
  if (bytes.byteLength < PNG_SIGNATURE.byteLength || !bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    return { items: [], warnings: [] };
  const items: AssetMetadataInspectionItem[] = [];
  const warnings: AssetMetadataInspectionWarning[] = [];
  const occurrences = new Map<string, number>();
  let decodedTextBytes = 0;
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.byteLength) {
      warnings.push('partial-decode');
      break;
    }
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(dataStart, dataEnd);
    let key: string | null = null;
    let value: string | null = null;
    if (type === 'tEXt') {
      const separator = data.indexOf(0);
      if (separator > 0) {
        key = data.toString('latin1', 0, separator);
        const textBytes = data.subarray(separator + 1);
        const occurrence = occurrences.get(key) ?? 0;
        if (textBytes.byteLength > MAX_TEXT_METADATA_VALUE_BYTES) {
          items.push(limitedItem('PNG', key, textBytes.byteLength, occurrence, type));
          occurrences.set(key, occurrence + 1);
        } else if (decodedTextBytes + textBytes.byteLength > MAX_AGGREGATE_METADATA_TEXT_BYTES) {
          items.push(
            limitedItem('PNG', key, textBytes.byteLength, occurrence, type, 'aggregate-limit'),
          );
          occurrences.set(key, occurrence + 1);
        } else {
          value = textBytes.toString('latin1');
          decodedTextBytes += textBytes.byteLength;
        }
      } else warnings.push('partial-decode');
    } else if (type === 'zTXt') {
      const separator = data.indexOf(0);
      if (separator > 0 && separator + 2 <= data.byteLength && data[separator + 1] === 0) {
        key = data.toString('latin1', 0, separator);
        const occurrence = occurrences.get(key) ?? 0;
        const remainingAggregate = MAX_AGGREGATE_METADATA_TEXT_BYTES - decodedTextBytes;
        if (remainingAggregate <= 0) {
          items.push(limitedItem('PNG', key, data.byteLength, occurrence, type, 'aggregate-limit'));
          occurrences.set(key, occurrence + 1);
        } else {
          try {
            const inflated = inflateSync(data.subarray(separator + 2), {
              maxOutputLength: Math.min(MAX_TEXT_METADATA_VALUE_BYTES, remainingAggregate),
            });
            value = inflated.toString('latin1');
            decodedTextBytes += inflated.byteLength;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
              const reason =
                remainingAggregate < MAX_TEXT_METADATA_VALUE_BYTES
                  ? 'aggregate-limit'
                  : 'value-too-large';
              items.push(limitedItem('PNG', key, undefined, occurrence, type, reason));
              occurrences.set(key, occurrence + 1);
            } else warnings.push('partial-decode');
          }
        }
      } else warnings.push('partial-decode');
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
            const occurrence = occurrences.get(key) ?? 0;
            if (compressionFlag === 1 && compressionMethod === 0) {
              const remainingAggregate = MAX_AGGREGATE_METADATA_TEXT_BYTES - decodedTextBytes;
              if (remainingAggregate <= 0) {
                items.push(
                  limitedItem(
                    'PNG',
                    key,
                    textBytes.byteLength,
                    occurrence,
                    type,
                    'aggregate-limit',
                  ),
                );
                occurrences.set(key, occurrence + 1);
              } else {
                try {
                  const inflated = inflateSync(textBytes, {
                    maxOutputLength: Math.min(MAX_TEXT_METADATA_VALUE_BYTES, remainingAggregate),
                  });
                  value = inflated.toString('utf8');
                  decodedTextBytes += inflated.byteLength;
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
                    const reason =
                      remainingAggregate < MAX_TEXT_METADATA_VALUE_BYTES
                        ? 'aggregate-limit'
                        : 'value-too-large';
                    items.push(limitedItem('PNG', key, undefined, occurrence, type, reason));
                    occurrences.set(key, occurrence + 1);
                  } else warnings.push('partial-decode');
                }
              }
            } else if (compressionFlag === 0) {
              if (textBytes.byteLength > MAX_TEXT_METADATA_VALUE_BYTES) {
                items.push(limitedItem('PNG', key, textBytes.byteLength, occurrence, type));
                occurrences.set(key, occurrence + 1);
              } else if (
                decodedTextBytes + textBytes.byteLength >
                MAX_AGGREGATE_METADATA_TEXT_BYTES
              ) {
                items.push(
                  limitedItem(
                    'PNG',
                    key,
                    textBytes.byteLength,
                    occurrence,
                    type,
                    'aggregate-limit',
                  ),
                );
                occurrences.set(key, occurrence + 1);
              } else {
                value = textBytes.toString('utf8');
                decodedTextBytes += textBytes.byteLength;
              }
            } else warnings.push('partial-decode');
          } else warnings.push('partial-decode');
        } else warnings.push('partial-decode');
      } else warnings.push('partial-decode');
    }
    if (key !== null && value !== null) {
      const occurrence = occurrences.get(key) ?? 0;
      items.push(item('PNG', key, value, occurrence, type));
      occurrences.set(key, occurrence + 1);
    }
    offset = chunkEnd;
    if (type === 'IEND') break;
  }
  return { items, warnings: [...new Set(warnings)] };
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

async function inspectImage(bytes: Buffer): Promise<{
  groups: AssetMetadataInspectionGroup[];
  warnings: AssetMetadataInspectionWarning[];
}> {
  const metadata = await sharp(bytes, { failOn: 'error' }).metadata();
  const namespace = (metadata.format ?? 'image').toUpperCase();
  const items: AssetMetadataInspectionItem[] = [];
  if (metadata.width !== undefined) items.push(item(namespace, 'ImageWidth', metadata.width));
  if (metadata.height !== undefined) items.push(item(namespace, 'ImageHeight', metadata.height));
  if (metadata.bitsPerSample !== undefined)
    items.push(item(namespace, 'BitsPerSample', metadata.bitsPerSample));
  if (metadata.depth !== undefined) items.push(item(namespace, 'PixelDepth', metadata.depth));
  if (metadata.space !== undefined) items.push(item(namespace, 'ColorSpace', metadata.space));
  if (metadata.channels !== undefined) items.push(item(namespace, 'Channels', metadata.channels));
  if (metadata.hasAlpha !== undefined) items.push(item(namespace, 'HasAlpha', metadata.hasAlpha));
  if (metadata.hasProfile !== undefined)
    items.push(item(namespace, 'HasColorProfile', metadata.hasProfile));
  if (metadata.orientation !== undefined)
    items.push(item(namespace, 'Orientation', metadata.orientation));
  if (metadata.density !== undefined) items.push(item(namespace, 'DensityDpi', metadata.density));
  if (metadata.resolutionUnit !== undefined)
    items.push(item(namespace, 'ResolutionUnit', metadata.resolutionUnit));
  if (metadata.chromaSubsampling !== undefined)
    items.push(item(namespace, 'ChromaSubsampling', metadata.chromaSubsampling));
  if (metadata.isProgressive !== undefined)
    items.push(item(namespace, 'IsProgressive', metadata.isProgressive));
  if (metadata.isPalette !== undefined)
    items.push(item(namespace, 'IsPalette', metadata.isPalette));
  if (metadata.pages !== undefined) items.push(item(namespace, 'Pages', metadata.pages));
  if (metadata.pageHeight !== undefined)
    items.push(item(namespace, 'PageHeight', metadata.pageHeight));
  if (metadata.loop !== undefined) items.push(item(namespace, 'Loop', metadata.loop));
  if (metadata.delay !== undefined)
    items.push(item(namespace, 'FrameDelayMs', JSON.stringify(metadata.delay)));
  if (metadata.pagePrimary !== undefined)
    items.push(item(namespace, 'PrimaryPage', metadata.pagePrimary));
  if (metadata.compression !== undefined)
    items.push(item(namespace, 'Compression', metadata.compression));
  if (metadata.background !== undefined)
    items.push(item(namespace, 'Background', JSON.stringify(metadata.background)));

  const warnings: AssetMetadataInspectionWarning[] = [];
  if (namespace === 'PNG') {
    const png = pngTextItems(bytes);
    items.push(...png.items);
    warnings.push(...png.warnings);
  }
  if (namespace === 'JPEG') items.push(...jpegCommentItems(bytes));

  const groups: AssetMetadataInspectionGroup[] =
    items.length > 0 ? [{ id: namespace, namespace, items }] : [];
  if (metadata.exif) {
    const exif = inspectExifMetadata(metadata.exif);
    if (exif.group) groups.push(exif.group);
    else
      groups.push({
        id: 'EXIF',
        namespace: 'EXIF',
        items: [binaryItem('EXIF', 'Payload', metadata.exif.byteLength, 0, 'payload')],
      });
    warnings.push(...exif.warnings);
  }
  if (metadata.xmp) {
    const xmpText = metadata.xmpAsString ?? metadata.xmp.toString('utf8');
    const packet =
      Buffer.byteLength(xmpText, 'utf8') > MAX_TEXT_METADATA_VALUE_BYTES
        ? limitedItem('XMP', 'Packet', metadata.xmp.byteLength, 0, 'packet')
        : item('XMP', 'Packet', xmpText, 0, 'packet');
    const parsedXmp = xmpItems(xmpText);
    groups.push({ id: 'XMP', namespace: 'XMP', items: [packet, ...parsedXmp.items] });
    if (parsedXmp.partial) warnings.push('partial-decode');
  }
  if (metadata.iptc)
    groups.push({
      id: 'IPTC',
      namespace: 'IPTC',
      items: [binaryItem('IPTC', 'Payload', metadata.iptc.byteLength, 0, 'payload')],
    });
  if (metadata.icc)
    groups.push({
      id: 'ICC',
      namespace: 'ICC',
      items: [binaryItem('ICC', 'Profile', metadata.icc.byteLength, 0, 'profile')],
    });
  if (metadata.tifftagPhotoshop)
    groups.push({
      id: 'Photoshop',
      namespace: 'Photoshop',
      items: [
        binaryItem(
          'Photoshop',
          'TIFFTAG_PHOTOSHOP',
          metadata.tifftagPhotoshop.byteLength,
          0,
          'payload',
        ),
      ],
    });
  if (metadata.gainMap?.image)
    groups.push({
      id: 'GainMap',
      namespace: 'GainMap',
      items: [binaryItem('GainMap', 'Image', metadata.gainMap.image.byteLength, 0, 'image')],
    });
  return { groups, warnings: [...new Set(warnings)] };
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
    if (authorized.asset.kind !== 'image' && authorized.asset.kind !== 'audio') {
      return {
        ok: true,
        status: 'unsupported',
        kind: authorized.asset.kind,
        ...(authorized.asset.contentHash ? { contentHash: authorized.asset.contentHash } : {}),
        groups: [],
      };
    }

    const resolved = await resolveContainedOriginalAsset(this.sessions, projectSessionId, assetId, {
      requireKind: authorized.asset.kind,
    });
    if (typeof resolved === 'string')
      return sourceFailure(
        resolved,
        'Asset source could not be validated for metadata inspection.',
      );

    try {
      const cached = this.cache.get(resolved.contentHash);
      if (cached?.kind === authorized.asset.kind) return cached;
      if (authorized.asset.kind === 'audio' && resolved.mimeType !== 'audio/mpeg') {
        return {
          ok: true,
          status: 'unsupported',
          kind: 'audio',
          contentHash: resolved.contentHash,
          groups: [],
        };
      }
      const bytes = await readValidatedBytes(resolved);
      if (!bytes)
        return sourceFailure(
          'revision-mismatch',
          'Asset source changed during metadata inspection.',
        );
      let result: AssetMetadataInspectionReadyResponse;
      if (authorized.asset.kind === 'audio') {
        const audio = inspectAudioMetadata(bytes);
        const bounded = applyAggregateMetadataLimit(audio.groups);
        const warnings = [
          ...audio.warnings,
          ...(bounded.limited ? (['aggregate-limit-reached'] as const) : []),
        ];
        result = {
          ok: true,
          status: 'ready',
          kind: 'audio',
          contentHash: resolved.contentHash,
          groups: bounded.groups,
          ...(audio.workflowMetadata ? { workflowMetadata: audio.workflowMetadata } : {}),
          ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
        };
      } else {
        const image = await inspectImage(bytes);
        const groups = [...image.groups];
        const c2pa = inspectC2paMetadata(bytes);
        if (c2pa.group) groups.push(c2pa.group);
        const bounded = applyAggregateMetadataLimit(groups);
        const comfyUi = recognizeComfyUiMetadata(bounded.groups);
        const workflowMetadata = identifyComfyUiWorkflowMetadata(bounded.groups);
        const provenanceStages = [
          ...(c2pa.provenance?.stages ?? []),
          ...(comfyUi?.provenance?.stages ?? []),
        ];
        const warnings = [
          ...image.warnings,
          ...(c2pa.warnings ?? []),
          ...(bounded.limited ? (['aggregate-limit-reached'] as const) : []),
        ];
        const prompt = recognizedSummaryText(comfyUi?.prompt);
        const negativePrompt = recognizedSummaryText(comfyUi?.negativePrompt);
        result = {
          ok: true,
          status: 'ready',
          kind: 'image',
          contentHash: resolved.contentHash,
          groups: bounded.groups,
          ...(c2pa.c2pa ? { c2pa: c2pa.c2pa } : {}),
          ...(provenanceStages.length > 0 ? { provenance: { stages: provenanceStages } } : {}),
          ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
          ...(workflowMetadata ? { workflowMetadata } : {}),
          ...(comfyUi
            ? {
                generation: {
                  ...(prompt !== undefined ? { prompt } : {}),
                  ...(negativePrompt !== undefined ? { negativePrompt } : {}),
                  facts: comfyUi.facts,
                },
              }
            : {}),
        };
      }
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
