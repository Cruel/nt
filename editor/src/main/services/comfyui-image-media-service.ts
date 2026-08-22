import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ComfyUiConfig } from '../../shared/comfyui';
import { normalizeComfyUiServerUrl } from '../../shared/comfyui';
import { inspectImage } from './image-inspection-service';
import { ComfyUiRunError } from './comfyui-run-errors';

const MAX_IMAGE_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_UPLOAD_RESPONSE_BYTES = 1024 * 1024;

export interface PreparedComfyUiImageInput {
  id: string;
  sourcePath: string;
  bytes: Uint8Array;
  extension: string;
  mimeType: string;
}

function detectedImageInputMedia(bytes: Uint8Array) {
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return { extension: '.png', mimeType: 'image/png' };
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { extension: '.jpg', mimeType: 'image/jpeg' };
  if (
    bytes.byteLength >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  )
    return { extension: '.webp', mimeType: 'image/webp' };
  if (
    bytes.byteLength >= 6 &&
    (String.fromCharCode(...bytes.slice(0, 6)) === 'GIF89a' ||
      String.fromCharCode(...bytes.slice(0, 6)) === 'GIF87a')
  )
    return { extension: '.gif', mimeType: 'image/gif' };
  throw new ComfyUiRunError(
    'COMFYUI_INPUT_IMAGE_FORMAT',
    '/inputs',
    'Image input format must be PNG, JPEG, WebP, or GIF.',
  );
}

export async function prepareComfyUiImageInput(
  id: string,
  sourceValue: string,
  cwd: string,
): Promise<PreparedComfyUiImageInput> {
  const sourcePath = path.resolve(cwd, sourceValue);
  let metadata;
  try {
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile())
      throw new ComfyUiRunError(
        'COMFYUI_INPUT_IMAGE_INVALID',
        `/inputs/${id}`,
        `Image input '${id}' must name a readable file.`,
      );
    if (stat.size > MAX_IMAGE_INPUT_BYTES)
      throw new ComfyUiRunError(
        'COMFYUI_INPUT_IMAGE_TOO_LARGE',
        `/inputs/${id}`,
        `Image input '${id}' exceeds the 32 MiB limit.`,
      );
    const inspection = inspectImage(sourcePath);
    if (!inspection)
      throw new ComfyUiRunError(
        'COMFYUI_IMAGE_INSPECTION_UNAVAILABLE',
        `/inputs/${id}`,
        'Native image inspection is unavailable in this CLI host.',
      );
    metadata = await inspection;
  } catch (error) {
    if (error instanceof ComfyUiRunError) throw error;
    throw new ComfyUiRunError(
      'COMFYUI_INPUT_IMAGE_INVALID',
      `/inputs/${id}`,
      `Image input '${id}' could not be read or decoded.`,
    );
  }
  if (!metadata.width || !metadata.height)
    throw new ComfyUiRunError(
      'COMFYUI_INPUT_IMAGE_INVALID',
      `/inputs/${id}`,
      `Image input '${id}' could not be decoded.`,
    );
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(sourcePath);
  } catch {
    throw new ComfyUiRunError(
      'COMFYUI_INPUT_IMAGE_INVALID',
      `/inputs/${id}`,
      `Image input '${id}' could not be read.`,
    );
  }
  if (bytes.byteLength > MAX_IMAGE_INPUT_BYTES)
    throw new ComfyUiRunError(
      'COMFYUI_INPUT_IMAGE_TOO_LARGE',
      `/inputs/${id}`,
      `Image input '${id}' exceeds the 32 MiB limit.`,
    );
  return { id, sourcePath, bytes, ...detectedImageInputMedia(bytes) };
}

