import type {
  AssetMetadataInspectionGroup,
  AssetMetadataInspectionItem,
  AssetMetadataValueKind,
  AssetWorkflowMetadata,
} from '../../shared/asset-metadata-inspection';

const MAX_TEXT_VALUE_BYTES = 8 * 1024 * 1024;
const MAX_ID3_FRAMES = 4096;
const COMFYUI_ENTITY = { id: 'comfyui', label: 'ComfyUI' } as const;

export interface AudioMetadataInspection {
  groups: AssetMetadataInspectionGroup[];
  warnings: string[];
  workflowMetadata?: AssetWorkflowMetadata[];
}

interface MpegFrameInfo {
  version: '1' | '2' | '2.5';
  layer: 'I' | 'II' | 'III';
  bitrateKbps: number;
  sampleRateHz: number;
  channelMode: 'Stereo' | 'Joint stereo' | 'Dual channel' | 'Mono';
  channels: 1 | 2;
  frameLength: number;
  samplesPerFrame: number;
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
): AssetMetadataInspectionItem {
  return {
    id: `${namespace}/${encodeURIComponent(key)}/${occurrence}`,
    key,
    value,
    valueKind:
      typeof value === 'string'
        ? valueKind(value)
        : typeof value === 'number'
          ? 'number'
          : 'boolean',
  };
}

function synchsafe(bytes: Buffer, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.byteLength) return null;
  const a = bytes[offset]!;
  const b = bytes[offset + 1]!;
  const c = bytes[offset + 2]!;
  const d = bytes[offset + 3]!;
  if ((a | b | c | d) & 0x80) return null;
  return (a << 21) | (b << 14) | (c << 7) | d;
}

function decodeUtf16Be(bytes: Buffer): string {
  const swapped = Buffer.allocUnsafe(bytes.byteLength - (bytes.byteLength % 2));
  for (let index = 0; index + 1 < bytes.byteLength; index += 2) {
    swapped[index] = bytes[index + 1]!;
    swapped[index + 1] = bytes[index]!;
  }
  return swapped.toString('utf16le');
}

function stripTrailingNulls(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0) end -= 1;
  return value.slice(0, end);
}

function decodeText(bytes: Buffer, encoding: number): string | null {
  if (bytes.byteLength > MAX_TEXT_VALUE_BYTES) return null;
  if (encoding === 0) return stripTrailingNulls(bytes.toString('latin1'));
  if (encoding === 3) return stripTrailingNulls(bytes.toString('utf8'));
  if (encoding === 2) return stripTrailingNulls(decodeUtf16Be(bytes));
  if (encoding !== 1) return null;
  if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
    return stripTrailingNulls(decodeUtf16Be(bytes.subarray(2)));
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return stripTrailingNulls(bytes.subarray(2).toString('utf16le'));
  return stripTrailingNulls(bytes.toString('utf16le'));
}

function textTerminatorLength(encoding: number): 1 | 2 {
  return encoding === 1 || encoding === 2 ? 2 : 1;
}

function findTextTerminator(bytes: Buffer, encoding: number): number {
  const length = textTerminatorLength(encoding);
  if (length === 1) return bytes.indexOf(0);
  for (let index = 0; index + 1 < bytes.byteLength; index += 2) {
    if (bytes[index] === 0 && bytes[index + 1] === 0) return index;
  }
  return -1;
}

function parseTextFrame(frameId: string, data: Buffer): { key: string; value: string } | null {
  if (data.byteLength < 1) return null;
  const encoding = data[0]!;
  const payload = data.subarray(1);
  if (frameId === 'TXXX') {
    const separator = findTextTerminator(payload, encoding);
    if (separator < 0) return null;
    const description = decodeText(payload.subarray(0, separator), encoding);
    const value = decodeText(
      payload.subarray(separator + textTerminatorLength(encoding)),
      encoding,
    );
    if (description === null || value === null) return null;
    return { key: description ? `TXXX:${description}` : 'TXXX', value };
  }
  const value = decodeText(payload, encoding);
  return value === null ? null : { key: frameId, value };
}

