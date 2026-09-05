import { describe, expect, it } from 'vite-plus/test';
import { inspectExifMetadata } from '../../main/services/exif-metadata-inspection';

function repeatedExif(type: number, count: number, entries: number) {
  const dataOffset = 14 + entries * 12;
  const bytes = Buffer.alloc(dataOffset + count, type === 2 ? 65 : 255);
  bytes.write('II');
  bytes.writeUInt16LE(42, 2);
  bytes.writeUInt32LE(8, 4);
  bytes.writeUInt16LE(entries, 8);
  for (let index = 0; index < entries; index += 1) {
    const offset = 10 + index * 12;
    bytes.writeUInt16LE(0xc000 + index, offset);
    bytes.writeUInt16LE(type, offset + 2);
    bytes.writeUInt32LE(count, offset + 4);
    bytes.writeUInt32LE(dataOffset, offset + 8);
  }
  bytes.writeUInt32LE(0, 10 + entries * 12);
  return bytes;
}

describe('EXIF decoding budgets', () => {
  it('bounds numeric arrays before allocating their decoded representation', () => {
    const result = inspectExifMetadata(repeatedExif(1, 3 * 1024 * 1024, 1));
    expect(result.group?.items[0]).toMatchObject({
      valueKind: 'limited',
      limitReason: 'value-too-large',
      byteSize: 3 * 1024 * 1024,
    });
  });

  it.each([1, 2])(
    'shares a decoding budget across repeated payload references (type %s)',
    (type) => {
      const result = inspectExifMetadata(repeatedExif(type, 128 * 1024, 160));
      expect(result.group?.items).toHaveLength(160);
      expect(result.group?.items[0]?.valueKind).not.toBe('limited');
      expect(result.group?.items.at(-1)).toMatchObject({
        valueKind: 'limited',
        limitReason: 'aggregate-limit',
      });
      expect(result.warnings).toContain('aggregate-limit-reached');
      const decodedBytes = result.group!.items.reduce(
        (sum, item) => sum + Buffer.byteLength(String(item.value)),
        0,
      );
      expect(decodedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    },
  );
});
