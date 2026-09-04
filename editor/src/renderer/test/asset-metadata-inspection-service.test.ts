import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
import { AssetMetadataInspectionService } from '../../main/services/asset-metadata-inspection-service';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

const roots: string[] = [];
const basePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const baseJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=',
  'base64',
);

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngTextChunk(keyword: string, value: string): Buffer {
  const type = Buffer.from('tEXt', 'ascii');
  const data = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0]),
    Buffer.from(value),
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}

function withPngText(keyword: string, value: string, source: Buffer = basePng): Buffer {
  const iendOffset = source.lastIndexOf(Buffer.from('IEND', 'ascii')) - 4;
  return Buffer.concat([
    source.subarray(0, iendOffset),
    pngTextChunk(keyword, value),
    source.subarray(iendOffset),
  ]);
}

function withJpegComment(value: string): Buffer {
  const payload = Buffer.from(value, 'latin1');
  const segment = Buffer.alloc(4 + payload.byteLength);
  segment[0] = 0xff;
  segment[1] = 0xfe;
  segment.writeUInt16BE(payload.byteLength + 2, 2);
  payload.copy(segment, 4);
  return Buffer.concat([baseJpeg.subarray(0, 2), segment, baseJpeg.subarray(2)]);
}

function digest(bytes: Buffer) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function tempProject(bytes: Buffer) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-metadata-inspection-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'project.json'), '{}');
  fs.mkdirSync(path.join(root, 'assets', 'images'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'images', 'generated.png'), bytes);
  const project = createAuthoringProject();
  project.assets.generated = {
    id: 'generated',
    label: 'Generated',
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/images/generated.png' },
      aliases: [],
      byteSize: bytes.byteLength,
      contentHash: digest(bytes),
      imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
    },
  };
  return { root, project, projectFilePath: path.join(root, 'project.json') };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Project Asset embedded metadata inspection', () => {
  it('returns grouped structural and textual PNG metadata from admitted bytes', async () => {
    const prompt = JSON.stringify({ prompt: 'Moonlit room' });
    const bytes = withPngText('ImageWidth', 'authored text', withPngText('prompt', prompt));
    const fixture = tempProject(bytes);
    const sessions = new ActiveProjectSessionService();
    const sessionId = await sessions.activateProjectFile(
      fixture.projectFilePath,
      undefined,
      fixture.project,
    );
    const service = new AssetMetadataInspectionService(sessions);

    const result = await service.inspect(sessionId, 'generated');

    expect(result).toMatchObject({
      ok: true,
      status: 'ready',
      kind: 'image',
      contentHash: digest(bytes),
    });
    if (!result.ok || result.status !== 'ready') throw new Error('Expected ready metadata.');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.namespace).toBe('PNG');
    expect(result.groups[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'ImageWidth', value: 1, valueKind: 'number' }),
        expect.objectContaining({ key: 'ImageWidth', value: 'authored text', valueKind: 'text' }),
        expect.objectContaining({ key: 'ImageHeight', value: 1, valueKind: 'number' }),
        expect.objectContaining({ key: 'prompt', value: prompt, valueKind: 'json' }),
      ]),
    );
    const ids = result.groups[0]!.items.map((metadataItem) => metadataItem.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.groups[0]!.items.some((metadataItem) => metadataItem.key === 'Density')).toBe(
      false,
    );
  });

  it('returns JPEG structural metadata and exact comment tags', async () => {
    const comment = 'Generated by fixture';
    const bytes = withJpegComment(comment);
    const fixture = tempProject(bytes);
    const jpegPath = path.join(fixture.root, 'assets', 'images', 'generated.jpg');
    fs.renameSync(path.join(fixture.root, 'assets', 'images', 'generated.png'), jpegPath);
    fixture.project.assets.generated!.data = {
      ...fixture.project.assets.generated!.data,
      source: { type: 'project-file', path: 'assets/images/generated.jpg' },
      extension: '.jpg',
      mimeType: 'image/jpeg',
      byteSize: bytes.byteLength,
      contentHash: digest(bytes),
    };
    const sessions = new ActiveProjectSessionService();
    const sessionId = await sessions.activateProjectFile(
      fixture.projectFilePath,
      undefined,
      fixture.project,
    );
    const service = new AssetMetadataInspectionService(sessions);

    const result = await service.inspect(sessionId, 'generated');

    expect(result).toMatchObject({ ok: true, status: 'ready', kind: 'image' });
    if (!result.ok || result.status !== 'ready') throw new Error('Expected ready metadata.');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.namespace).toBe('JPEG');
    expect(result.groups[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'ImageWidth', value: 1, valueKind: 'number' }),
        expect.objectContaining({ key: 'ImageHeight', value: 1, valueKind: 'number' }),
        expect.objectContaining({ key: 'Comment', value: comment, valueKind: 'text' }),
      ]),
    );
  });

  it('fails closed for stale sessions, unknown Assets, changed bytes, and unsafe source paths', async () => {
    const bytes = withPngText('prompt', '{"prompt":"trusted"}');
    const fixture = tempProject(bytes);
    const sessions = new ActiveProjectSessionService();
    const sessionId = await sessions.activateProjectFile(
      fixture.projectFilePath,
      undefined,
      fixture.project,
    );
    const service = new AssetMetadataInspectionService(sessions);

    await expect(
      service.inspect('00000000-0000-4000-8000-000000000000', 'generated'),
    ).resolves.toMatchObject({
      ok: false,
      code: 'stale-or-unknown',
    });
    await expect(service.inspect(sessionId, 'missing')).resolves.toMatchObject({
      ok: false,
      code: 'unknown-asset',
    });

    const source = path.join(fixture.root, 'assets', 'images', 'generated.png');
    const changed = Buffer.from(bytes);
    changed[changed.byteLength - 1] ^= 1;
    fs.writeFileSync(source, changed);
    await expect(service.inspect(sessionId, 'generated')).resolves.toMatchObject({
      ok: false,
      code: 'revision-mismatch',
    });

    fs.writeFileSync(source, bytes);
    fixture.project.assets.generated!.data = {
      ...fixture.project.assets.generated!.data,
      source: { type: 'project-file', path: 'assets/images/../images/generated.png' },
    };
    await sessions.refreshActiveProject(sessionId, fixture.projectFilePath, fixture.project);
    await expect(service.inspect(sessionId, 'generated')).resolves.toMatchObject({
      ok: false,
      code: 'invalid-source',
    });
  });

  it('reports unsupported Asset kinds without inventing image metadata', async () => {
    const bytes = withPngText('prompt', '{"prompt":"image"}');
    const fixture = tempProject(bytes);
    fixture.project.assets.generated!.data = {
      ...fixture.project.assets.generated!.data,
      kind: 'audio',
      imageMetadata: null,
    };
    const sessions = new ActiveProjectSessionService();
    const sessionId = await sessions.activateProjectFile(
      fixture.projectFilePath,
      undefined,
      fixture.project,
    );
    const service = new AssetMetadataInspectionService(sessions);

    await expect(service.inspect(sessionId, 'generated')).resolves.toMatchObject({
      ok: true,
      status: 'unsupported',
      kind: 'audio',
      groups: [],
    });
  });

  it('returns new metadata after the active Asset content hash changes', async () => {
    const firstBytes = withPngText('prompt', '{"prompt":"first"}');
    const fixture = tempProject(firstBytes);
    const sessions = new ActiveProjectSessionService();
    const sessionId = await sessions.activateProjectFile(
      fixture.projectFilePath,
      undefined,
      fixture.project,
    );
    const service = new AssetMetadataInspectionService(sessions);

    const first = await service.inspect(sessionId, 'generated');
    expect(first).toMatchObject({ ok: true, status: 'ready', contentHash: digest(firstBytes) });

    const secondBytes = withPngText('prompt', '{"prompt":"second"}');
    fs.writeFileSync(path.join(fixture.root, 'assets', 'images', 'generated.png'), secondBytes);
    fixture.project.assets.generated!.data = {
      ...fixture.project.assets.generated!.data,
      byteSize: secondBytes.byteLength,
      contentHash: digest(secondBytes),
    };
    await sessions.refreshActiveProject(sessionId, fixture.projectFilePath, fixture.project);

    const second = await service.inspect(sessionId, 'generated');
    expect(second).toMatchObject({ ok: true, status: 'ready', contentHash: digest(secondBytes) });
    if (!second.ok || second.status !== 'ready') throw new Error('Expected ready metadata.');
    expect(second.groups[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'prompt', value: '{"prompt":"second"}' }),
      ]),
    );
  });
});
