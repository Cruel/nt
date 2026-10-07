import sharp from 'sharp';
import { deflateSync } from 'node:zlib';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importAnimationFiles } from '../../main/services/animation-import-service';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { emptyMaterialApplication } from '../../shared/project-schema/authoring-material-applications';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { lowerSharedAuthoringProject } from '../../shared/authoring-compiler-shared-lowering';
import { buildAuthoringStructuralDependencyGraph } from '../../shared/authoring-dependency-graph';
import { buildFocusedRoomPreview } from '../preview/room-focused-preview-builder';
import { DEFAULT_PREVIEW_DISPLAY_PREFERENCE } from '../../shared/preview-display';
import { importAssetRecordsPatches } from '../project/asset-operations';
import { applyJsonPatch } from '../project/json-patch';
import { toJsonValue } from '../project/json-value';
import { prepareRuntimeAssessmentForTest } from './runtime-artifact-test-helpers';
import { defaultExportProfile } from '../../shared/project-schema/authoring-export';
import { createLocalizedAssetVariant } from '../../shared/authoring-localized-assets';
import { expect, it } from 'vite-plus/test';
import { prepareRasterAnimation } from '../../main/services/raster-animation-import';

it('normalizes an ordered image sequence to full-canvas PNG frames with explicit timing', async () => {
  const red = await sharp({ create: { width: 2, height: 1, channels: 4, background: '#ff0000' } })
    .png()
    .toBuffer();
  const blue = await sharp({ create: { width: 2, height: 1, channels: 4, background: '#0000ff' } })
    .png()
    .toBuffer();
  const result = await prepareRasterAnimation(
    [
      { name: 'frame-2.png', bytes: red },
      { name: 'frame-10.png', bytes: blue },
    ],
    75,
  );
  expect(result.format).toBe('image-sequence');
  expect(result.canvas).toEqual({ width: 2, height: 1 });
  expect(result.frames.map((frame) => frame.durationMs)).toEqual([75, 75]);
  expect([...(await sharp(result.frames[1]!.png).raw().toBuffer())]).toEqual([
    0, 0, 255, 255, 0, 0, 255, 255,
  ]);
});

