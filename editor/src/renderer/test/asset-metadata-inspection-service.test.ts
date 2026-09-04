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

const OPENAI_C2PA_CLAIM = Buffer.from(
  'AAACump1bWIAAAAnanVtZGMyY2wAEQAQgAAAqgA4m3EDYzJwYS5jbGFpbS52MgAAAAKLY2JvcqZqaW5zdGFuY2VJRHgseG1wOmlpZDpiMzNhYjMwMS1jOWQ3LTRkODctYjM2MC1mNTczMDg5ZTA3ZGR0Y2xhaW1fZ2VuZXJhdG9yX2luZm+kZG5hbWV4GE9wZW5BSSBNZWRpYSBTZXJ2aWNlIEFQSWRpY29uomN1cmx4JHNlbGYjanVtYmY9YzJwYS5hc3NlcnRpb25zL2MycGEuaWNvbmRoYXNoWCAXdK+TpH6bIc2abhRzXYaUj02Hupiy8cxIV/k3fUUy63dvcmcuY29udGVudGF1dGguYzJwYV9yc2YwLjc5LjJrc3BlY1ZlcnNpb25lMi4yLjBpc2lnbmF0dXJleE1zZWxmI2p1bWJmPS9jMnBhL3VybjpjMnBhOjEzMjIwZjdhLWE5YzgtNDhhMC1iOGZiLTc5YjQzZjY5ZGIyZS9jMnBhLnNpZ25hdHVyZXJjcmVhdGVkX2Fzc2VydGlvbnODomN1cmx4JHNlbGYjanVtYmY9YzJwYS5hc3NlcnRpb25zL2MycGEuaWNvbmRoYXNoWCAXdK+TpH6bIc2abhRzXYaUj02Hupiy8cxIV/k3fUUy66JjdXJseCpzZWxmI2p1bWJmPWMycGEuYXNzZXJ0aW9ucy9jMnBhLmFjdGlvbnMudjJkaGFzaFggeAm8+0hqWSoTrPoz+flq3kO1D2+sLlU6fB3m+SLMbV+iY3VybHgpc2VsZiNqdW1iZj1jMnBhLmFzc2VydGlvbnMvYzJwYS5oYXNoLmRhdGFkaGFzaFgg6R+Gt0Y0Zv8RzKoy9g7LHRriNRHofa+cniXPEihXGH5oZGM6dGl0bGVpaW1hZ2UucG5nY2FsZ2ZzaGEyNTY=',
  'base64',
);
const OPENAI_C2PA_ACTIONS = Buffer.from(
  'AAABkmp1bWIAAABBanVtZGNib3IAEQAQgAAAqgA4m3ETYzJwYS5hY3Rpb25zLnYyAAAAABhjMnNozBtskqmFC0F0KmmRBH/fgAAAAUljYm9yomdhY3Rpb25zg6RmYWN0aW9ubGMycGEuY3JlYXRlZGR3aGVuwHQyMDI2LTA5LTA0VDAwOjAwOjAwWm1zb2Z0d2FyZUFnZW50omRuYW1laWdwdC1pbWFnZWd2ZXJzaW9uYzIuMHFkaWdpdGFsU291cmNlVHlwZXhGaHR0cDovL2N2LmlwdGMub3JnL25ld3Njb2Rlcy9kaWdpdGFsc291cmNldHlwZS90cmFpbmVkQWxnb3JpdGhtaWNNZWRpYaJmYWN0aW9ubmMycGEuY29udmVydGVkZHdoZW7AdDIwMjYtMDktMDRUMDA6MDA6MDBaomZhY3Rpb254GGMycGEud2F0ZXJtYXJrZWQudW5ib3VuZGR3aGVuwHQyMDI2LTA5LTA0VDAwOjAwOjAwWnJhbGxBY3Rpb25zSW5jbHVkZWT0',
  'base64',
);
const GOOGLE_C2PA_CLAIM = Buffer.from(
  'AAABt2p1bWIAAAAnanVtZGMyY2wAEQAQgAAAqgA4m3EDYzJwYS5jbGFpbS52MgAAAAGIY2JvcqVqaW5zdGFuY2VJRHgkY2Q2YjhjYjUtYTY0ZC0xYzU0LWM5MWEtNGFjNDZhYTY1NDE2dGNsYWltX2dlbmVyYXRvcl9pbmZvomRuYW1leCJHb29nbGUgQzJQQSBDb3JlIEdlbmVyYXRvciBMaWJyYXJ5Z3ZlcnNpb25zOTc0MTU0NTg4Ojk3NDE1NDU4OHJjcmVhdGVkX2Fzc2VydGlvbnOComN1cmx4KnNlbGYjanVtYmY9YzJwYS5hc3NlcnRpb25zL2MycGEuYWN0aW9ucy52MmRoYXNoWCBoIlEry3OUHQkL7sBT6fq20DpcCKubtEkMo/VaRNDouaJjdXJseClzZWxmI2p1bWJmPWMycGEuYXNzZXJ0aW9ucy9jMnBhLmhhc2guZGF0YWRoYXNoWCC7YcKybH3iGqUjpWm2/qhfAH8mGenMDMRQ1LYY8iCscGlzaWduYXR1cmV4GXNlbGYjanVtYmY9YzJwYS5zaWduYXR1cmVjYWxnZnNoYTI1Ng==',
  'base64',
);
const GOOGLE_C2PA_ACTIONS = Buffer.from(
  'AAABhGp1bWIAAAApanVtZGNib3IAEQAQgAAAqgA4m3EDYzJwYS5hY3Rpb25zLnYyAAAAAVNjYm9yoWdhY3Rpb25zgqNmYWN0aW9ubGMycGEuY3JlYXRlZGtkZXNjcmlwdGlvbnggQ3JlYXRlZCBieSBHb29nbGUgR2VuZXJhdGl2ZSBBSS5xZGlnaXRhbFNvdXJjZVR5cGV4Rmh0dHA6Ly9jdi5pcHRjLm9yZy9uZXdzY29kZXMvZGlnaXRhbHNvdXJjZXR5cGUvdHJhaW5lZEFsZ29yaXRobWljTWVkaWGjZmFjdGlvbmtjMnBhLmVkaXRlZGtkZXNjcmlwdGlvbngoQXBwbGllZCBpbXBlcmNlcHRpYmxlIFN5bnRoSUQgd2F0ZXJtYXJrLnFkaWdpdGFsc291cmNlVHlwZXhGaHR0cDovL2N2LmlwdGMub3JnL25ld3Njb2Rlcy9kaWdpdGFsc291cmNldHlwZS90cmFpbmVkQWxnb3JpdGhtaWNNZWRpYQ==',
  'base64',
);

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

  it('recognizes OpenAI C2PA generation evidence while preserving raw fields as unverified', async () => {
    const bytes = Buffer.concat([basePng, OPENAI_C2PA_CLAIM, OPENAI_C2PA_ACTIONS]);
    const fixture = tempProject(bytes);
    const sessions = new ActiveProjectSessionService();
    const sessionId = await sessions.activateProjectFile(
      fixture.projectFilePath,
      undefined,
      fixture.project,
    );
    const service = new AssetMetadataInspectionService(sessions);

    const result = await service.inspect(sessionId, 'generated');

    expect(result).toMatchObject({ ok: true, status: 'ready' });
    if (!result.ok || result.status !== 'ready') throw new Error('Expected ready metadata.');
    expect(result.groups.find((group) => group.namespace === 'C2PA')?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'claim_generator_info.name',
          value: 'OpenAI Media Service API',
        }),
        expect.objectContaining({ key: 'actions[0].action', value: 'c2pa.created' }),
        expect.objectContaining({ key: 'actions[0].softwareAgent.name', value: 'gpt-image' }),
        expect.objectContaining({ key: 'actions[0].softwareAgent.version', value: '2.0' }),
      ]),
    );
    expect(result.c2pa).toEqual({ trust: 'unverified' });
    expect(result.provenance).toEqual({
      stages: [
        expect.objectContaining({
          role: 'generated',
          provider: { id: 'openai', label: 'OpenAI' },
          model: { id: 'openai.gpt-image', label: 'gpt-image 2.0' },
        }),
      ],
    });
  });

  it('recognizes Google Generative AI and its later SynthID edit without inventing a model', async () => {
    const bytes = Buffer.concat([basePng, GOOGLE_C2PA_CLAIM, GOOGLE_C2PA_ACTIONS]);
    const fixture = tempProject(bytes);
    const sessions = new ActiveProjectSessionService();
    const sessionId = await sessions.activateProjectFile(
      fixture.projectFilePath,
      undefined,
      fixture.project,
    );
    const service = new AssetMetadataInspectionService(sessions);

    const result = await service.inspect(sessionId, 'generated');

    expect(result).toMatchObject({ ok: true, status: 'ready' });
    if (!result.ok || result.status !== 'ready') throw new Error('Expected ready metadata.');
    expect(result.c2pa).toEqual({ trust: 'unverified' });
    expect(result.groups.find((group) => group.namespace === 'C2PA')?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'jumbf[0].label', value: 'c2pa.claim.v2' }),
        expect.objectContaining({ key: 'jumbf[1].label', value: 'c2pa.actions.v2' }),
        expect.objectContaining({
          key: 'claim_generator_info.name',
          value: 'Google C2PA Core Generator Library',
        }),
        expect.objectContaining({
          key: 'actions[0].description',
          value: 'Created by Google Generative AI.',
        }),
        expect.objectContaining({
          key: 'actions[1].description',
          value: 'Applied imperceptible SynthID watermark.',
        }),
      ]),
    );
    expect(result.provenance?.stages).toEqual([
      expect.objectContaining({
        role: 'generated',
        provider: { id: 'google', label: 'Google' },
        tool: { id: 'google.generative-ai', label: 'Google Generative AI' },
      }),
      expect.objectContaining({
        role: 'edited',
        provider: { id: 'google', label: 'Google' },
        tool: { id: 'google.synthid', label: 'SynthID' },
      }),
    ]);
    expect(result.provenance?.stages[0]).not.toHaveProperty('model');
  });

  it('returns no recognized provenance for unrecognized C2PA evidence', async () => {
    const bytes = Buffer.concat([basePng, OPENAI_C2PA_CLAIM]);
    const mutated = Buffer.from(bytes);
    const name = Buffer.from('OpenAI Media Service API');
    const offset = mutated.indexOf(name);
    expect(offset).toBeGreaterThan(0);
    Buffer.from('Unknown Media Service   ').copy(mutated, offset, 0, name.length);
    const fixture = tempProject(mutated);
    const sessions = new ActiveProjectSessionService();
    const sessionId = await sessions.activateProjectFile(
      fixture.projectFilePath,
      undefined,
      fixture.project,
    );
    const service = new AssetMetadataInspectionService(sessions);

    const result = await service.inspect(sessionId, 'generated');

    expect(result).toMatchObject({ ok: true, status: 'ready' });
    if (!result.ok || result.status !== 'ready') throw new Error('Expected ready metadata.');
    expect(result.c2pa).toEqual({ trust: 'unverified' });
    expect(result.provenance).toBeUndefined();
    expect(result.groups.find((group) => group.namespace === 'C2PA')).toBeDefined();
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
