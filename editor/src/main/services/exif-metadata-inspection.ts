import type {
  AssetMetadataInspectionGroup,
  AssetMetadataInspectionItem,
  AssetMetadataInspectionWarning,
} from '../../shared/asset-metadata-inspection';

const MAX_EXIF_IFD_ENTRIES = 4096;
const MAX_EXIF_IFDS = 64;
const MAX_TEXT_VALUE_BYTES = 8 * 1024 * 1024;

const TIFF_TAGS: Record<number, string> = {
  0x0100: 'ImageWidth',
  0x0101: 'ImageLength',
  0x0102: 'BitsPerSample',
  0x0103: 'Compression',
  0x0106: 'PhotometricInterpretation',
  0x010e: 'ImageDescription',
  0x010f: 'Make',
  0x0110: 'Model',
  0x0111: 'StripOffsets',
  0x0112: 'Orientation',
  0x0115: 'SamplesPerPixel',
  0x0116: 'RowsPerStrip',
  0x0117: 'StripByteCounts',
  0x011a: 'XResolution',
  0x011b: 'YResolution',
  0x0128: 'ResolutionUnit',
  0x0131: 'Software',
  0x0132: 'DateTime',
  0x013b: 'Artist',
  0x014a: 'SubIFDs',
  0x0213: 'YCbCrPositioning',
  0x8298: 'Copyright',
  0x8769: 'ExifIFDPointer',
  0x8825: 'GPSInfoIFDPointer',
};

const EXIF_TAGS: Record<number, string> = {
  0x829a: 'ExposureTime',
  0x829d: 'FNumber',
  0x8822: 'ExposureProgram',
  0x8827: 'ISOSpeedRatings',
  0x8830: 'SensitivityType',
  0x9000: 'ExifVersion',
  0x9003: 'DateTimeOriginal',
  0x9004: 'DateTimeDigitized',
  0x9101: 'ComponentsConfiguration',
  0x9102: 'CompressedBitsPerPixel',
  0x9201: 'ShutterSpeedValue',
  0x9202: 'ApertureValue',
  0x9203: 'BrightnessValue',
  0x9204: 'ExposureBiasValue',
  0x9205: 'MaxApertureValue',
  0x9206: 'SubjectDistance',
  0x9207: 'MeteringMode',
  0x9208: 'LightSource',
  0x9209: 'Flash',
  0x920a: 'FocalLength',
  0x927c: 'MakerNote',
  0x9286: 'UserComment',
  0x9290: 'SubSecTime',
  0x9291: 'SubSecTimeOriginal',
  0x9292: 'SubSecTimeDigitized',
  0xa000: 'FlashpixVersion',
  0xa001: 'ColorSpace',
  0xa002: 'PixelXDimension',
  0xa003: 'PixelYDimension',
  0xa005: 'InteroperabilityIFDPointer',
  0xa20e: 'FocalPlaneXResolution',
  0xa20f: 'FocalPlaneYResolution',
  0xa210: 'FocalPlaneResolutionUnit',
  0xa217: 'SensingMethod',
  0xa300: 'FileSource',
  0xa301: 'SceneType',
  0xa401: 'CustomRendered',
  0xa402: 'ExposureMode',
  0xa403: 'WhiteBalance',
  0xa404: 'DigitalZoomRatio',
  0xa405: 'FocalLengthIn35mmFilm',
  0xa406: 'SceneCaptureType',
  0xa407: 'GainControl',
  0xa408: 'Contrast',
  0xa409: 'Saturation',
  0xa40a: 'Sharpness',
  0xa40c: 'SubjectDistanceRange',
  0xa420: 'ImageUniqueID',
};

const GPS_TAGS: Record<number, string> = {
  0x0000: 'GPSVersionID',
  0x0001: 'GPSLatitudeRef',
  0x0002: 'GPSLatitude',
  0x0003: 'GPSLongitudeRef',
  0x0004: 'GPSLongitude',
  0x0005: 'GPSAltitudeRef',
  0x0006: 'GPSAltitude',
  0x0007: 'GPSTimeStamp',
  0x0008: 'GPSSatellites',
  0x0009: 'GPSStatus',
  0x000a: 'GPSMeasureMode',
  0x000b: 'GPSDOP',
  0x000c: 'GPSSpeedRef',
  0x000d: 'GPSSpeed',
  0x0010: 'GPSImgDirectionRef',
  0x0011: 'GPSImgDirection',
  0x0012: 'GPSMapDatum',
  0x001d: 'GPSDateStamp',
};

const INTEROP_TAGS: Record<number, string> = {
  0x0001: 'InteroperabilityIndex',
  0x0002: 'InteroperabilityVersion',
};

