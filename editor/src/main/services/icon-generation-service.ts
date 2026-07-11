import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp, { type Metadata } from 'sharp';

export type IconPlatform = 'web' | 'android' | 'windows' | 'macos';

export interface IconGenerationDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  platform?: IconPlatform;
  message: string;
}

export interface IconGenerationRequest {
  sourcePath: string;
  stagingRoot: string;
  backgroundColor?: string;
  platforms?: IconPlatform[];
  overrides?: Partial<Record<'web' | 'androidLegacy' | 'androidForeground' | 'androidBackground' | 'windowsIco' | 'macosIcns', string>>;
}

export interface GeneratedIconFile {
  platform: IconPlatform;
  kind: string;
  path: string;
  width?: number;
  height?: number;
  source: 'generated' | 'override';
}

export interface IconGenerationResult {
  ok: boolean;
  files: GeneratedIconFile[];
  diagnostics: IconGenerationDiagnostic[];
}

const png = (input: string, size: number) => sharp(input, { failOn: 'error' }).resize(size, size, { fit: 'contain' }).png().toBuffer();

async function write(root: string, relativePath: string, data: Buffer | string): Promise<string> {
  const output = path.join(root, relativePath);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, data);
  return output;
}

function ico(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size; header[entry + 1] = size === 256 ? 0 : size;
    header[entry + 2] = 0; header[entry + 3] = 0;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(({ data }) => data)]);
}

