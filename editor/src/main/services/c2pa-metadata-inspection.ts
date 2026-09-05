import type {
  AssetMetadataInspectionGroup,
  AssetMetadataInspectionItem,
  AssetMetadataInspectionWarning,
  AssetRecognizedProvenance,
  AssetProvenanceEntity,
  AssetProvenanceStage,
} from '../../shared/asset-metadata-inspection';

const JUMB_TYPE = Buffer.from('jumb', 'ascii');
const MAX_CBOR_DEPTH = 32;
const MAX_CBOR_CONTAINER_ITEMS = 4096;
const MAX_CBOR_TEXT_BYTES = 1024 * 1024;
const MAX_CBOR_DECODED_NODES = 32768;
const MAX_C2PA_ASSERTIONS = 64;
const MAX_C2PA_METADATA_ITEMS = 8192;

interface C2paAssertion {
  label: string;
  value: unknown;
}

interface C2paInspection {
  group?: AssetMetadataInspectionGroup;
  c2pa?: { trust: 'unverified' };
  provenance?: AssetRecognizedProvenance;
  warnings?: AssetMetadataInspectionWarning[];
}

interface C2paAssertionParseResult {
  assertion?: C2paAssertion;
  partial: boolean;
}

interface CborCursor {
  offset: number;
  decodedNodes: number;
}

const PROVENANCE_ENTITY_REGISTRY = {
  openai: { id: 'openai', label: 'OpenAI' },
  openaiGptImage: { id: 'openai.gpt-image', label: 'gpt-image' },
  google: { id: 'google', label: 'Google' },
  googleGenerativeAi: { id: 'google.generative-ai', label: 'Google Generative AI' },
  googleSynthId: { id: 'google.synthid', label: 'SynthID' },
} as const satisfies Record<string, AssetProvenanceEntity>;

type ProvenanceEntityKey = keyof typeof PROVENANCE_ENTITY_REGISTRY;

function readCborLength(bytes: Buffer, cursor: CborCursor, additional: number): number {
  if (additional < 24) return additional;
  if (additional === 24) {
    if (cursor.offset + 1 > bytes.byteLength) throw new Error('CBOR integer is truncated.');
    return bytes[cursor.offset++]!;
  }
  if (additional === 25) {
    if (cursor.offset + 2 > bytes.byteLength) throw new Error('CBOR integer is truncated.');
    const value = bytes.readUInt16BE(cursor.offset);
    cursor.offset += 2;
    return value;
  }
  if (additional === 26) {
    if (cursor.offset + 4 > bytes.byteLength) throw new Error('CBOR integer is truncated.');
    const value = bytes.readUInt32BE(cursor.offset);
    cursor.offset += 4;
    return value;
  }
  if (additional === 27) {
    if (cursor.offset + 8 > bytes.byteLength) throw new Error('CBOR integer is truncated.');
    const value = bytes.readBigUInt64BE(cursor.offset);
    cursor.offset += 8;
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('CBOR integer exceeds safe range.');
    return Number(value);
  }
  throw new Error('Indefinite or unsupported CBOR length.');
}

function decodeHalfFloat(value: number): number {
  const sign = (value & 0x8000) === 0 ? 1 : -1;
  const exponent = (value >> 10) & 0x1f;
  const fraction = value & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function decodeCborValue(bytes: Buffer, cursor: CborCursor, depth: number): unknown {
  cursor.decodedNodes += 1;
  if (cursor.decodedNodes > MAX_CBOR_DECODED_NODES)
    throw new Error('CBOR decoded value count exceeds inspection limit.');
  if (depth > MAX_CBOR_DEPTH) throw new Error('CBOR nesting exceeds inspection limit.');
  if (cursor.offset >= bytes.byteLength) throw new Error('CBOR value is truncated.');
  const initial = bytes[cursor.offset++]!;
  const major = initial >> 5;
  const additional = initial & 0x1f;

  if (major === 0) return readCborLength(bytes, cursor, additional);
  if (major === 1) return -1 - readCborLength(bytes, cursor, additional);
  if (major === 2 || major === 3) {
    const length = readCborLength(bytes, cursor, additional);
    if (length > MAX_CBOR_TEXT_BYTES) throw new Error('CBOR string exceeds inspection limit.');
    if (cursor.offset + length > bytes.byteLength) throw new Error('CBOR string is truncated.');
    const value = bytes.subarray(cursor.offset, cursor.offset + length);
    cursor.offset += length;
    return major === 2 ? Buffer.from(value) : value.toString('utf8');
  }
  if (major === 4) {
    const length = readCborLength(bytes, cursor, additional);
    if (length > MAX_CBOR_CONTAINER_ITEMS) throw new Error('CBOR array exceeds inspection limit.');
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1)
      result.push(decodeCborValue(bytes, cursor, depth + 1));
    return result;
  }
  if (major === 5) {
    const length = readCborLength(bytes, cursor, additional);
    if (length > MAX_CBOR_CONTAINER_ITEMS) throw new Error('CBOR map exceeds inspection limit.');
    const result: Record<string, unknown> = {};
    for (let index = 0; index < length; index += 1) {
      const key = decodeCborValue(bytes, cursor, depth + 1);
      const value = decodeCborValue(bytes, cursor, depth + 1);
      if (typeof key === 'string') result[key] = value;
    }
    return result;
  }
  if (major === 6) {
    readCborLength(bytes, cursor, additional);
    return decodeCborValue(bytes, cursor, depth + 1);
  }
  if (major !== 7) throw new Error('Unsupported CBOR major type.');
  if (additional === 20) return false;
  if (additional === 21) return true;
  if (additional === 22) return null;
  if (additional === 23) return undefined;
  if (additional === 25) {
    if (cursor.offset + 2 > bytes.byteLength) throw new Error('CBOR float is truncated.');
    const value = decodeHalfFloat(bytes.readUInt16BE(cursor.offset));
    cursor.offset += 2;
    return value;
  }
  if (additional === 26) {
    if (cursor.offset + 4 > bytes.byteLength) throw new Error('CBOR float is truncated.');
    const value = bytes.readFloatBE(cursor.offset);
    cursor.offset += 4;
    return value;
  }
  if (additional === 27) {
    if (cursor.offset + 8 > bytes.byteLength) throw new Error('CBOR float is truncated.');
    const value = bytes.readDoubleBE(cursor.offset);
    cursor.offset += 8;
    return value;
  }
  throw new Error('Unsupported CBOR simple value.');
}