function chunk(type: string, data: Buffer) {
  const name = Buffer.from(type);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

function apngFixture(alpha = 255, disposal = 2, poster = false) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const control = Buffer.alloc(8);
  control.writeUInt32BE(3);
  let sequence = 0;
  const frame = (
    width: number,
    x: number,
    numerator: number,
    denominator: number,
    dispose: number,
    blend: number,
    pixels: number[],
    first = false,
  ) => {
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(sequence++);
    fctl.writeUInt32BE(width, 4);
    fctl.writeUInt32BE(1, 8);
    fctl.writeUInt32BE(x, 12);
    fctl.writeUInt16BE(numerator, 20);
    fctl.writeUInt16BE(denominator, 22);
    fctl[24] = dispose;
    fctl[25] = blend;
    const compressed = deflateSync(Buffer.from([0, ...pixels]));
    const data = Buffer.alloc(4);
    data.writeUInt32BE(sequence++);
    if (first) sequence--;
    return Buffer.concat([
      chunk('fcTL', fctl),
      first ? chunk('IDAT', compressed) : chunk('fdAT', Buffer.concat([data, compressed])),
    ]);
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('acTL', control),
    ...(poster
      ? [chunk('IDAT', deflateSync(Buffer.from([0, 0, 255, 0, 255, 0, 255, 0, 255])))]
      : []),
    frame(2, 0, 1, 10, 0, 0, [255, 0, 0, 255, 255, 0, 0, 255], !poster),
    frame(1, 1, 1, 20, disposal, 1, [0, 0, 255, alpha]),
    frame(1, 0, 1, 0, 1, 0, [0, 0, 0, 0]),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

it('imports APNG into ordinary Assets and matches manual Animation compilation and focused closure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-animation-'));
  try {
    const source = path.join(root, 'pulse.apng');
    await fs.writeFile(source, apngFixture());
    const result = await importAnimationFiles(root, [source], 100);
    expect(result.ok).toBe(true);
    expect(result.animation?.frames.map((frame) => frame.durationMs)).toEqual([100, 50, 10]);
    for (const asset of result.assets)
      expect(await fs.readFile(path.join(root, asset.projectRelativePath))).not.toHaveLength(0);
    const project = createAuthoringProject();
    project.materials.surface = {
      id: 'surface',
      label: 'Surface',
      data: defaultMaterialData('Surface', 'engine-2d'),
    };
    const room = defaultRoomData('Room');
    room.environments = [
      {
        id: 'pulse',
        condition: { kind: 'always' },
        visual: {
          kind: 'animation',
          animation: { $ref: { collection: 'animations', id: 'pulse' } },
          motionId: null,
          playback: null,
        },
        materialApplication: emptyMaterialApplication('surface'),
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        plane: 'world-overlay',
        order: 0,
        clock: 'gameplay',
        scrollPerSecond: { x: 0, y: 0 },
        opacity: 1,
        visible: true,
      },
    ];
    project.rooms.room = { id: 'room', label: 'Room', data: room };
    project.entrypoint = { kind: 'room', id: 'room' };
    const patches = importAssetRecordsPatches(project, result);
    const imported = applyJsonPatch(toJsonValue(project), patches.patches)
      .document as unknown as typeof project;
    const manual = structuredClone(imported);
    manual.animations.pulse = {
      id: 'pulse',
      label: 'pulse',
      data: {
        kind: 'animation',
        canvas: { width: 2, height: 1 },
        defaultMotionId: 'default',
        motions: [
          {
            id: 'default',
            kind: 'sprite-sequence',
            markers: [],
            frames: [100, 50, 10].map((durationMs, index) => ({
              image: { $ref: { collection: 'assets', id: `pulse-frame-000${index + 1}` } },
              durationMs,
            })),
          },
        ],
      },
    };
    const compiled = lowerSharedAuthoringProject(imported);
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.draft).toEqual(lowerSharedAuthoringProject(manual).draft);
    const preview = (p: typeof project) =>
      buildFocusedRoomPreview({
        project: p,
        projectSessionId: '11111111-1111-4111-8111-111111111111',
        roomId: 'room',
        inputs: { displayPreference: DEFAULT_PREVIEW_DISPLAY_PREFERENCE },
        graph: {
          projectInstanceId: 'test',
          projectRevision: 1,
          graphRevision: 1,
          graph: buildAuthoringStructuralDependencyGraph(p),
        },
        sourceAnalysis: [],
        activeShaderVariant: 'glsl-330',
      });
    const importedPreview = await preview(imported);
    expect(importedPreview).toEqual(await preview(manual));
    expect(JSON.stringify(importedPreview)).not.toContain('.apng');
    expect(JSON.stringify(importedPreview)).toContain('pulse-frame-0003');
    expect(
      await fs.readFile(path.join(root, imported.animations.pulse!.import!.sources[0]!.path)),
    ).toEqual(apngFixture());
    const localized = structuredClone(imported);
    localized.assets.french = {
      ...structuredClone(imported.assets['pulse-frame-0001']!),
      id: 'french',
      label: 'French frame',
      data: {
        ...structuredClone(imported.assets['pulse-frame-0001']!.data),
        source: { type: 'project-file', path: 'assets/images/french.png' },
      },
    };
    localized.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
    localized.localization.assets.fr = {
      'pulse-frame-0001': createLocalizedAssetVariant(
        localized,
        'pulse-frame-0001',
        'french',
        'human',
      )!,
    };
    const assessment = await prepareRuntimeAssessmentForTest(localized, {
      projectRoot: root,
      profile: {
        ...defaultExportProfile(),
        compileShadersBeforeExport: false,
        localization: { locales: ['fr'], defaultLocale: 'fr', quality: 'development' },
      },
    });
    expect(assessment.ready).toBe(true);
    expect(assessment.fileEntries.map((entry) => entry.assetId).sort()).toEqual([
      'french',
      'pulse-frame-0002',
      'pulse-frame-0003',
    ]);
    expect(assessment.compiledProject?.resources.animations).toEqual(
      compiled.draft!.resources.animations,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('excludes an APNG poster and composites partial alpha with background disposal', async () => {
  const result = await prepareRasterAnimation(
    [{ name: 'poster.apng', bytes: apngFixture(128, 1, true) }],
    100,
  );
  expect(result.frames).toHaveLength(3);
  expect([...(await sharp(result.frames[0]!.png).raw().toBuffer())]).toEqual([
    255, 0, 0, 255, 255, 0, 0, 255,
  ]);
  expect([...(await sharp(result.frames[1]!.png).raw().toBuffer())]).toEqual([
    255, 0, 0, 255, 127, 0, 128, 255,
  ]);
  expect([...(await sharp(result.frames[2]!.png).raw().toBuffer())]).toEqual([
    0, 0, 0, 0, 0, 0, 0, 0,
  ]);
});

it('coalesces APNG subframes, restores previous disposal, and preserves rational delays', async () => {
  const result = await prepareRasterAnimation([{ name: 'pulse.png', bytes: apngFixture() }], 75);
  expect(result.format).toBe('apng');
  expect(result.frames.map((frame) => frame.durationMs)).toEqual([100, 50, 10]);
  expect([...(await sharp(result.frames[1]!.png).ensureAlpha().raw().toBuffer())]).toEqual([
    255, 0, 0, 255, 0, 0, 255, 255,
  ]);
  expect([...(await sharp(result.frames[2]!.png).ensureAlpha().raw().toBuffer())]).toEqual([
    0, 0, 0, 0, 255, 0, 0, 255,
  ]);
});

it('rejects corrupt/truncated media and unequal sequences before publishing project files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-animation-reject-'));
  try {
    const source = path.join(root, 'bad.apng');
    await fs.writeFile(source, apngFixture().subarray(0, -5));
    expect(await importAnimationFiles(root, [source], 100)).toMatchObject({
      ok: false,
      success: false,
      assets: [],
    });
    await expect(fs.access(path.join(root, 'assets'))).rejects.toThrow();
    const first = await sharp({ create: { width: 1, height: 1, channels: 4, background: 'red' } })
      .png()
      .toBuffer();
    const second = await sharp({ create: { width: 2, height: 1, channels: 4, background: 'red' } })
      .png()
      .toBuffer();
    await expect(
      prepareRasterAnimation(
        [
          { name: 'a.png', bytes: first },
          { name: 'b.png', bytes: second },
        ],
        100,
      ),
    ).rejects.toThrow('equal oriented dimensions');
    await expect(prepareRasterAnimation([{ name: 'a.png', bytes: first }], 0)).rejects.toThrow(
      'positive frame duration',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('orders sequence filenames naturally and preserves originals for rebuilds', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-animation-sequence-'));
  try {
    const first = path.join(root, 'frame-2.png'),
      second = path.join(root, 'frame-10.png');
    const red = await sharp({ create: { width: 1, height: 1, channels: 4, background: 'red' } })
      .png()
      .toBuffer();
    const blue = await sharp({ create: { width: 1, height: 1, channels: 4, background: 'blue' } })
      .png()
      .toBuffer();
    await fs.writeFile(first, red);
    await fs.writeFile(second, blue);
    const result = await importAnimationFiles(root, [second, first], 85);
    expect(result.ok).toBe(true);
    expect(result.animation?.frames.map((frame) => frame.durationMs)).toEqual([85, 85]);
    expect(
      result.animation?.sourceAssetIndices.map((index) => result.assets[index]!.originalName),
    ).toEqual(['frame-2.png', 'frame-10.png']);
    expect([
      ...(await sharp(await fs.readFile(path.join(root, result.assets[0]!.projectRelativePath)))
        .raw()
        .toBuffer()),
    ]).toEqual([255, 0, 0, 255]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('preserves GIF delays without importing source loop behavior', async () => {
  const gif = await sharp(Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]), {
    raw: { width: 1, height: 2, channels: 4, pageHeight: 1 },
  })
    .gif({ delay: [40, 130], loop: 3 })
    .toBuffer();
  const result = await prepareRasterAnimation([{ name: 'pulse.gif', bytes: gif }], 75);
  expect(result.format).toBe('gif');
  expect(result.canvas).toEqual({ width: 1, height: 1 });
  expect(result.frames.map((frame) => frame.durationMs)).toEqual([40, 130]);
  expect([...(await sharp(result.frames[1]!.png).raw().toBuffer())]).toEqual([0, 0, 255, 255]);
});