const TYPE_BYTES: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  7: 1,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
};

interface TiffReader {
  bytes: Buffer;
  littleEndian: boolean;
}

function tagName(tag: number, path: string): string {
  const registry = path.startsWith('GPS')
    ? GPS_TAGS
    : path.startsWith('Exif/Interop')
      ? INTEROP_TAGS
      : path.startsWith('Exif')
        ? EXIF_TAGS
        : TIFF_TAGS;
  return registry[tag] ?? `0x${tag.toString(16).padStart(4, '0').toUpperCase()}`;
}

function readUInt16(reader: TiffReader, offset: number): number | null {
  if (offset < 0 || offset + 2 > reader.bytes.byteLength) return null;
  return reader.littleEndian
    ? reader.bytes.readUInt16LE(offset)
    : reader.bytes.readUInt16BE(offset);
}

function readUInt32(reader: TiffReader, offset: number): number | null {
  if (offset < 0 || offset + 4 > reader.bytes.byteLength) return null;
  return reader.littleEndian
    ? reader.bytes.readUInt32LE(offset)
    : reader.bytes.readUInt32BE(offset);
}

function readInt32(reader: TiffReader, offset: number): number | null {
  if (offset < 0 || offset + 4 > reader.bytes.byteLength) return null;
  return reader.littleEndian ? reader.bytes.readInt32LE(offset) : reader.bytes.readInt32BE(offset);
}

function readFloat(reader: TiffReader, offset: number): number | null {
  if (offset < 0 || offset + 4 > reader.bytes.byteLength) return null;
  return reader.littleEndian ? reader.bytes.readFloatLE(offset) : reader.bytes.readFloatBE(offset);
}

function readDouble(reader: TiffReader, offset: number): number | null {
  if (offset < 0 || offset + 8 > reader.bytes.byteLength) return null;
  return reader.littleEndian
    ? reader.bytes.readDoubleLE(offset)
    : reader.bytes.readDoubleBE(offset);
}

function itemId(path: string, tag: number, occurrence: number): string {
  return `EXIF/${encodeURIComponent(path)}/${tag.toString(16).padStart(4, '0')}/${occurrence}`;
}

function binaryItem(
  path: string,
  tag: number,
  key: string,
  byteSize: number,
  occurrence: number,
): AssetMetadataInspectionItem {
  return {
    id: itemId(path, tag, occurrence),
    key,
    value: '',
    valueKind: 'binary',
    byteSize,
  };
}

function limitedItem(
  path: string,
  tag: number,
  key: string,
  byteSize: number,
  occurrence: number,
): AssetMetadataInspectionItem {
  return {
    id: itemId(path, tag, occurrence),
    key,
    value: '',
    valueKind: 'limited',
    byteSize,
    limitReason: 'value-too-large',
  };
}

function normalizedValue(values: Array<number | string>): string | number {
  if (values.length === 1) return values[0]!;
  return JSON.stringify(values);
}

function valueKind(value: string | number): AssetMetadataInspectionItem['valueKind'] {
  return typeof value === 'number' ? 'number' : value.startsWith('[') ? 'json' : 'text';
}

function parseEntryValue(
  reader: TiffReader,
  type: number,
  count: number,
  valueOffset: number,
  byteLength: number,
): { value?: string | number; binary?: boolean; limited?: boolean } | null {
  if (byteLength > MAX_TEXT_VALUE_BYTES && type === 2) return { limited: true };
  if (valueOffset < 0 || valueOffset + byteLength > reader.bytes.byteLength) return null;
  if (type === 7) return { binary: true };
  if (type === 2) {
    const raw = reader.bytes.subarray(valueOffset, valueOffset + byteLength);
    const zero = raw.indexOf(0);
    return { value: raw.subarray(0, zero >= 0 ? zero : raw.byteLength).toString('utf8') };
  }

  const values: Array<number | string> = [];
  const pushNumber = (value: number | null) => {
    if (value === null || !Number.isFinite(value)) return false;
    values.push(value);
    return true;
  };
  for (let index = 0; index < count; index += 1) {
    const offset = valueOffset + index * (TYPE_BYTES[type] ?? 0);
    if (type === 1) values.push(reader.bytes[offset]!);
    else if (type === 3) {
      const value = readUInt16(reader, offset);
      if (value === null) return null;
      values.push(value);
    } else if (type === 4) {
      const value = readUInt32(reader, offset);
      if (value === null) return null;
      values.push(value);
    } else if (type === 5 || type === 10) {
      const numerator = type === 5 ? readUInt32(reader, offset) : readInt32(reader, offset);
      const denominator =
        type === 5 ? readUInt32(reader, offset + 4) : readInt32(reader, offset + 4);
      if (numerator === null || denominator === null) return null;
      values.push(denominator === 0 ? `${numerator}/0` : numerator / denominator);
    } else if (type === 9) {
      const value = readInt32(reader, offset);
      if (value === null) return null;
      values.push(value);
    } else if (type === 11) {
      if (!pushNumber(readFloat(reader, offset))) return null;
    } else if (type === 12) {
      if (!pushNumber(readDouble(reader, offset))) return null;
    } else return { binary: true };
  }
  return { value: normalizedValue(values) };
}