function decodeCbor(bytes: Buffer): unknown {
  const cursor = { offset: 0, decodedNodes: 0 };
  return decodeCborValue(bytes, cursor, 0);
}

function boxBounds(
  bytes: Buffer,
  start: number,
): { payloadStart: number; end: number; type: string } | null {
  if (start < 0 || start + 8 > bytes.byteLength) return null;
  const size = bytes.readUInt32BE(start);
  if (size < 8 || start + size > bytes.byteLength) return null;
  return {
    payloadStart: start + 8,
    end: start + size,
    type: bytes.toString('ascii', start + 4, start + 8),
  };
}

function jumbLabel(bytes: Buffer, payloadStart: number, end: number): string | null {
  if (end - payloadStart < 17) return null;
  const labelStart = payloadStart + 17;
  const labelEnd = bytes.indexOf(0, labelStart);
  if (labelEnd < labelStart || labelEnd > end) return null;
  return bytes.toString('utf8', labelStart, labelEnd);
}

function assertionFromJumb(bytes: Buffer, start: number): C2paAssertionParseResult {
  const outer = boxBounds(bytes, start);
  if (!outer || outer.type !== 'jumb') return { partial: false };
  let label: string | null = null;
  let value: unknown;
  let decodeFailed = false;
  let malformedChild = false;
  let cursor = outer.payloadStart;
  while (cursor + 8 <= outer.end) {
    const child = boxBounds(bytes, cursor);
    if (!child || child.end > outer.end) {
      malformedChild = true;
      break;
    }
    if (child.type === 'jumd') label = jumbLabel(bytes, child.payloadStart, child.end);
    else if (child.type === 'cbor') {
      try {
        value = decodeCbor(bytes.subarray(child.payloadStart, child.end));
      } catch {
        decodeFailed = true;
        value = undefined;
      }
    }
    cursor = child.end;
  }
  if (!label?.startsWith('c2pa.')) return { partial: false };
  if (value === undefined) return { partial: decodeFailed || malformedChild || cursor < outer.end };
  return { assertion: { label, value }, partial: malformedChild || cursor < outer.end };
}

function findC2paAssertions(bytes: Buffer): {
  assertions: C2paAssertion[];
  partial: boolean;
} {
  const assertions: C2paAssertion[] = [];
  let partial = false;
  const seen = new Set<number>();
  let searchFrom = 4;
  while (searchFrom < bytes.byteLength - 4) {
    const typeOffset = bytes.indexOf(JUMB_TYPE, searchFrom);
    if (typeOffset < 4) break;
    const start = typeOffset - 4;
    if (!seen.has(start)) {
      seen.add(start);
      const parsed = assertionFromJumb(bytes, start);
      partial ||= parsed.partial;
      if (parsed.assertion) {
        assertions.push(parsed.assertion);
        if (assertions.length >= MAX_C2PA_ASSERTIONS) break;
      }
    }
    searchFrom = typeOffset + 4;
  }
  return { assertions, partial };
}

function scalarMetadataItem(
  path: string,
  value: unknown,
  occurrence: number,
): AssetMetadataInspectionItem | null {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
    return null;
  return {
    id: `C2PA/${encodeURIComponent(path)}/${occurrence}`,
    key: path,
    value,
    valueKind:
      typeof value === 'string' ? 'text' : typeof value === 'number' ? 'number' : 'boolean',
  };
}