function parseId3v2(bytes: Buffer): {
  group?: AssetMetadataInspectionGroup;
  audioStart: number;
  warnings: string[];
  hasComfyUiWorkflow: boolean;
} {
  if (bytes.byteLength < 10 || bytes.toString('ascii', 0, 3) !== 'ID3')
    return { audioStart: 0, warnings: [], hasComfyUiWorkflow: false };

  const major = bytes[3]!;
  const revision = bytes[4]!;
  const size = synchsafe(bytes, 6);
  if ((major !== 3 && major !== 4) || size === null) {
    return {
      audioStart: 10,
      warnings: ['Some embedded audio metadata could not be decoded.'],
      hasComfyUiWorkflow: false,
    };
  }

  const declaredEnd = 10 + size;
  const tagEnd = Math.min(declaredEnd, bytes.byteLength);
  const warnings =
    declaredEnd > bytes.byteLength ? ['Some embedded audio metadata could not be decoded.'] : [];
  const namespace = `ID3v2.${major}`;
  const items: AssetMetadataInspectionItem[] = [
    item(namespace, 'Version', `2.${major}.${revision}`),
  ];
  const occurrences = new Map<string, number>();
  let hasComfyUiWorkflow = false;
  let offset = 10;
  let frameCount = 0;

  // Extended-header parsing can be added when a real supported fixture requires it. Treat it as a
  // partial decode today rather than attempting to interpret frame bytes at the wrong offset.
  if ((bytes[5]! & 0x40) !== 0) {
    warnings.push('Some embedded audio metadata could not be decoded.');
    return {
      group: { id: namespace, namespace, items },
      audioStart: declaredEnd <= bytes.byteLength ? declaredEnd : tagEnd,
      warnings: [...new Set(warnings)],
      hasComfyUiWorkflow: false,
    };
  }

  while (offset + 10 <= tagEnd && frameCount < MAX_ID3_FRAMES) {
    const frameId = bytes.toString('ascii', offset, offset + 4);
    if (frameId === '\u0000\u0000\u0000\u0000') break;
    if (!/^[A-Z0-9]{4}$/u.test(frameId)) {
      warnings.push('Some embedded audio metadata could not be decoded.');
      break;
    }
    const frameSize = major === 4 ? synchsafe(bytes, offset + 4) : bytes.readUInt32BE(offset + 4);
    if (frameSize === null || frameSize < 0 || offset + 10 + frameSize > tagEnd) {
      warnings.push('Some embedded audio metadata could not be decoded.');
      break;
    }
    const frameStatusFlags = bytes[offset + 8]!;
    const frameFormatFlags = bytes[offset + 9]!;
    const data = bytes.subarray(offset + 10, offset + 10 + frameSize);
    if (frameStatusFlags !== 0 || frameFormatFlags !== 0) {
      warnings.push('Some embedded audio metadata could not be decoded.');
      offset += 10 + frameSize;
      frameCount += 1;
      continue;
    }
    if (frameId.startsWith('T')) {
      const parsed = parseTextFrame(frameId, data);
      if (parsed) {
        const occurrence = occurrences.get(parsed.key) ?? 0;
        items.push(item(namespace, parsed.key, parsed.value, occurrence));
        occurrences.set(parsed.key, occurrence + 1);
        if (parsed.key.toLowerCase() === 'txxx:workflow' && valueKind(parsed.value) === 'json')
          hasComfyUiWorkflow = true;
      } else {
        warnings.push('Some embedded audio metadata could not be decoded.');
      }
    }
    offset += 10 + frameSize;
    frameCount += 1;
  }
  if (frameCount >= MAX_ID3_FRAMES)
    warnings.push('Some embedded audio metadata could not be decoded.');

  return {
    group: { id: namespace, namespace, items },
    audioStart: declaredEnd <= bytes.byteLength ? declaredEnd : tagEnd,
    warnings: [...new Set(warnings)],
    hasComfyUiWorkflow,
  };
}

const MPEG1_LAYER3_BITRATES = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
] as const;
const MPEG2_LAYER3_BITRATES = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
] as const;