function tiffPayload(raw: Buffer): Buffer | null {
  if (raw.byteLength >= 6 && raw.toString('ascii', 0, 6) === 'Exif\u0000\u0000')
    return raw.subarray(6);
  return raw;
}

export function inspectExifMetadata(raw: Buffer): {
  group?: AssetMetadataInspectionGroup;
  warnings: AssetMetadataInspectionWarning[];
} {
  const bytes = tiffPayload(raw);
  if (!bytes || bytes.byteLength < 8) return { warnings: ['partial-decode'] };
  const endian = bytes.toString('ascii', 0, 2);
  if (endian !== 'II' && endian !== 'MM') return { warnings: ['partial-decode'] };
  const reader: TiffReader = { bytes, littleEndian: endian === 'II' };
  if (readUInt16(reader, 2) !== 42) return { warnings: ['partial-decode'] };
  const firstIfd = readUInt32(reader, 4);
  if (firstIfd === null) return { warnings: ['partial-decode'] };

  const items: AssetMetadataInspectionItem[] = [];
  const warnings: AssetMetadataInspectionWarning[] = [];
  const visited = new Set<number>();
  let ifdCount = 0;

  const parseIfd = (offset: number, path: string): void => {
    if (ifdCount >= MAX_EXIF_IFDS || visited.has(offset)) return;
    visited.add(offset);
    ifdCount += 1;
    const entryCount = readUInt16(reader, offset);
    if (entryCount === null) {
      warnings.push('partial-decode');
      return;
    }
    if (entryCount > MAX_EXIF_IFD_ENTRIES) {
      warnings.push('partial-decode');
      return;
    }
    const occurrences = new Map<number, number>();
    for (let index = 0; index < entryCount; index += 1) {
      const entryOffset = offset + 2 + index * 12;
      if (entryOffset + 12 > bytes.byteLength) {
        warnings.push('partial-decode');
        break;
      }
      const tag = readUInt16(reader, entryOffset);
      const type = readUInt16(reader, entryOffset + 2);
      const count = readUInt32(reader, entryOffset + 4);
      if (tag === null || type === null || count === null) {
        warnings.push('partial-decode');
        continue;
      }
      const typeBytes = TYPE_BYTES[type];
      if (!typeBytes || count > Number.MAX_SAFE_INTEGER / typeBytes) {
        warnings.push('partial-decode');
        continue;
      }
      const byteLength = count * typeBytes;
      const externalOffset = readUInt32(reader, entryOffset + 8);
      const valueOffset = byteLength <= 4 ? entryOffset + 8 : externalOffset;
      if (valueOffset === null) {
        warnings.push('partial-decode');
        continue;
      }
      const occurrence = occurrences.get(tag) ?? 0;
      occurrences.set(tag, occurrence + 1);
      const key = tagName(tag, path);
      const parsed = parseEntryValue(reader, type, count, valueOffset, byteLength);
      if (!parsed) {
        warnings.push('partial-decode');
        continue;
      }
      if (parsed.limited) items.push(limitedItem(path, tag, key, byteLength, occurrence));
      else if (parsed.binary) items.push(binaryItem(path, tag, key, byteLength, occurrence));
      else if (parsed.value !== undefined) {
        items.push({
          id: itemId(path, tag, occurrence),
          key,
          value: parsed.value,
          valueKind: valueKind(parsed.value),
        });
      }

      if (type === 4 && count === 1 && typeof parsed.value === 'number') {
        if (tag === 0x8769) parseIfd(parsed.value, 'Exif');
        else if (tag === 0x8825) parseIfd(parsed.value, 'GPS');
        else if (tag === 0xa005) parseIfd(parsed.value, 'Exif/Interop');
      }
    }
    const nextOffsetPosition = offset + 2 + entryCount * 12;
    const nextOffset = readUInt32(reader, nextOffsetPosition);
    if (nextOffset && nextOffset < bytes.byteLength) parseIfd(nextOffset, `${path}/Next`);
  };

  parseIfd(firstIfd, 'IFD0');
  return {
    ...(items.length > 0 ? { group: { id: 'EXIF', namespace: 'EXIF', items } } : {}),
    warnings: [...new Set(warnings)],
  };
}