function flattenC2paValue(
  value: unknown,
  path: string,
  items: AssetMetadataInspectionItem[],
): void {
  if (items.length >= MAX_C2PA_METADATA_ITEMS - 1) {
    if (!items.some((metadataItem) => metadataItem.id === 'C2PA/aggregate-limit')) {
      items.push({
        id: 'C2PA/aggregate-limit',
        key: 'AdditionalMetadata',
        value: '',
        valueKind: 'limited',
        limitReason: 'aggregate-limit',
      });
    }
    return;
  }
  const scalar = scalarMetadataItem(path, value, items.length);
  if (scalar) {
    items.push(scalar);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => flattenC2paValue(entry, `${path}[${index}]`, items));
    return;
  }
  if (Buffer.isBuffer(value)) {
    items.push({
      id: `C2PA/${encodeURIComponent(path)}/${items.length}`,
      key: path,
      value: '',
      valueKind: 'binary',
      byteSize: value.byteLength,
    });
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    flattenC2paValue(entry, childPath, items);
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !Buffer.isBuffer(value)
    ? (value as Record<string, unknown>)
    : null;
}

function knownEntity(key: ProvenanceEntityKey, label?: string): AssetProvenanceEntity {
  const registered = PROVENANCE_ENTITY_REGISTRY[key];
  return { id: registered.id, label: label ?? registered.label };
}

function recognizeOpenAi(
  claim: Record<string, unknown>,
  actions: Record<string, unknown>,
): AssetProvenanceStage[] {
  const generator = objectValue(claim.claim_generator_info);
  if (generator?.name !== 'OpenAI Media Service API') return [];
  const actionList = Array.isArray(actions.actions) ? actions.actions : [];
  for (const [index, candidate] of actionList.entries()) {
    const action = objectValue(candidate);
    const softwareAgent = objectValue(action?.softwareAgent);
    if (action?.action !== 'c2pa.created' || softwareAgent?.name !== 'gpt-image') continue;
    const version = typeof softwareAgent.version === 'string' ? softwareAgent.version : undefined;
    return [
      {
        id: `openai-created-${index}`,
        role: 'generated',
        provider: knownEntity('openai'),
        model: knownEntity('openaiGptImage', version ? `gpt-image ${version}` : undefined),
      },
    ];
  }
  return [];
}

function recognizeGoogle(
  claim: Record<string, unknown>,
  actions: Record<string, unknown>,
): AssetProvenanceStage[] {
  const generator = objectValue(claim.claim_generator_info);
  if (generator?.name !== 'Google C2PA Core Generator Library') return [];
  const actionList = Array.isArray(actions.actions) ? actions.actions : [];
  const stages: AssetProvenanceStage[] = [];
  for (const [index, candidate] of actionList.entries()) {
    const action = objectValue(candidate);
    if (
      action?.action === 'c2pa.created' &&
      action.description === 'Created by Google Generative AI.'
    ) {
      stages.push({
        id: `google-created-${index}`,
        role: 'generated',
        provider: knownEntity('google'),
        tool: knownEntity('googleGenerativeAi'),
        description: action.description,
      });
    } else if (
      action?.action === 'c2pa.edited' &&
      typeof action.description === 'string' &&
      action.description.includes('SynthID watermark')
    ) {
      stages.push({
        id: `google-synthid-${index}`,
        role: 'edited',
        provider: knownEntity('google'),
        tool: knownEntity('googleSynthId'),
        description: action.description,
      });
    }
  }
  return stages;
}

function recognizedProvenance(assertions: C2paAssertion[]): AssetRecognizedProvenance | undefined {
  const claim = assertions.find((assertion) => assertion.label === 'c2pa.claim.v2');
  const actions = assertions.find((assertion) => assertion.label === 'c2pa.actions.v2');
  const claimObject = objectValue(claim?.value);
  const actionsObject = objectValue(actions?.value);
  if (!claimObject || !actionsObject) return undefined;
  const stages = [
    ...recognizeOpenAi(claimObject, actionsObject),
    ...recognizeGoogle(claimObject, actionsObject),
  ];
  return stages.length > 0 ? { stages } : undefined;
}

export function inspectC2paMetadata(bytes: Buffer): C2paInspection {
  const { assertions, partial } = findC2paAssertions(bytes);
  if (assertions.length === 0) return partial ? { warnings: ['partial-decode'] } : {};
  const items: AssetMetadataInspectionItem[] = assertions.map((assertion, index) => ({
    id: `C2PA/jumbf-label/${index}`,
    key: `jumbf[${index}].label`,
    value: assertion.label,
    valueKind: 'text',
  }));
  for (const assertion of assertions) flattenC2paValue(assertion.value, '', items);
  const group = { id: 'C2PA', namespace: 'C2PA', items };
  const provenance = recognizedProvenance(assertions);
  return {
    group,
    c2pa: { trust: 'unverified' },
    ...(provenance ? { provenance } : {}),
    ...(partial ? { warnings: ['partial-decode'] } : {}),
  };
}
