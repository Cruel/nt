import { createReadStream, createWriteStream } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw, createGzip } from 'node:zlib';

export type PlatformArchiveCompression = 'store' | 'default' | 'maximum';

export interface PlatformArchiveEntry {
  sourcePath: string;
  archivePath: string;
  size: number;
  mode: number;
}

function normalizedArchivePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid archive path '${value}'.`);
  }
  return normalized;
}

function compressionLevel(value: PlatformArchiveCompression): number {
  return value === 'store' ? 0 : value === 'maximum' ? 9 : 6;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1)
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function updateCrc32(crc: number, data: Buffer): number {
  let next = crc;
  for (const byte of data) next = crcTable[(next ^ byte) & 0xff]! ^ (next >>> 8);
  return next >>> 0;
}

function finishCrc32(crc: number): number {
  return (crc ^ 0xffffffff) >>> 0;
}

function zipLocalHeader(name: Buffer, method: number): Buffer {
  const output = Buffer.alloc(30 + name.length);
  output.writeUInt32LE(0x04034b50, 0);
  output.writeUInt16LE(20, 4);
  output.writeUInt16LE(0x0808, 6);
  output.writeUInt16LE(method, 8);
  output.writeUInt16LE(0, 10);
  output.writeUInt16LE(33, 12);
  output.writeUInt32LE(0, 14);
  output.writeUInt32LE(0, 18);
  output.writeUInt32LE(0, 22);
  output.writeUInt16LE(name.length, 26);
  output.writeUInt16LE(0, 28);
  name.copy(output, 30);
  return output;
}

function zipDataDescriptor(crc: number, compressedSize: number, size: number): Buffer {
  const output = Buffer.alloc(16);
  output.writeUInt32LE(0x08074b50, 0);
  output.writeUInt32LE(crc, 4);
  output.writeUInt32LE(compressedSize, 8);
  output.writeUInt32LE(size, 12);
  return output;
}

function zipCentralHeader(
  name: Buffer,
  method: number,
  crc: number,
  compressedSize: number,
  size: number,
  mode: number,
  offset: number,
): Buffer {
  const output = Buffer.alloc(46 + name.length);
  output.writeUInt32LE(0x02014b50, 0);
  output.writeUInt16LE(0x0314, 4);
  output.writeUInt16LE(20, 6);
  output.writeUInt16LE(0x0808, 8);
  output.writeUInt16LE(method, 10);
  output.writeUInt16LE(0, 12);
  output.writeUInt16LE(33, 14);
  output.writeUInt32LE(crc, 16);
  output.writeUInt32LE(compressedSize, 20);
  output.writeUInt32LE(size, 24);
  output.writeUInt16LE(name.length, 28);
  output.writeUInt16LE(0, 30);
  output.writeUInt16LE(0, 32);
  output.writeUInt16LE(0, 34);
  output.writeUInt16LE(0, 36);
  output.writeUInt32LE(((0o100000 | (mode & 0o777)) * 0x10000) >>> 0, 38);
  output.writeUInt32LE(offset, 42);
  name.copy(output, 46);
  return output;
}

async function writeAt(file: FileHandle, data: Buffer, offset: number): Promise<number> {
  let written = 0;
  while (written < data.length) {
    const result = await file.write(data, written, data.length - written, offset + written);
    if (result.bytesWritten === 0) throw new Error('Archive output stopped accepting data.');
    written += result.bytesWritten;
  }
  return offset + written;
}

async function streamZipEntry(
  file: FileHandle,
  entry: PlatformArchiveEntry,
  method: number,
  compression: PlatformArchiveCompression,
  startOffset: number,
): Promise<{ crc: number; size: number; compressedSize: number; offset: number }> {
  let crc = 0xffffffff;
  let size = 0;
  let compressedSize = 0;
  let offset = startOffset;
  const checksum = new Transform({
    transform(chunk, _encoding, callback) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      crc = updateCrc32(crc, data);
      size += data.length;
      if (size > 0xffffffff) {
        callback(new Error('ZIP64 output is not supported by the platform exporter.'));
        return;
      }
      callback(null, data);
    },
  });
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      compressedSize += data.length;
      if (compressedSize > 0xffffffff || offset + data.length > 0xffffffff) {
        callback(new Error('ZIP64 output is not supported by the platform exporter.'));
        return;
      }
      void writeAt(file, data, offset).then(
        (nextOffset) => {
          offset = nextOffset;
          callback();
        },
        (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
      );
    },
  });
  if (method === 0) await pipeline(createReadStream(entry.sourcePath), checksum, sink);
  else
    await pipeline(
      createReadStream(entry.sourcePath),
      checksum,
      createDeflateRaw({ level: compressionLevel(compression) }),
      sink,
    );
  if (size !== entry.size)
    throw new Error(`Archive input '${entry.sourcePath}' changed while packaging.`);
  return { crc: finishCrc32(crc), size, compressedSize, offset };
}

export async function createZipArchive(
  outputPath: string,
  entries: readonly PlatformArchiveEntry[],
  compression: PlatformArchiveCompression,
): Promise<void> {
  if (entries.length > 0xffff) throw new Error('ZIP archive contains too many entries.');
  const file = await open(outputPath, 'w');
  const central: Buffer[] = [];
  let offset = 0;
  try {
    for (const entry of [...entries].sort((a, b) => a.archivePath.localeCompare(b.archivePath))) {
      if (entry.size > 0xffffffff)
        throw new Error('ZIP64 output is not supported by the platform exporter.');
      const archivePath = normalizedArchivePath(entry.archivePath);
      const name = Buffer.from(archivePath, 'utf8');
      if (name.length > 0xffff) throw new Error(`ZIP path '${archivePath}' is too long.`);
      if (offset > 0xffffffff)
        throw new Error('ZIP64 output is not supported by the platform exporter.');
      const method = compression === 'store' ? 0 : 8;
      const entryOffset = offset;
      const local = zipLocalHeader(name, method);
      offset = await writeAt(file, local, offset);
      const streamed = await streamZipEntry(file, entry, method, compression, offset);
      offset = streamed.offset;
      const descriptor = zipDataDescriptor(streamed.crc, streamed.compressedSize, streamed.size);
      if (offset + descriptor.length > 0xffffffff)
        throw new Error('ZIP64 output is not supported by the platform exporter.');
      offset = await writeAt(file, descriptor, offset);
      central.push(
        zipCentralHeader(
          name,
          method,
          streamed.crc,
          streamed.compressedSize,
          streamed.size,
          entry.mode,
          entryOffset,
        ),
      );
    }
    const centralOffset = offset;
    for (const header of central) offset = await writeAt(file, header, offset);
    const centralSize = offset - centralOffset;
    if (centralOffset > 0xffffffff || centralSize > 0xffffffff)
      throw new Error('ZIP64 output is not supported by the platform exporter.');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralOffset, 16);
    end.writeUInt16LE(0, 20);
    await writeAt(file, end, offset);
  } finally {
    await file.close();
  }
}

function writeTarOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const octal = Math.floor(value).toString(8);
  if (octal.length > length - 1) throw new Error(`Tar numeric value '${value}' does not fit.`);
  buffer.write(`${octal.padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

function splitUstarPath(value: string): { name: string; prefix: string } | null {
  const bytes = Buffer.byteLength(value);
  if (bytes <= 100) return { name: value, prefix: '' };
  for (let slash = value.lastIndexOf('/'); slash > 0; slash = value.lastIndexOf('/', slash - 1)) {
    const prefix = value.slice(0, slash);
    const name = value.slice(slash + 1);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix };
  }
  return null;
}