function parseMpegFrame(bytes: Buffer, offset: number): MpegFrameInfo | null {
  if (offset < 0 || offset + 4 > bytes.byteLength) return null;
  const header = bytes.readUInt32BE(offset);
  if ((header & 0xffe00000) >>> 0 !== 0xffe00000) return null;
  const versionBits = (header >>> 19) & 0x03;
  const layerBits = (header >>> 17) & 0x03;
  const bitrateIndex = (header >>> 12) & 0x0f;
  const sampleRateIndex = (header >>> 10) & 0x03;
  const padding = (header >>> 9) & 0x01;
  const channelModeBits = (header >>> 6) & 0x03;
  if (
    versionBits === 1 ||
    layerBits === 0 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    sampleRateIndex === 3
  )
    return null;

  const version: MpegFrameInfo['version'] =
    versionBits === 3 ? '1' : versionBits === 2 ? '2' : '2.5';
  const layer: MpegFrameInfo['layer'] = layerBits === 3 ? 'I' : layerBits === 2 ? 'II' : 'III';
  if (layer !== 'III') return null;
  const bitrateKbps =
    version === '1' ? MPEG1_LAYER3_BITRATES[bitrateIndex]! : MPEG2_LAYER3_BITRATES[bitrateIndex]!;
  if (bitrateKbps === 0) return null;
  const baseRates = [44100, 48000, 32000] as const;
  const base = baseRates[sampleRateIndex]!;
  const sampleRateHz = version === '1' ? base : version === '2' ? base / 2 : base / 4;
  const channelModes = ['Stereo', 'Joint stereo', 'Dual channel', 'Mono'] as const;
  const channelMode = channelModes[channelModeBits]!;
  const channels = channelMode === 'Mono' ? 1 : 2;
  const samplesPerFrame = version === '1' ? 1152 : 576;
  const coefficient = version === '1' ? 144000 : 72000;
  const frameLength = Math.floor((coefficient * bitrateKbps) / sampleRateHz) + padding;
  if (frameLength < 4) return null;
  return {
    version,
    layer,
    bitrateKbps,
    sampleRateHz,
    channelMode,
    channels,
    frameLength,
    samplesPerFrame,
  };
}

function findFirstMpegFrame(
  bytes: Buffer,
  start: number,
): { offset: number; frame: MpegFrameInfo } | null {
  for (let offset = Math.max(0, start); offset + 4 <= bytes.byteLength; offset += 1) {
    const frame = parseMpegFrame(bytes, offset);
    if (!frame) continue;
    if (offset + frame.frameLength > bytes.byteLength) continue;
    return { offset, frame };
  }
  return null;
}

function inspectMpeg(bytes: Buffer, start: number): AssetMetadataInspectionGroup | undefined {
  const first = findFirstMpegFrame(bytes, start);
  if (!first) return undefined;
  const items = [
    item('MPEG', 'Codec', 'MP3'),
    item('MPEG', 'MPEGVersion', first.frame.version),
    item('MPEG', 'Layer', first.frame.layer),
    item('MPEG', 'SampleRateHz', first.frame.sampleRateHz),
    item('MPEG', 'Channels', first.frame.channels),
    item('MPEG', 'ChannelMode', first.frame.channelMode),
  ];

  let offset = first.offset;
  let totalSamples = 0;
  let totalFrameBytes = 0;
  let frameCount = 0;
  const sampleRate = first.frame.sampleRateHz;
  while (offset + 4 <= bytes.byteLength) {
    const frame = parseMpegFrame(bytes, offset);
    if (
      !frame ||
      frame.sampleRateHz !== sampleRate ||
      offset + frame.frameLength > bytes.byteLength
    )
      break;
    totalSamples += frame.samplesPerFrame;
    totalFrameBytes += frame.frameLength;
    frameCount += 1;
    offset += frame.frameLength;
  }
  if (frameCount > 0) {
    const durationSeconds = totalSamples / sampleRate;
    items.push(
      item('MPEG', 'BitrateKbps', Math.round((totalFrameBytes * 8) / durationSeconds / 1000)),
    );
    items.push(item('MPEG', 'DurationSeconds', durationSeconds));
  }
  return { id: 'MPEG', namespace: 'MPEG', items };
}

export function inspectAudioMetadata(bytes: Buffer): AudioMetadataInspection {
  const id3 = parseId3v2(bytes);
  const groups: AssetMetadataInspectionGroup[] = [];
  if (id3.group) groups.push(id3.group);
  const mpeg = inspectMpeg(bytes, id3.audioStart);
  if (mpeg) groups.push(mpeg);
  const warnings = [...id3.warnings];
  if (!mpeg && bytes.byteLength > 0)
    warnings.push('Some embedded audio metadata could not be decoded.');
  return {
    groups,
    warnings: [...new Set(warnings)],
    ...(id3.hasComfyUiWorkflow
      ? { workflowMetadata: [{ tool: COMFYUI_ENTITY, kind: 'workflow' as const }] }
      : {}),
  };
}