export function validateComfyUiImageUploadTarget(config: ComfyUiConfig): URL {
  let url: URL;
  try {
    url = new URL(normalizeComfyUiServerUrl(config.serverUrl));
  } catch {
    throw new ComfyUiRunError(
      'COMFYUI_UPLOAD_TARGET_DENIED',
      '/server',
      'Local image upload requires a valid loopback HTTP server URL.',
    );
  }
  if (url.protocol !== 'http:' || url.username || url.password)
    throw new ComfyUiRunError(
      'COMFYUI_UPLOAD_TARGET_DENIED',
      '/server',
      'Local image upload requires plain HTTP without credentials.',
    );
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const ipv4 = hostname.split('.');
  const ipv4Loopback =
    ipv4.length === 4 &&
    ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255) &&
    Number(ipv4[0]) === 127;
  const ipv6Loopback = hostname === '::1' || hostname === '0:0:0:0:0:0:0:1';
  const mappedMatch = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  const mappedLoopback = mappedMatch
    ? ((Number.parseInt(mappedMatch[1]!, 16) << 16) | Number.parseInt(mappedMatch[2]!, 16)) >>>
        24 ===
      127
    : false;
  if (!ipv4Loopback && !ipv6Loopback && !mappedLoopback)
    throw new ComfyUiRunError(
      'COMFYUI_UPLOAD_TARGET_DENIED',
      '/server',
      'Local image upload is allowed only to a literal loopback IP address.',
    );
  return url;
}

function concatBytes(parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

async function readBoundedResponse(response: Response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_RESPONSE_BYTES)
    throw new ComfyUiRunError(
      'COMFYUI_UPLOAD_FAILED',
      '/server',
      'ComfyUI image upload response exceeded the allowed size.',
    );
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_UPLOAD_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ComfyUiRunError(
        'COMFYUI_UPLOAD_FAILED',
        '/server',
        'ComfyUI image upload response exceeded the allowed size.',
      );
    }
    chunks.push(next.value);
  }
  return concatBytes(chunks);
}

export async function uploadComfyUiImageInput(
  config: ComfyUiConfig,
  input: PreparedComfyUiImageInput,
): Promise<string> {
  const base = validateComfyUiImageUploadTarget(config);
  const boundary = `----noveltea-${randomUUID()}`;
  const remoteName = `noveltea-${randomUUID()}${input.extension}`;
  const encode = (value: string) => new TextEncoder().encode(value);
  const body = concatBytes([
    encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${remoteName}"\r\nContent-Type: ${input.mimeType}\r\n\r\n`,
    ),
    input.bytes,
    encode(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\nfalse\r\n--${boundary}--\r\n`,
    ),
  ]);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(new URL('/upload/image', base), {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
      signal: controller.signal,
    });
    const responseBytes = await readBoundedResponse(response);
    if (!response.ok)
      throw new ComfyUiRunError(
        'COMFYUI_UPLOAD_FAILED',
        `/inputs/${input.id}`,
        `ComfyUI image upload for '${input.id}' failed with HTTP ${response.status}.`,
      );
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(responseBytes));
    } catch {
      throw new ComfyUiRunError(
        'COMFYUI_UPLOAD_FAILED',
        `/inputs/${input.id}`,
        `ComfyUI image upload for '${input.id}' returned invalid JSON.`,
      );
    }
    if (!value || typeof value !== 'object')
      throw new ComfyUiRunError(
        'COMFYUI_UPLOAD_FAILED',
        `/inputs/${input.id}`,
        `ComfyUI image upload for '${input.id}' returned an invalid response.`,
      );
    const record = value as { name?: unknown; subfolder?: unknown };
    if (typeof record.name !== 'string' || !record.name)
      throw new ComfyUiRunError(
        'COMFYUI_UPLOAD_FAILED',
        `/inputs/${input.id}`,
        `ComfyUI image upload for '${input.id}' did not return a file reference.`,
      );
    const subfolder = typeof record.subfolder === 'string' ? record.subfolder : '';
    return subfolder ? `${subfolder}/${record.name}` : record.name;
  } catch (error) {
    if (error instanceof ComfyUiRunError) throw error;
    if (error instanceof Error && error.name === 'AbortError')
      throw new ComfyUiRunError(
        'COMFYUI_REQUEST_TIMEOUT',
        `/inputs/${input.id}`,
        `ComfyUI image upload for '${input.id}' timed out.`,
      );
    throw new ComfyUiRunError(
      'COMFYUI_UPLOAD_FAILED',
      `/inputs/${input.id}`,
      `ComfyUI image upload for '${input.id}' failed.`,
    );
  } finally {
    clearTimeout(timeout);
  }
}
