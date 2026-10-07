import sharp from 'sharp';
import type { PreparedRasterAnimation } from './raster-animation-import';
import { checkRasterImportSize } from './raster-import-limits';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const name = Buffer.from(type);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), result.length - 4);
  return result;
}
interface Frame {
  width: number;
  height: number;
  x: number;
  y: number;
  delay: number;
  dispose: number;
  blend: number;
  data: Buffer[];
}

// libvips treats APNG as a still PNG. Rebuild each PNG subframe, then coalesce on the logical canvas.
export async function prepareApng(
  bytes: Buffer,
  fallbackDuration: number,
): Promise<PreparedRasterAnimation | null> {
  if (!bytes.subarray(0, 8).equals(signature)) return null;
  const frames: Frame[] = [];
  const shared: Buffer[] = [];
  let header: Buffer | undefined;
  let expectedFrames = 0;
  let sequence = 0;
  let sawImageData = false;
  let ended = false;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error('Truncated PNG chunk.');
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length) throw new Error('Truncated PNG chunk data.');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, end - 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4))
      throw new Error('Invalid PNG checksum.');
    if (type === 'IHDR') {
      if (header || offset !== 8 || length !== 13) throw new Error('Invalid PNG header.');
      header = Buffer.from(data);
    } else if (type === 'acTL') {
      if (!header || expectedFrames || sawImageData || length !== 8)
        throw new Error('Invalid APNG animation control.');
      expectedFrames = data.readUInt32BE(0);
      checkRasterImportSize(header.readUInt32BE(0), header.readUInt32BE(4), expectedFrames);
    } else if (type === 'fcTL') {
      if (!header || !expectedFrames || length !== 26 || data.readUInt32BE(0) !== sequence++)
        throw new Error('Invalid APNG frame control.');
      const frame: Frame = {
        width: data.readUInt32BE(4),
        height: data.readUInt32BE(8),
        x: data.readUInt32BE(12),
        y: data.readUInt32BE(16),
        delay: (data.readUInt16BE(20) * 1000) / (data.readUInt16BE(22) || 100),
        dispose: data[24]!,
        blend: data[25]!,
        data: [],
      };
      if (
        !frame.width ||
        !frame.height ||
        frame.x + frame.width > header.readUInt32BE(0) ||
        frame.y + frame.height > header.readUInt32BE(4) ||
        frame.dispose > 2 ||
        frame.blend > 1 ||
        frames.length >= expectedFrames
      )
        throw new Error('Invalid APNG frame bounds or operation.');
      if (
        !sawImageData &&
        (frame.x ||
          frame.y ||
          frame.width !== header.readUInt32BE(0) ||
          frame.height !== header.readUInt32BE(4))
      )
        throw new Error('APNG default frame must cover the canvas.');
      frames.push(frame);
    } else if (type === 'IDAT') {
      sawImageData = true;
      if (frames.length > 1) throw new Error('Unexpected APNG default image data.');
      frames[0]?.data.push(data);
    } else if (type === 'fdAT') {
      sawImageData = true;
      if (!frames.length || length < 4 || data.readUInt32BE(0) !== sequence++)
        throw new Error('Invalid APNG frame data.');
      frames.at(-1)!.data.push(data.subarray(4));
    } else if (type === 'IEND') {
      if (length !== 0 || end !== bytes.length) throw new Error('Invalid PNG end.');
      ended = true;
    } else if (!sawImageData && type !== 'acTL') {
      shared.push(bytes.subarray(offset, end));
    }
    offset = end;
  }
  if (!expectedFrames) return null;
  if (!ended || frames.length !== expectedFrames || frames.some((frame) => !frame.data.length))
    throw new Error('Incomplete APNG animation.');
  const width = header!.readUInt32BE(0),
    height = header!.readUInt32BE(4);
  let canvas = Buffer.alloc(width * height * 4);
  const output: PreparedRasterAnimation['frames'] = [];
  let sourceTime = 0,
    canonicalTime = 0;
  for (const frame of frames) {
    const previous = frame.dispose === 2 ? Buffer.from(canvas) : null;
    const frameHeader = Buffer.from(header!);
    frameHeader.writeUInt32BE(frame.width);
    frameHeader.writeUInt32BE(frame.height, 4);
    const png = Buffer.concat([
      signature,
      chunk('IHDR', frameHeader),
      ...shared,
      ...frame.data.map((data) => chunk('IDAT', data)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const pixels = await sharp(png, { failOn: 'error' })
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer();
    for (let y = 0; y < frame.height; y++)
      for (let x = 0; x < frame.width; x++) {
        const source = (y * frame.width + x) * 4;
        const target = ((y + frame.y) * width + x + frame.x) * 4;
        if (frame.blend === 0) pixels.copy(canvas, target, source, source + 4);
        else {
          const alpha = pixels[source + 3]! / 255;
          const backgroundAlpha = (canvas[target + 3]! / 255) * (1 - alpha);
          const combined = alpha + backgroundAlpha;
          for (let channel = 0; channel < 3; channel++)
            canvas[target + channel] = combined
              ? Math.round(
                  (pixels[source + channel]! * alpha +
                    canvas[target + channel]! * backgroundAlpha) /
                    combined,
                )
              : 0;
          canvas[target + 3] = Math.round(combined * 255);
        }
      }
    sourceTime += frame.delay || fallbackDuration;
    const durationMs = Math.max(1, Math.round(sourceTime) - canonicalTime);
    canonicalTime += durationMs;
    output.push({
      png: await sharp(canvas, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer(),
      durationMs,
    });
    if (previous) canvas = previous;
    else if (frame.dispose === 1)
      for (let y = 0; y < frame.height; y++)
        canvas.fill(
          0,
          ((y + frame.y) * width + frame.x) * 4,
          ((y + frame.y) * width + frame.x + frame.width) * 4,
        );
  }
  return { format: 'apng', canvas: { width, height }, frames: output };
}