function tarHeader(archivePath: string, size: number, mode: number, type: '0' | 'x' = '0'): Buffer {
  const output = Buffer.alloc(512);
  const split = splitUstarPath(archivePath);
  if (!split) throw new Error(`Tar path '${archivePath}' requires a PAX path header.`);
  output.write(split.name, 0, 100, 'utf8');
  writeTarOctal(output, 100, 8, mode & 0o777);
  writeTarOctal(output, 108, 8, 0);
  writeTarOctal(output, 116, 8, 0);
  writeTarOctal(output, 124, 12, size);
  writeTarOctal(output, 136, 12, 0);
  output.fill(0x20, 148, 156);
  output.write(type, 156, 1, 'ascii');
  output.write('ustar\0', 257, 6, 'ascii');
  output.write('00', 263, 2, 'ascii');
  if (split.prefix) output.write(split.prefix, 345, 155, 'utf8');
  let checksum = 0;
  for (const byte of output) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, '0');
  output.write(`${checksumText}\0 `, 148, 8, 'ascii');
  return output;
}

function paxRecord(key: string, value: string): Buffer {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 3;
  while (true) {
    const text = `${length} ${body}`;
    const actual = Buffer.byteLength(text);
    if (actual === length) return Buffer.from(text, 'utf8');
    length = actual;
  }
}

function paddedLength(size: number): number {
  return (512 - (size % 512)) % 512;
}

async function* tarChunks(entries: readonly PlatformArchiveEntry[]) {
  let paxIndex = 0;
  for (const entry of [...entries].sort((a, b) => a.archivePath.localeCompare(b.archivePath))) {
    const archivePath = normalizedArchivePath(entry.archivePath);
    let headerPath = archivePath;
    if (!splitUstarPath(archivePath)) {
      const pax = paxRecord('path', archivePath);
      const paxPath = `PaxHeaders.NovelTea/${String(paxIndex).padStart(8, '0')}`;
      paxIndex += 1;
      yield tarHeader(paxPath, pax.length, 0o644, 'x');
      yield pax;
      const paxPadding = paddedLength(pax.length);
      if (paxPadding) yield Buffer.alloc(paxPadding);
      headerPath = path.posix.basename(archivePath).slice(0, 100) || `entry-${paxIndex}`;
    }
    yield tarHeader(headerPath, entry.size, entry.mode);
    let actualSize = 0;
    for await (const chunk of createReadStream(entry.sourcePath)) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      actualSize += data.length;
      yield data;
    }
    if (actualSize !== entry.size)
      throw new Error(`Archive input '${entry.sourcePath}' changed while packaging.`);
    const padding = paddedLength(actualSize);
    if (padding) yield Buffer.alloc(padding);
  }
  yield Buffer.alloc(1024);
}

export async function createTarGzArchive(
  outputPath: string,
  entries: readonly PlatformArchiveEntry[],
  compression: PlatformArchiveCompression,
): Promise<void> {
  await pipeline(
    Readable.from(tarChunks(entries)),
    createGzip({ level: compressionLevel(compression) }),
    createWriteStream(outputPath),
  );
}