function icns(images: { type: string; data: Buffer }[]): Buffer {
  const chunks = images.map(({ type, data }) => {
    const chunk = Buffer.alloc(8 + data.length);
    chunk.write(type, 0, 4, 'ascii'); chunk.writeUInt32BE(chunk.length, 4); data.copy(chunk, 8);
    return chunk;
  });
  const header = Buffer.alloc(8); header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

async function copyOverride(root: string, relativePath: string, source: string): Promise<string> {
  return write(root, relativePath, await fs.readFile(source));
}

async function safeAreaDiagnostic(source: string, platform: IconPlatform, inset: number): Promise<IconGenerationDiagnostic | null> {
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width; let top = info.height; let right = -1; let bottom = -1;
  for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width; x += 1) {
    if (data[(y * info.width + x) * info.channels + 3] > 8) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  if (right < 0 || (left >= info.width * inset && top >= info.height * inset && right < info.width * (1 - inset) && bottom < info.height * (1 - inset))) return null;
  return { severity: 'warning', code: 'unsafe-icon-content', platform, message: `${platform === 'web' ? 'Maskable' : 'Adaptive'} icon foreground reaches outside the recommended safe area; it may be clipped by platform masks.` };
}

export async function generateAppIcons(request: IconGenerationRequest): Promise<IconGenerationResult> {
  const diagnostics: IconGenerationDiagnostic[] = [];
  const files: GeneratedIconFile[] = [];
  const platforms = new Set(request.platforms ?? ['web', 'android', 'windows', 'macos']);
  let metadata: Metadata;
  try { metadata = await sharp(request.sourcePath, { failOn: 'error' }).metadata(); }
  catch (error) { return { ok: false, files, diagnostics: [{ severity: 'error', code: 'unreadable-source', message: `Cannot read app icon: ${error instanceof Error ? error.message : String(error)}` }] }; }
  if (!metadata.width || !metadata.height) diagnostics.push({ severity: 'error', code: 'missing-dimensions', message: 'App icon dimensions could not be determined.' });
  else {
    if (metadata.width !== metadata.height) diagnostics.push({ severity: 'warning', code: 'non-square-source', message: `App icon is ${metadata.width}x${metadata.height}; transparent padding will be added to make square outputs.` });
    if (Math.min(metadata.width, metadata.height) < 1024) diagnostics.push({ severity: 'warning', code: 'undersized-source', message: `App icon is below the recommended 1024x1024 source size and some outputs will be upscaled.` });
  }
  if (metadata.space && metadata.space !== 'srgb') diagnostics.push({ severity: 'warning', code: 'color-space-conversion', message: `App icon uses ${metadata.space}; generated icons are converted to sRGB.` });
  if (!metadata.hasAlpha && platforms.has('android') && !request.overrides?.androidForeground) diagnostics.push({ severity: 'warning', code: 'missing-alpha', platform: 'android', message: 'The Android adaptive foreground has no alpha channel; a fully opaque foreground may hide the adaptive background and crop poorly.' });
  const background = request.backgroundColor ?? '#ffffff';
  const add = (platform: IconPlatform, kind: string, output: string, source: 'generated' | 'override', size?: number) => files.push({ platform, kind, path: output, width: size, height: size, source });

  if (platforms.has('web')) {
    const source = request.overrides?.web ?? request.sourcePath;
    for (const size of [16, 32, 180, 192, 512]) add('web', size <= 32 ? 'favicon' : 'icon', await write(request.stagingRoot, `web/icons/icon-${size}.png`, await png(source, size)), request.overrides?.web ? 'override' : 'generated', size);
    add('web', 'favicon', await write(request.stagingRoot, 'web/favicon.ico', ico(await Promise.all([16, 32].map(async (size) => ({ size, data: await png(source, size) }))))), request.overrides?.web ? 'override' : 'generated');
    diagnostics.push(...[await safeAreaDiagnostic(source, 'web', 0.1)].filter((value): value is IconGenerationDiagnostic => value !== null));
  }
  if (platforms.has('android')) {
    const legacy = request.overrides?.androidLegacy ?? request.sourcePath;
    for (const [density, size] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]] as const) add('android', 'legacy', await write(request.stagingRoot, `android/res/mipmap-${density}/ic_launcher.png`, await png(legacy, size)), request.overrides?.androidLegacy ? 'override' : 'generated', size);
    const foreground = request.overrides?.androidForeground ?? request.sourcePath;
    for (const [density, size] of [['mdpi', 108], ['hdpi', 162], ['xhdpi', 216], ['xxhdpi', 324], ['xxxhdpi', 432]] as const) add('android', 'adaptive-foreground', await write(request.stagingRoot, `android/res/mipmap-${density}/ic_launcher_foreground.png`, await png(foreground, size)), request.overrides?.androidForeground ? 'override' : 'generated', size);
    const bg = request.overrides?.androidBackground;
    const backgroundXml = bg ? `<bitmap xmlns:android="http://schemas.android.com/apk/res/android" android:src="@drawable/ic_launcher_background_image" android:gravity="fill" />\n` : `<color xmlns:android="http://schemas.android.com/apk/res/android" android:color="${background}" />\n`;
    if (bg) add('android', 'adaptive-background', await write(request.stagingRoot, 'android/res/drawable/ic_launcher_background_image.png', await png(bg, 432)), 'override', 432);
    await write(request.stagingRoot, 'android/res/drawable/ic_launcher_background.xml', backgroundXml);
    for (const qualifier of ['mipmap-anydpi-v26', 'mipmap-anydpi-v33']) add('android', 'adaptive-xml', await write(request.stagingRoot, `android/res/${qualifier}/ic_launcher.xml`, `<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@drawable/ic_launcher_background"/><foreground android:drawable="@mipmap/ic_launcher_foreground"/></adaptive-icon>\n`), 'generated');
    diagnostics.push(...[await safeAreaDiagnostic(foreground, 'android', 0.185)].filter((value): value is IconGenerationDiagnostic => value !== null));
  }
  if (platforms.has('windows')) {
    const output = request.overrides?.windowsIco
      ? await copyOverride(request.stagingRoot, 'windows/app.ico', request.overrides.windowsIco)
      : await write(request.stagingRoot, 'windows/app.ico', ico(await Promise.all([16, 24, 32, 48, 64, 128, 256].map(async (size) => ({ size, data: await png(request.sourcePath, size) })))));
    add('windows', 'ico', output, request.overrides?.windowsIco ? 'override' : 'generated');
  }
  if (platforms.has('macos')) {
    const output = request.overrides?.macosIcns
      ? await copyOverride(request.stagingRoot, 'macos/AppIcon.icns', request.overrides.macosIcns)
      : await write(request.stagingRoot, 'macos/AppIcon.icns', icns(await Promise.all([['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]].map(async ([type, size]) => ({ type: String(type), data: await png(request.sourcePath, Number(size)) })))));
    add('macos', 'icns', output, request.overrides?.macosIcns ? 'override' : 'generated');
  }
  return { ok: !diagnostics.some(({ severity }) => severity === 'error'), files, diagnostics };
}
