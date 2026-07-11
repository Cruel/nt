import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import * as ResEdit from 'resedit';
import { generateAppIcons } from './icon-generation-service';
import { buildPlatformDeployment } from '../../shared/project-schema/platform-deployment';
import { PLATFORM_EXPORT_MANIFEST_FORMAT, PLATFORM_EXPORT_MANIFEST_FORMAT_VERSION, type PlatformExportManifest, type PlatformStageDiagnostic, type PlatformStageRequest, type PlatformStageResult, type StagedFileEntry, type StagedFileOrigin } from '../../shared/project-schema/platform-export-contracts';
import { validateTargetPaths } from '../../shared/project-schema/target-path-portability';
import { templateRootForToken, verifyTemplateToken } from './template-registry-service';

const cancellations = new Set<string>();
const descriptorName = 'template.json';
const forbidden = /(^|\/)(?:sandbox|demo)(?:\/|$)/i;
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const run = promisify(execFile);
const diagnostic = (code: string, pathValue: string, message: string): PlatformStageDiagnostic => ({ severity: 'error', code, path: pathValue, message });

export function cancelPlatformExport(operationId: string) { cancellations.add(operationId); return { cancelled: true }; }
export function checkPlatformExportCancelled(operationId: string) { if (cancellations.has(operationId)) throw new Error('NOVELTEA_EXPORT_CANCELLED'); }
export function clearPlatformExportCancellation(operationId: string) { cancellations.delete(operationId); }
function safeRoot(root: string, relative: string) { const resolved = path.resolve(root, relative); if (resolved !== path.resolve(root) && !resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`Path '${relative}' escapes its root.`); return resolved; }
async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(safeRoot(root, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix.split(path.sep).join('/'), entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link '${relative}' is not allowed in export inputs.`);
    if (entry.isDirectory()) output.push(...await listFiles(root, relative)); else if (entry.isFile()) output.push(relative);
  }
  return output.sort();
}
async function copyFileTracked(source: string, stage: string, target: string, origin: StagedFileOrigin, originId: string): Promise<StagedFileEntry> {
  const info = await lstat(source); if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Export input '${source}' is not a regular file.`);
  const data = await readFile(source); const destination = safeRoot(stage, target); await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, data, { mode: info.mode & 0o777 });
  return { path: target.split(path.sep).join('/'), origin, originId, size: data.length, mode: info.mode & 0o777, sha256: sha256(data) };
}
function classifyTemplate(relative: string, dependencyKinds: Map<string, StagedFileOrigin>): StagedFileOrigin { return dependencyKinds.get(relative) ?? 'template'; }

function htmlEscape(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

async function writeGenerated(stage: string, target: string, data: string | Buffer, originId: string): Promise<StagedFileEntry> {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const destination = safeRoot(stage, target);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, buffer, { mode: 0o644 });
  return { path: target, origin: 'generated-metadata', originId, size: buffer.length, mode: 0o644, sha256: sha256(buffer) };
}

function linuxDesktopId(request: PlatformStageRequest) {
  const value = request.identity.linuxDesktopId ?? request.identity.applicationId;
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(value)) {
    throw new Error(`Linux desktop ID '${value}' is invalid.`);
  }
  return value;
}

function desktopEntryEscape(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');
}

function plistEscape(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function macosEntitlements(capabilities: readonly string[]) {
  const entries: string[] = [];
  if (capabilities.includes('microphone')) entries.push('  <key>com.apple.security.device.audio-input</key>\n  <true/>');
  if (!entries.length) return undefined;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${entries.join('\n')}\n</dict>\n</plist>\n`;
}

async function finalizeMacosStage(
  stage: string,
  request: PlatformStageRequest,
  files: StagedFileEntry[],
  descriptor: Awaited<ReturnType<typeof verifyTemplateToken>>['descriptor'],
) {
  if (request.profile.target !== 'macos') return undefined;
  if (!request.outputDirectory.toLowerCase().endsWith('.app')) {
    throw new Error('macOS app bundle output must use the .app extension.');
  }
  if (request.profile.packageAccess !== 'bundle-resource') {
    throw new Error('macOS exports require bundle-resource package access.');
  }
  if (!descriptor.macosDependencies || !descriptor.macosRpaths || !descriptor.macosMachO) {
    throw new Error('macOS template must declare per-binary Mach-O dependencies, runtime paths, and UUIDs.');
  }
  const playerDescriptor = descriptor.files.find((item) => item.role === 'player');
  if (!playerDescriptor) throw new Error('macOS template must declare a player file role.');
  const playerEntry = files.find((item) => item.path === playerDescriptor.path);
  if (!playerEntry) throw new Error(`macOS player '${playerDescriptor.path}' was not staged.`);
  if ((playerEntry.mode & 0o111) === 0) throw new Error('macOS player template is not executable.');

  const executableName = request.profile.desktop.executableName;
  if (!/^[A-Za-z0-9._+-]+$/.test(executableName) || executableName === '.' || executableName === '..') {
    throw new Error('macOS executable name may contain only letters, numbers, dot, underscore, plus, and hyphen.');
  }
  const bundleId = request.identity.applicationId;
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId)) throw new Error(`macOS bundle ID '${bundleId}' is invalid.`);
  const resources = 'Contents/Resources';
  const macos = 'Contents/MacOS';
  const frameworks = 'Contents/Frameworks';

  const moveEntry = async (entry: StagedFileEntry, target: string) => {
    await mkdir(path.dirname(safeRoot(stage, target)), { recursive: true });
    await rename(safeRoot(stage, entry.path), safeRoot(stage, target));
    entry.path = target;
  };
  await moveEntry(playerEntry, `${macos}/${executableName}`);
  playerEntry.mode |= 0o111;
  await chmod(safeRoot(stage, playerEntry.path), playerEntry.mode);
  const packageEntry = files.find((item) => item.origin === 'runtime-package');
  if (!packageEntry) throw new Error('macOS staging is missing the runtime package.');
  await moveEntry(packageEntry, `${resources}/game.ntpkg`);

  for (const entry of files.filter((item) => item.path.startsWith('assets/'))) {
    await moveEntry(entry, `${resources}/${entry.path}`);
  }
  const iconEntry = files.find((item) => item.origin === 'icon' && item.path.endsWith('/macos/AppIcon.icns'));
  if (!iconEntry) throw new Error('macOS icon generation did not produce AppIcon.icns.');
  await moveEntry(iconEntry, `${resources}/AppIcon.icns`);

  const nativeEntries = files.filter((item) => item.origin === 'native-dependency' && /\.dylib$/i.test(item.path));
  for (const entry of nativeEntries) await moveEntry(entry, `${frameworks}/${path.posix.basename(entry.path)}`);
  for (const entry of files.filter((item) => !item.path.startsWith('Contents/') && !item.path.startsWith('symbols/'))) {
    await moveEntry(entry, `${resources}/${entry.path}`);
  }
  const bundledNames = new Set(nativeEntries.map((item) => path.posix.basename(item.path)));
  const systemDependency = (value: string) => value.startsWith('/System/Library/') || value.startsWith('/usr/lib/');
  const stagedMachO = new Map<string, string>();
  stagedMachO.set(playerDescriptor.path, playerEntry.path);
  for (const entry of nativeEntries) {
    const original = descriptor.files.find((item) => item.role === 'native-dependency' && path.posix.basename(item.path) === path.posix.basename(entry.path));
    if (original) stagedMachO.set(original.path, entry.path);
  }
  const missingMachO = descriptor.macosMachO.filter((item) => !stagedMachO.has(item.path));
  if (missingMachO.length) throw new Error(`macOS template Mach-O inventory references unstaged files: ${missingMachO.map((item) => item.path).join(', ')}`);
  const unresolved = descriptor.macosMachO.flatMap((binary) => binary.dependencies
    .filter((dependency) => !systemDependency(dependency) && !bundledNames.has(path.posix.basename(dependency)))
    .map((dependency) => `${binary.path}: ${dependency}`));
  if (unresolved.length) throw new Error(`macOS player has unresolved or nonportable Mach-O dependencies: ${unresolved.join(', ')}`);
  const badRpath = descriptor.macosMachO.flatMap((binary) => binary.rpaths.map((value) => ({ binary: binary.path, value })))
    .find(({ value }) => value.startsWith('/') || value.includes('/build/') || value.includes('/Users/') || value.includes('/tmp/'));
  if (badRpath) throw new Error(`macOS template contains nonportable runtime path '${badRpath.value}' in '${badRpath.binary}'.`);

  if (process.platform === 'darwin') {
    for (const binary of descriptor.macosMachO) {
      const stagedPath = stagedMachO.get(binary.path)!;
      const absolute = safeRoot(stage, stagedPath);
      const isPlayer = binary.path === playerDescriptor.path;
      if (!isPlayer) {
        const name = path.posix.basename(stagedPath);
        await run('install_name_tool', ['-id', `@rpath/${name}`, absolute]);
      }
      for (const dependency of binary.dependencies) {
        const name = path.posix.basename(dependency);
        if (!bundledNames.has(name)) continue;
        const replacement = isPlayer ? `@rpath/${name}` : `@loader_path/${name}`;
        if (dependency !== replacement) await run('install_name_tool', ['-change', dependency, replacement, absolute]);
      }
    }
    if (nativeEntries.length && !descriptor.macosRpaths.includes('@executable_path/../Frameworks')) {
      await run('install_name_tool', ['-add_rpath', '@executable_path/../Frameworks', safeRoot(stage, playerEntry.path)]);
    }
  }

  const capabilities = request.capabilities ?? [];
  if (capabilities.includes('microphone') && !request.identity.macosMicrophoneUsageDescription) {
    throw new Error('macOS microphone capability requires a microphone usage description.');
  }
  const privacy = capabilities.includes('microphone')
    ? `  <key>NSMicrophoneUsageDescription</key>\n  <string>${plistEscape(request.identity.macosMicrophoneUsageDescription!)}</string>\n`
    : '';
  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>CFBundleDevelopmentRegion</key>\n  <string>${plistEscape(request.identity.defaultLocale ?? 'en')}</string>\n  <key>CFBundleDisplayName</key>\n  <string>${plistEscape(request.identity.displayName)}</string>\n  <key>CFBundleExecutable</key>\n  <string>${plistEscape(executableName)}</string>\n  <key>CFBundleIconFile</key>\n  <string>AppIcon</string>\n  <key>CFBundleIdentifier</key>\n  <string>${plistEscape(bundleId)}</string>\n  <key>CFBundleInfoDictionaryVersion</key>\n  <string>6.0</string>\n  <key>CFBundleName</key>\n  <string>${plistEscape(request.identity.shortName ?? request.identity.displayName)}</string>\n  <key>CFBundlePackageType</key>\n  <string>APPL</string>\n  <key>CFBundleShortVersionString</key>\n  <string>${plistEscape(request.identity.versionName)}</string>\n  <key>CFBundleVersion</key>\n  <string>${plistEscape(request.identity.versionName)}</string>\n  <key>LSApplicationCategoryType</key>\n  <string>${plistEscape(request.identity.macosCategory ?? 'public.app-category.games')}</string>\n  <key>LSMinimumSystemVersion</key>\n  <string>13.0</string>\n  <key>NSHighResolutionCapable</key>\n  <true/>\n${privacy}</dict>\n</plist>\n`;
  files.push(await writeGenerated(stage, 'Contents/Info.plist', infoPlist, 'macos-info-plist'));
  const locale = request.identity.defaultLocale ?? 'en';
  files.push(await writeGenerated(stage, `${resources}/${locale}.lproj/InfoPlist.strings`, `CFBundleDisplayName = "${request.identity.displayName.replaceAll('"', '\\"')}";\n`, 'macos-localized-info'));
  const entitlements = macosEntitlements(capabilities);

  const symbolEntries = files.filter((item) => item.path.startsWith('symbols/'));
  const symbolFiles: Array<{ path: string; data: Buffer }> = [];
  for (const symbol of symbolEntries) {
    symbolFiles.push({ path: symbol.path.slice('symbols/'.length), data: await readFile(safeRoot(stage, symbol.path)) });
    await rm(safeRoot(stage, symbol.path), { force: true });
    files.splice(files.indexOf(symbol), 1);
  }
  await rm(safeRoot(stage, 'symbols'), { recursive: true, force: true });
  return { executablePath: playerEntry.path, entitlements, frameworkPaths: nativeEntries.map((item) => item.path), symbolFiles };
}

async function finalizeLinuxStage(
  stage: string,
  request: PlatformStageRequest,
  files: StagedFileEntry[],
  descriptor: Awaited<ReturnType<typeof verifyTemplateToken>>['descriptor'],
) {
  if (request.profile.target !== 'linux') return undefined;
  const playerDescriptor = descriptor.files.find((item) => item.role === 'player');
  if (!playerDescriptor) throw new Error('Linux template must declare a player file role.');
  const playerEntry = files.find((item) => item.path === playerDescriptor.path);
  if (!playerEntry) throw new Error(`Linux player '${playerDescriptor.path}' was not staged.`);
  if ((playerEntry.mode & 0o111) === 0) throw new Error('Linux player template is not executable.');

  const executableName = request.profile.desktop.executableName;
  if (!/^[A-Za-z0-9._+-]+$/.test(executableName) || executableName === '.' || executableName === '..') {
    throw new Error('Linux executable name may contain only letters, numbers, dot, underscore, plus, and hyphen.');
  }
  const executablePath = path.posix.join(path.posix.dirname(playerEntry.path), executableName);
  if (playerEntry.path !== executablePath) {
    await rename(safeRoot(stage, playerEntry.path), safeRoot(stage, executablePath));
    playerEntry.path = executablePath;
  }
  await chmod(safeRoot(stage, executablePath), playerEntry.mode | 0o111);
  playerEntry.mode |= 0o111;

  const packageEntry = files.find((item) => item.origin === 'runtime-package');
  if (!packageEntry) throw new Error('Linux staging is missing the runtime package.');
  const packagePath = path.posix.join(path.posix.dirname(executablePath), 'game.ntpkg');
  if (packageEntry.path !== packagePath) {
    await rename(safeRoot(stage, packageEntry.path), safeRoot(stage, packagePath));
    packageEntry.path = packagePath;
  }

  if (!descriptor.linuxNeeded || !descriptor.linuxRpaths) {
    throw new Error('Linux template must declare ELF NEEDED entries and runtime paths.');
  }
  const forbiddenRpath = descriptor.linuxRpaths.find((item) => item.startsWith('/') || /(^|:)(?:\/home|\/tmp|[^:]*build\/)/.test(item));
  if (forbiddenRpath) throw new Error(`Linux template contains nonportable runtime path '${forbiddenRpath}'.`);
  const nativeLibraries = new Set(files
    .filter((item) => item.origin === 'native-dependency' && item.path !== playerEntry.path && /\.so(?:\.|$)/.test(item.path))
    .map((item) => path.posix.basename(item.path)));
  const systemLibraries = [/^linux-vdso/, /^ld-linux/, /^libc\.so/, /^libm\.so/, /^libdl\.so/, /^libpthread\.so/, /^librt\.so/, /^libgcc_s\.so/, /^libstdc\+\+\.so/, /^libX/, /^libxcb/, /^libwayland-/, /^libxkbcommon/, /^libGL/, /^libEGL/, /^libdrm/, /^libasound/, /^libpulse/, /^libudev/, /^libdbus-/, /^libfontconfig/, /^libfreetype/, /^libz\.so/];
  const unresolved = descriptor.linuxNeeded.filter((name) =>
    !nativeLibraries.has(name) && !systemLibraries.some((pattern) => pattern.test(name)),
  );
  if (unresolved.length) throw new Error(`Linux player has unresolved non-system ELF dependencies: ${unresolved.join(', ')}`);
  if (nativeLibraries.size && !descriptor.linuxRpaths.some((item) => item.includes('$ORIGIN'))) {
    throw new Error('Linux templates with bundled native libraries must use an $ORIGIN-relative runtime path.');
  }

  const id = linuxDesktopId(request);
  const iconEntries = files.filter((item) => item.origin === 'icon' && item.path.includes('/linux/hicolor/'));
  if (!iconEntries.length) throw new Error('Linux icon generation did not produce hicolor icons.');
  for (const entry of iconEntries) {
    const match = entry.path.match(/linux\/hicolor\/(\d+x\d+)\/apps\/app\.png$/);
    if (!match) continue;
    const target = `share/icons/hicolor/${match[1]}/apps/${id}.png`;
    await mkdir(path.dirname(safeRoot(stage, target)), { recursive: true });
    await rename(safeRoot(stage, entry.path), safeRoot(stage, target));
    entry.path = target;
  }
  const desktopPath = `share/applications/${id}.desktop`;
  const desktop = `[Desktop Entry]\nType=Application\nVersion=1.0\nName=${desktopEntryEscape(request.identity.displayName)}\nExec=${executableName}\nIcon=${id}\nTerminal=false\nCategories=Game;\nStartupNotify=true\nX-NovelTea-ApplicationId=${desktopEntryEscape(request.identity.applicationId)}\nX-NovelTea-SaveNamespace=${desktopEntryEscape(request.identity.saveNamespace)}\n`;
  files.push(await writeGenerated(stage, desktopPath, desktop, 'linux-desktop-entry'));

  const launcherPath = executableName;
  const launcher = `#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$ROOT/${executablePath}" "$@"\n`;
  const launcherEntry = await writeGenerated(stage, launcherPath, launcher, 'linux-launcher');
  launcherEntry.mode = 0o755;
  await chmod(safeRoot(stage, launcherPath), 0o755);
  files.push(launcherEntry);

  const symbolEntries = descriptor.files.filter((item) => item.role === 'symbol' || /\.debug$/i.test(item.path));
  const symbolFiles: Array<{ path: string; data: Buffer }> = [];
  for (const symbol of symbolEntries) {
    const entry = files.find((item) => item.path === symbol.path);
    if (!entry) continue;
    symbolFiles.push({ path: path.posix.basename(entry.path), data: await readFile(safeRoot(stage, entry.path)) });
    await rm(safeRoot(stage, entry.path), { force: true });
    files.splice(files.indexOf(entry), 1);
  }
  files.push(await writeGenerated(stage, 'LINUX_METADATA.json', `${JSON.stringify({
    applicationId: request.identity.applicationId,
    saveNamespace: request.identity.saveNamespace,
    desktopId: id,
    executable: launcherPath,
    player: executablePath,
    buildId: descriptor.buildId,
    needed: descriptor.linuxNeeded,
    rpaths: descriptor.linuxRpaths,
  }, null, 2)}\n`, 'linux-metadata'));
  return { executableName, executablePath, desktopPath, iconEntries, symbolFiles };
}

async function buildLinuxAppImage(stage: string, output: string, request: PlatformStageRequest, linux: NonNullable<Awaited<ReturnType<typeof finalizeLinuxStage>>>) {
  const appDir = `${stage}.AppDir`;
  await rm(appDir, { recursive: true, force: true });
  await mkdir(appDir, { recursive: true });
  for (const file of await listFiles(stage)) await copyFileTracked(safeRoot(stage, file), appDir, file, 'template', 'appimage-stage');
  await writeFile(path.join(appDir, 'AppRun'), `#!/bin/sh\nset -eu\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$HERE/${linux.executablePath}" "$@"\n`, { mode: 0o755 });
  const desktopSource = safeRoot(stage, linux.desktopPath);
  await writeFile(path.join(appDir, `${linuxDesktopId(request)}.desktop`), await readFile(desktopSource), { mode: 0o644 });
  const largestIcon = [...linux.iconEntries].sort((a, b) => b.size - a.size)[0];
  if (!largestIcon) throw new Error('Cannot build AppImage without a generated Linux icon.');
  await writeFile(path.join(appDir, `${linuxDesktopId(request)}.png`), await readFile(safeRoot(stage, largestIcon.path)), { mode: 0o644 });
  const tool = request.linuxAppImageTool ?? 'appimagetool';
  await rm(output, { force: true });
  try { await run(tool, [appDir, output], { cwd: path.dirname(stage), env: { ...process.env, ARCH: request.profile.architecture === 'arm64' ? 'aarch64' : 'x86_64' } }); }
  catch (error) { throw new Error(`AppImage creation requires a working appimagetool (${error instanceof Error ? error.message : String(error)}).`); }
  await rm(appDir, { recursive: true, force: true });
}

function parseWindowsVersion(versionName: string): [number, number, number, number] {
  const parts = versionName.split(/[^0-9]+/).filter(Boolean).slice(0, 4).map((part) => Math.min(65535, Number.parseInt(part, 10) || 0));
  while (parts.length < 4) parts.push(0);
  return parts as [number, number, number, number];
}

function windowsManifest(applicationId: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="1.0.0.0" processorArchitecture="*" name="${htmlEscape(applicationId)}" type="win32"/>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application>
    <supportedOS Id="{4f476546-9377-4f76-855a-22e1bb7d2ce6}"/><supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
  </application></compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings>
    <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
    <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2,PerMonitor</dpiAwareness>
    <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
  </windowsSettings></application>
</assembly>`;
}

async function finalizeWindowsStage(stage: string, request: PlatformStageRequest, files: StagedFileEntry[], descriptor: Awaited<ReturnType<typeof verifyTemplateToken>>['descriptor']) {
  if (request.profile.target !== 'windows') return undefined;
  const playerDescriptor = descriptor.files.find((item) => item.role === 'player');
  if (!playerDescriptor) throw new Error('Windows template must declare a player file role.');
  const playerEntry = files.find((item) => item.path === playerDescriptor.path);
  if (!playerEntry) throw new Error(`Windows player '${playerDescriptor.path}' was not staged.`);
  const executableName = request.profile.desktop.executableName.replace(/\.exe$/i, '');
  if (!/^[^<>:"/\\|?*\x00-\x1f.][^<>:"/\\|?*\x00-\x1f]*$/.test(executableName)) throw new Error('Windows executable name contains invalid characters.');
  const targetPath = `${executableName}.exe`;
  if (playerEntry.path !== targetPath) {
    await rename(safeRoot(stage, playerEntry.path), safeRoot(stage, targetPath));
    playerEntry.path = targetPath;
  }

  const iconEntry = files.find((item) => item.origin === 'icon' && /\.ico$/i.test(item.path));
  if (!iconEntry) throw new Error('Windows icon generation did not produce an ICO resource.');
  const executablePath = safeRoot(stage, targetPath);
  const executable = ResEdit.NtExecutable.from(await readFile(executablePath));
  if (executable.newHeader.optionalHeader.subsystem !== 2) throw new Error('Windows release player must use the GUI subsystem.');
  const resources = ResEdit.NtExecutableResource.from(executable);
  const iconFile = ResEdit.Data.IconFile.from(await readFile(safeRoot(stage, iconEntry.path)));
  const iconGroups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, iconGroups[0]?.id ?? 101, 1033, iconFile.icons.map((item) => item.data));
  const versions = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  const version = versions[0] ?? ResEdit.Resource.VersionInfo.createEmpty();
  const versionParts = parseWindowsVersion(request.identity.versionName);
  version.setFileVersion(...versionParts, 1033);
  version.setProductVersion(...versionParts, 1033);
  version.setStringValues({ lang: 1033, codepage: 1200 }, {
    FileDescription: request.identity.displayName,
    FileVersion: request.identity.versionName,
    InternalName: executableName,
    OriginalFilename: targetPath,
    ProductName: request.identity.displayName,
    ProductVersion: request.identity.versionName,
  });
  version.outputToResourceEntries(resources.entries);
  resources.replaceResourceEntryFromString(24, 1, 1033, windowsManifest(request.identity.applicationId));
  resources.outputResource(executable);
  const output = Buffer.from(executable.generate());
  await writeFile(executablePath, output, { mode: playerEntry.mode });
  playerEntry.size = output.length;
  playerEntry.sha256 = sha256(output);

  const undeclaredDlls = files.filter((item) => /\.dll$/i.test(item.path) && item.origin !== 'native-dependency');
  if (undeclaredDlls.length) throw new Error(`Windows template contains undeclared DLL dependencies: ${undeclaredDlls.map((item) => item.path).join(', ')}`);
  if (!descriptor.windowsImports) throw new Error('Windows template must declare its imported DLL closure.');
  const stagedDlls = new Set(files.filter((item) => /\.dll$/i.test(item.path)).map((item) => path.posix.basename(item.path).toLowerCase()));
  const systemDlls = new Set([
    'advapi32.dll', 'bcrypt.dll', 'comdlg32.dll', 'crypt32.dll', 'd3d11.dll', 'dbghelp.dll',
    'dxgi.dll', 'gdi32.dll', 'imm32.dll', 'kernel32.dll', 'ntdll.dll', 'ole32.dll',
    'oleaut32.dll', 'rpcrt4.dll', 'secur32.dll', 'setupapi.dll', 'shell32.dll', 'shlwapi.dll',
    'user32.dll', 'userenv.dll', 'version.dll', 'winmm.dll', 'ws2_32.dll', 'winhttp.dll',
  ]);
  const missingImports = descriptor.windowsImports.filter((name) =>
    !stagedDlls.has(name) && !systemDlls.has(name) && !name.startsWith('api-ms-win-') && !name.startsWith('ext-ms-win-'),
  );
  if (missingImports.length) throw new Error(`Windows player has unresolved non-system DLL imports: ${missingImports.join(', ')}`);

  const symbolEntries = descriptor.files.filter((item) => item.role === 'symbol' || /\.pdb$/i.test(item.path));
  const symbolFiles: Array<{ path: string; data: Buffer }> = [];
  for (const symbol of symbolEntries) {
    const entry = files.find((item) => item.path === symbol.path);
    if (!entry) continue;
    symbolFiles.push({ path: path.posix.basename(entry.path), data: await readFile(safeRoot(stage, entry.path)) });
    await rm(safeRoot(stage, entry.path), { force: true });
    files.splice(files.indexOf(entry), 1);
  }
  files.push(await writeGenerated(stage, 'WINDOWS_METADATA.json', `${JSON.stringify({
    applicationId: request.identity.applicationId,
    executable: targetPath,
    buildId: descriptor.buildId,
    resourceMutationComplete: true,
    signingBoundary: 'No executable or DLL mutation is permitted after this point.',
    signingCommandHook: { supported: true, configured: Boolean(request.windowsSigning) },
  }, null, 2)}\n`, 'windows-metadata'));
  return { targetPath, symbolFiles };
}

async function runWindowsSigningHook(stage: string, request: PlatformStageRequest, files: StagedFileEntry[], executablePath: string) {
  if (request.profile.target !== 'windows' || !request.windowsSigning) return;
  const absoluteExecutable = safeRoot(stage, executablePath);
  const args = request.windowsSigning.args.map((value) => value
    .replaceAll('{executable}', absoluteExecutable)
    .replaceAll('{stage}', path.resolve(stage)));
  await run(request.windowsSigning.command, args, { cwd: stage });
  const entry = files.find((item) => item.path === executablePath);
  if (!entry) throw new Error('Signed Windows executable is missing from the staged file manifest.');
  const signed = await readFile(absoluteExecutable);
  entry.size = signed.length;
  entry.sha256 = sha256(signed);
}

async function finalizeWebStage(stage: string, request: PlatformStageRequest, files: StagedFileEntry[]) {
  if (request.profile.target !== 'web') return undefined;
  const profile = request.profile.web;
  const find = (suffix: string) => files.find((item) => item.path === suffix || item.path.endsWith(`/${suffix}`));
  const script = find('player.js');
  const wasm = find('player.wasm');
  const data = find('player.data');
  const packageEntry = files.find((item) => item.origin === 'runtime-package');
  if (!script || !wasm || !data || !packageEntry) throw new Error('Web template must contain player.js, player.wasm, and player.data plus the runtime package.');

  for (const entry of [script, wasm, data, packageEntry]) {
    const extension = path.posix.extname(entry.path);
    const stem = path.posix.basename(entry.path, extension);
    const target = `${stem}.${entry.sha256.slice(0, 16)}${extension}`;
    await rename(safeRoot(stage, entry.path), safeRoot(stage, target));
    entry.path = target;
  }

  const basePath = profile.basePath;
  const manifestId = request.identity.webManifestId ?? `/${encodeURIComponent(request.identity.applicationId)}`;
  const shortName = request.identity.shortName ?? request.identity.displayName;
  const themeColor = request.identity.themeColor ?? '#111827';
  const backgroundColor = request.identity.backgroundColor ?? '#000000';
  const allWebIcons = files.filter((item) => item.origin === 'icon');
  for (const entry of allWebIcons) {
    const extension = path.posix.extname(entry.path);
    const directory = path.posix.dirname(entry.path);
    const stem = path.posix.basename(entry.path, extension);
    const target = path.posix.join(directory, `${stem}.${entry.sha256.slice(0, 16)}${extension}`);
    await rename(safeRoot(stage, entry.path), safeRoot(stage, target));
    entry.path = target;
  }
  const iconEntries = allWebIcons.filter((item) => /icon-(192|512)\.[0-9a-f]{16}\.png$/.test(item.path));
  const icon = (size: number) => iconEntries.find((item) => new RegExp(`icon-${size}\\.[0-9a-f]{16}\\.png$`).test(item.path))?.path;
  const webManifest = {
    id: manifestId,
    name: request.identity.displayName,
    short_name: shortName,
    start_url: basePath,
    scope: basePath,
    display: profile.display,
    orientation: request.display.orientation,
    theme_color: themeColor,
    background_color: backgroundColor,
    ...(request.identity.defaultLocale ? { lang: request.identity.defaultLocale } : {}),
    icons: [192, 512].flatMap((size) => icon(size) ? [{ src: `${basePath}${icon(size)}`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any maskable' }] : []),
  };
  files.push(await writeGenerated(stage, 'manifest.webmanifest', `${JSON.stringify(webManifest, null, 2)}\n`, 'web-manifest'));

  const immutable = [script.path, wasm.path, data.path, packageEntry.path, ...allWebIcons.map((item) => item.path)];
  const exportHash = sha256(Buffer.from(immutable.map((item) => files.find((file) => file.path === item)?.sha256 ?? '').join(''))).slice(0, 20);
  const cachePrefix = `noveltea-${request.identity.applicationId.replace(/[^a-zA-Z0-9._-]/g, '_')}-`;
  const serviceWorker = profile.pwa && profile.serviceWorker === 'offline' ? `
const CACHE = ${JSON.stringify(`${cachePrefix}${exportHash}`)};
const PREFIX = ${JSON.stringify(cachePrefix)};
const ASSETS = ${JSON.stringify(['./', './index.html', './player.json', './manifest.webmanifest', ...immutable.map((item) => `./${item}`)])};
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => { if (event.request.method === 'GET') event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request))); });
` : '';
  if (serviceWorker) files.push(await writeGenerated(stage, 'service-worker.js', serviceWorker.trimStart(), 'web-service-worker'));

  const favicon = allWebIcons.find((item) => /favicon\.[0-9a-f]{16}\.ico$/.test(item.path))?.path;
  const index = `<!doctype html>
<html lang="${htmlEscape(request.identity.defaultLocale ?? 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${htmlEscape(request.identity.displayName)}</title><link rel="manifest" href="${basePath}manifest.webmanifest">${favicon ? `<link rel="icon" href="${basePath}${favicon}">` : ''}<meta name="theme-color" content="${themeColor}"><style>html,body,#canvas{width:100%;height:100%;margin:0;background:${backgroundColor}}body{overflow:hidden;font-family:system-ui,sans-serif}#launch,#failure{position:fixed;inset:0;display:grid;place-content:center;text-align:center;padding:2rem;background:${backgroundColor};color:white;z-index:2}#failure{display:none}button{font:inherit;padding:.8rem 1.2rem}</style></head><body><canvas id="canvas" tabindex="-1"></canvas><div id="launch"><h1>${htmlEscape(request.identity.displayName)}</h1><button id="start">Start</button></div><div id="failure"><h1>Unable to start</h1><p id="failure-message"></p></div><script>
const fail=m=>{document.getElementById('launch').style.display='none';document.getElementById('failure').style.display='grid';document.getElementById('failure-message').textContent=m};
if(!window.WebAssembly||!document.createElement('canvas').getContext('webgl2')) fail('This browser does not support WebAssembly and WebGL 2.');
document.getElementById('start').addEventListener('click',()=>{document.getElementById('launch').style.display='none';window.Module={canvas:document.getElementById('canvas'),locateFile:p=>p==='player.wasm'?${JSON.stringify(`${basePath}${wasm.path}`)}:p==='player.data'?${JSON.stringify(`${basePath}${data.path}`)}:basePath+p,onNovelTeaStartupError:fail};const s=document.createElement('script');s.src=${JSON.stringify(`${basePath}${script.path}`)};s.onerror=()=>fail('The player could not be downloaded.');document.body.appendChild(s)});
${serviceWorker ? `if('serviceWorker' in navigator) navigator.serviceWorker.register(${JSON.stringify(`${basePath}service-worker.js`)}, {scope:${JSON.stringify(basePath)}}).catch(error=>console.warn('[service-worker]',error));` : ''}
</script></body></html>\n`;
  files.push(await writeGenerated(stage, 'index.html', index, 'web-shell'));
  const deployment = `# Web deployment\n\nServe this directory over HTTPS (localhost is also accepted by browsers). Opening index.html through file:// is unsupported.\n\nBase path: \`${basePath}\`\n\nRequired MIME types:\n- .wasm: application/wasm\n- .js: text/javascript\n- .ntpkg: application/octet-stream\n- .webmanifest: application/manifest+json\n\nUse long-lived immutable caching for content-hashed .js, .wasm, .ntpkg, and icon files. Serve index.html, player.json, and manifest.webmanifest with revalidation. Enable Brotli or gzip compression for JavaScript and Wasm.\n\nHTTPS required: ${profile.pwa ? 'yes (PWA/service-worker behavior)' : 'recommended'}\nService worker: ${serviceWorker ? 'offline cache enabled' : 'disabled'}\nCross-origin isolation: ${profile.threaded ? 'required; send COOP: same-origin and COEP: require-corp' : 'not required'}\n`;
  files.push(await writeGenerated(stage, 'DEPLOYMENT.md', deployment, 'web-deployment'));

  const downloadable = await Promise.all([script, wasm, data, packageEntry].map(async (entry) => readFile(safeRoot(stage, entry.path))));
  return {
    compressedDownloadBytes: downloadable.reduce((sum, data) => sum + gzipSync(data).length, 0),
    uncompressedPackageBytes: packageEntry.size,
    estimatedPeakStartupBytes: packageEntry.size * 2 + wasm.size + data.size,
  };
}

export async function stagePlatformExport(request: PlatformStageRequest): Promise<PlatformStageResult> {
  const diagnostics: PlatformStageDiagnostic[] = [];
  const temp = `${request.outputDirectory}.tmp-${request.operationId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const backup = `${request.outputDirectory}.previous-${request.operationId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const archivePath = request.profile.target === 'web' || request.profile.target === 'windows' || request.profile.target === 'macos'
    ? `${request.outputDirectory}.zip`
    : request.profile.target === 'linux' ? `${request.outputDirectory}.tar.gz` : undefined;
  const archiveTemp = archivePath ? `${archivePath}.tmp-${request.operationId.replace(/[^a-zA-Z0-9_-]/g, '_')}` : undefined;
  const archiveBackup = archivePath ? `${archivePath}.previous-${request.operationId.replace(/[^a-zA-Z0-9_-]/g, '_')}` : undefined;
  const macosArchiveRoot = request.profile.target === 'macos' ? `${temp}.archive-root` : undefined;
  const symbolArchivePath = (request.profile.target === 'windows' || request.profile.target === 'linux' || request.profile.target === 'macos') && request.profile.includeDebugSymbols
    ? `${request.outputDirectory}-symbols.${request.profile.target === 'linux' ? 'tar.gz' : 'zip'}` : undefined;
  const symbolArchiveTemp = symbolArchivePath ? `${symbolArchivePath}.tmp-${request.operationId.replace(/[^a-zA-Z0-9_-]/g, '_')}` : undefined;
  const symbolArchiveBackup = symbolArchivePath ? `${symbolArchivePath}.previous-${request.operationId.replace(/[^a-zA-Z0-9_-]/g, '_')}` : undefined;
  const appImagePath = request.profile.target === 'linux' && request.profile.desktop.artifact === 'appimage'
    ? `${request.outputDirectory}.AppImage` : undefined;
  const appImageTemp = appImagePath ? `${appImagePath}.tmp-${request.operationId.replace(/[^a-zA-Z0-9_-]/g, '_')}` : undefined;
  const appImageBackup = appImagePath ? `${appImagePath}.previous-${request.operationId.replace(/[^a-zA-Z0-9_-]/g, '_')}` : undefined;
  const dmgPath = request.profile.target === 'macos' && request.macosDmg ? `${request.outputDirectory.replace(/\.app$/i, '')}.dmg` : undefined;
  const dmgTemp = dmgPath ? `${dmgPath}.tmp-${request.operationId.replace(/[^a-zA-Z0-9_-]/g, '_')}` : undefined;
  const dmgBackup = dmgPath ? `${dmgPath}.previous-${request.operationId.replace(/[^a-zA-Z0-9_-]/g, '_')}` : undefined;
  let backedUp = false;
  let archiveBackedUp = false;
  let symbolArchiveBackedUp = false;
  let appImageBackedUp = false;
  let dmgBackedUp = false;
  try {
    checkPlatformExportCancelled(request.operationId);
    if (request.runtimePackageReadiness?.validated !== true || request.runtimePackageReadiness.blockingDiagnosticCount !== 0) {
      return {
        ok: false,
        success: false,
        cancelled: false,
        operationId: request.operationId,
        diagnostics: [diagnostic(
          'runtime-package-not-ready',
          '/runtimePackageReadiness',
          'Platform staging requires a runtime package produced by a successful validation and conversion workflow with no blocking diagnostics.',
        )],
      };
    }
    let descriptor;
    let templateRoot;
    try { templateRoot = templateRootForToken(request.templateToken); ({ descriptor } = await verifyTemplateToken(request.templateToken)); }
    catch (error) { return { ok: false, success: false, cancelled: false, operationId: request.operationId, diagnostics: [diagnostic('invalid-installed-template', '/templateToken', error instanceof Error ? error.message : String(error))] }; }
    const built = buildPlatformDeployment(request, descriptor); diagnostics.push(...built.diagnostics);
    if (!built.model) return { ok: false, success: false, cancelled: false, operationId: request.operationId, diagnostics };
    if (!existsSync(request.packagePath)) diagnostics.push(diagnostic('missing-package', '/packagePath', 'Runtime package does not exist.'));
    if (!request.iconSourcePath) diagnostics.push(diagnostic('missing-icon', '/iconSourcePath', 'Application icon is required for platform staging.'));
    else if (!existsSync(request.iconSourcePath)) diagnostics.push(diagnostic('missing-icon', '/iconSourcePath', 'Application icon does not exist.'));
    const templateFiles = (await listFiles(templateRoot)).filter((file) => file !== descriptorName && file !== '.noveltea-template.json');
    for (const file of templateFiles) if (forbidden.test(file)) diagnostics.push(diagnostic('sandbox-content', `/template/${file}`, `Sandbox/demo content '${file}' is forbidden.`));
    for (const dependency of descriptor.runtimeDependencies) if (!templateFiles.includes(dependency.path)) diagnostics.push(diagnostic('missing-template-dependency', `/template/${dependency.path}`, `Declared template dependency '${dependency.path}' is missing.`));
    const prospective = [...templateFiles.map((targetPath) => ({ sourceId: `template:${targetPath}`, targetPath })), { sourceId: 'runtime-package', targetPath: 'game.ntpkg' }];
    diagnostics.push(...validateTargetPaths(prospective, request.profile.target).map((item) => diagnostic(item.code, '/staging', item.message)));
    if (diagnostics.some((item) => item.severity === 'error')) return { ok: false, success: false, cancelled: false, operationId: request.operationId, diagnostics, deployment: built.model };
    let estimated = (await stat(request.packagePath)).size;
    for (const file of templateFiles) estimated += (await stat(safeRoot(templateRoot, file))).size;
    const disk = await statfs(path.dirname(path.resolve(request.outputDirectory))); if (Number(disk.bavail) * Number(disk.bsize) < estimated * 2) return { ok: false, success: false, cancelled: false, operationId: request.operationId, diagnostics: [diagnostic('insufficient-disk-space', '/outputDirectory', 'Not enough disk space to build and atomically replace staging output.')], deployment: built.model };
    await rm(temp, { recursive: true, force: true }); await rm(backup, { recursive: true, force: true }); await mkdir(temp, { recursive: true });
    const files: StagedFileEntry[] = []; const dependencyKinds = new Map(descriptor.runtimeDependencies.map((item) => [item.path, item.kind === 'notice' ? 'notice' as const : item.kind === 'library' ? 'native-dependency' as const : 'system-asset' as const]));
    for (const file of templateFiles) { checkPlatformExportCancelled(request.operationId); files.push(await copyFileTracked(safeRoot(templateRoot, file), temp, file, classifyTemplate(file, dependencyKinds), `template:${descriptor.templateId}`)); }
    files.push(await copyFileTracked(request.packagePath, temp, 'game.ntpkg', 'runtime-package', 'game.ntpkg'));
    if (request.systemAssetsRoot) for (const file of await listFiles(request.systemAssetsRoot)) { checkPlatformExportCancelled(request.operationId); files.push(await copyFileTracked(safeRoot(request.systemAssetsRoot, file), temp, path.posix.join('assets/system', file), 'system-asset', file)); }
    checkPlatformExportCancelled(request.operationId);
    const iconResult = await generateAppIcons({ sourcePath: request.iconSourcePath!, stagingRoot: path.join(temp, '.icons'), platforms: [request.profile.target === 'linux' ? 'linux' : request.profile.target === 'web' ? 'web' : request.profile.target === 'android' ? 'android' : request.profile.target === 'windows' ? 'windows' : 'macos'] });
    diagnostics.push(...iconResult.diagnostics.map((item) => ({ severity: item.severity, code: item.code, path: '/icon', message: item.message })));
    const iconTargets = iconResult.files.map((icon) => path.posix.join('icons', path.relative(path.join(temp, '.icons'), icon.path).split(path.sep).join('/')));
    const allTargets = [...files.map((item) => ({ sourceId: item.originId, targetPath: item.path })), ...iconTargets.map((targetPath) => ({ sourceId: `icon:${targetPath}`, targetPath })), { sourceId: 'player-config', targetPath: 'player.json' }, { sourceId: 'export-manifest', targetPath: 'export-manifest.json' }];
    diagnostics.push(...validateTargetPaths(allTargets, request.profile.target).map((item) => diagnostic(item.code, '/staging', item.message)));
    if (diagnostics.some((item) => item.severity === 'error')) throw new Error('NOVELTEA_EXPORT_DIAGNOSTIC');
    for (let index = 0; index < iconResult.files.length; index += 1) { const icon = iconResult.files[index]!; files.push(await copyFileTracked(icon.path, temp, iconTargets[index]!, 'icon', icon.kind)); }
    await rm(path.join(temp, '.icons'), { recursive: true, force: true });
    const webMetrics = await finalizeWebStage(temp, request, files);
    const windows = await finalizeWindowsStage(temp, request, files, descriptor);
    const linux = await finalizeLinuxStage(temp, request, files, descriptor);
    const macos = await finalizeMacosStage(temp, { ...request, capabilities: built.model.capabilities }, files, descriptor);
    if (windows) await runWindowsSigningHook(temp, request, files, windows.targetPath);
    const packageEntry = files.find((item) => item.origin === 'runtime-package')!;
    const playerConfigPath = linux ? path.posix.join(path.posix.dirname(linux.executablePath), 'player.json')
      : macos ? 'Contents/Resources/player.json' : 'player.json';
    const packageFromConfig = path.posix.relative(path.posix.dirname(playerConfigPath), packageEntry.path);
    const player = { format: 'noveltea.player-config', formatVersion: 1, displayName: built.model.displayName, applicationId: built.model.applicationId, saveNamespace: built.model.saveNamespace, versionName: built.model.versionName, ...(request.identity.defaultLocale ? { defaultLocale: request.identity.defaultLocale } : {}), package: { path: packageFromConfig, sha256: packageEntry.sha256, runtimePackageApi: request.runtimePackageApi }, capabilities: built.model.capabilities, display: built.model.display };
    const playerData = Buffer.from(`${JSON.stringify(player, null, 2)}\n`); await writeFile(safeRoot(temp, playerConfigPath), playerData); files.push({ path: playerConfigPath, origin: 'generated-metadata', originId: 'player-config', size: playerData.length, mode: 0o644, sha256: sha256(playerData) });
    files.sort((a, b) => a.path.localeCompare(b.path));
    const manifest: PlatformExportManifest = { format: PLATFORM_EXPORT_MANIFEST_FORMAT, formatVersion: PLATFORM_EXPORT_MANIFEST_FORMAT_VERSION, deployment: built.model, files };
    const manifestPath = request.profile.target === 'macos' ? 'Contents/Resources/export-manifest.json' : 'export-manifest.json';
    await writeFile(safeRoot(temp, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 }); checkPlatformExportCancelled(request.operationId);
    const symbolFiles = windows?.symbolFiles ?? linux?.symbolFiles ?? macos?.symbolFiles ?? [];
    if (symbolArchivePath && symbolArchiveTemp && symbolFiles.length) {
      const symbolStage = `${temp}.symbols`;
      await rm(symbolStage, { recursive: true, force: true });
      await mkdir(symbolStage, { recursive: true });
      for (const symbol of symbolFiles) {
        const target = path.join(symbolStage, symbol.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, symbol.data, { mode: 0o644 });
      }
      await writeFile(path.join(symbolStage, 'BUILD_ID'), `${descriptor.buildId}\n`, { mode: 0o644 });
      await rm(symbolArchiveTemp, { force: true });
      if (request.profile.target === 'linux') await run('cmake', ['-E', 'tar', 'czf', symbolArchiveTemp, '.'], { cwd: symbolStage });
      else await run('cmake', ['-E', 'tar', 'cf', symbolArchiveTemp, '--format=zip', '.'], { cwd: symbolStage });
      await rm(symbolStage, { recursive: true, force: true });
    checkPlatformExportCancelled(request.operationId);
    }
    if (linux && appImageTemp) {
      await buildLinuxAppImage(temp, appImageTemp, request, linux);
    checkPlatformExportCancelled(request.operationId);
    }
    if (macos && request.macosSigning) {
      if (process.platform !== 'darwin') throw new Error('macOS signing requires a macOS host.');
      for (const frameworkPath of macos.frameworkPaths) {
        await run('codesign', ['--force', '--options', 'runtime', '--sign', request.macosSigning.identity, safeRoot(temp, frameworkPath)]);
      }
      const signingArgs = ['--force', '--options', 'runtime'];
      let generatedEntitlementsPath: string | undefined;
      const entitlements = request.macosSigning.entitlementsPath ?? (macos.entitlements ? `${temp}.entitlements.plist` : undefined);
      if (!request.macosSigning.entitlementsPath && macos.entitlements && entitlements) {
        generatedEntitlementsPath = entitlements;
        await writeFile(generatedEntitlementsPath, macos.entitlements, { mode: 0o600 });
      }
      if (entitlements) signingArgs.push('--entitlements', entitlements);
      signingArgs.push('--sign', request.macosSigning.identity, temp);
      try {
        await run('codesign', signingArgs);
        await run('codesign', ['--verify', '--deep', '--strict', temp]);
      } finally {
        if (generatedEntitlementsPath) await rm(generatedEntitlementsPath, { force: true });
      }
    }
    if (macos && request.macosNotarization) {
      if (!request.macosSigning) throw new Error('macOS notarization requires a signed bundle.');
      await run(request.macosNotarization.command, [...request.macosNotarization.args, temp]);
      if (process.platform === 'darwin') {
        await run('xcrun', ['stapler', 'staple', temp]);
        await run('xcrun', ['stapler', 'validate', temp]);
        await run('codesign', ['--verify', '--deep', '--strict', temp]);
        await run('spctl', ['--assess', '--type', 'execute', '--verbose=2', temp]);
      }
    }
    if (archivePath && archiveTemp) {
      await rm(archiveTemp, { force: true });
      if (request.profile.target === 'linux') await run('cmake', ['-E', 'tar', 'czf', archiveTemp, '.'], { cwd: temp });
      else if (request.profile.target === 'macos' && macosArchiveRoot) {
        await rm(macosArchiveRoot, { recursive: true, force: true });
        await mkdir(macosArchiveRoot, { recursive: true });
        const appName = path.basename(request.outputDirectory);
        await run('cmake', ['-E', 'copy_directory', temp, path.join(macosArchiveRoot, appName)]);
        await run('cmake', ['-E', 'tar', 'cf', archiveTemp, '--format=zip', appName], { cwd: macosArchiveRoot });
        await rm(macosArchiveRoot, { recursive: true, force: true });
      } else await run('cmake', ['-E', 'tar', 'cf', archiveTemp, '--format=zip', '.'], { cwd: temp });
    checkPlatformExportCancelled(request.operationId);
    }
    if (macos && dmgTemp && request.macosDmg) {
      await rm(dmgTemp, { force: true });
      await run(request.macosDmg.command, [...request.macosDmg.args, temp, dmgTemp]);
      checkPlatformExportCancelled(request.operationId);
    }
    if (existsSync(request.outputDirectory)) { await rename(request.outputDirectory, backup); backedUp = true; }
    if (archivePath && archiveBackup && existsSync(archivePath)) { await rename(archivePath, archiveBackup); archiveBackedUp = true; }
    if (symbolArchivePath && symbolArchiveBackup && existsSync(symbolArchivePath)) { await rename(symbolArchivePath, symbolArchiveBackup); symbolArchiveBackedUp = true; }
    if (appImagePath && appImageBackup && existsSync(appImagePath)) { await rename(appImagePath, appImageBackup); appImageBackedUp = true; }
    if (dmgPath && dmgBackup && existsSync(dmgPath)) { await rename(dmgPath, dmgBackup); dmgBackedUp = true; }
    try {
      await rename(temp, request.outputDirectory);
      if (archivePath && archiveTemp) await rename(archiveTemp, archivePath);
      if (symbolArchivePath && symbolArchiveTemp && existsSync(symbolArchiveTemp)) await rename(symbolArchiveTemp, symbolArchivePath);
      if (appImagePath && appImageTemp) await rename(appImageTemp, appImagePath);
      if (dmgPath && dmgTemp) await rename(dmgTemp, dmgPath);
    } catch (error) {
      await rm(request.outputDirectory, { recursive: true, force: true });
      if (archivePath) await rm(archivePath, { force: true });
      if (symbolArchivePath) await rm(symbolArchivePath, { force: true });
      if (appImagePath) await rm(appImagePath, { force: true });
      if (dmgPath) await rm(dmgPath, { force: true });
      if (backedUp && existsSync(backup)) await rename(backup, request.outputDirectory);
      if (archiveBackedUp && archiveBackup && existsSync(archiveBackup)) await rename(archiveBackup, archivePath!);
      if (symbolArchiveBackedUp && symbolArchiveBackup && existsSync(symbolArchiveBackup)) await rename(symbolArchiveBackup, symbolArchivePath!);
      if (appImageBackedUp && appImageBackup && existsSync(appImageBackup)) await rename(appImageBackup, appImagePath!);
      if (dmgBackedUp && dmgBackup && existsSync(dmgBackup)) await rename(dmgBackup, dmgPath!);
      throw error;
    }
    if (backedUp) await rm(backup, { recursive: true, force: true });
    if (archiveBackedUp && archiveBackup) await rm(archiveBackup, { force: true });
    if (symbolArchiveBackedUp && symbolArchiveBackup) await rm(symbolArchiveBackup, { force: true });
    if (appImageBackedUp && appImageBackup) await rm(appImageBackup, { force: true });
    if (dmgBackedUp && dmgBackup) await rm(dmgBackup, { force: true });
    const artifacts: NonNullable<PlatformStageResult['artifacts']> = [{ kind: 'directory', path: request.outputDirectory }];
    if (archivePath) artifacts.push({ kind: 'archive', path: archivePath, size: (await stat(archivePath)).size });
    if (appImagePath) artifacts.push({ kind: 'appimage', path: appImagePath, size: (await stat(appImagePath)).size });
    if (request.profile.target === 'macos') artifacts[0] = { kind: 'app-bundle', path: request.outputDirectory };
    if (dmgPath) artifacts.push({ kind: 'dmg', path: dmgPath, size: (await stat(dmgPath)).size });
    if (symbolArchivePath && existsSync(symbolArchivePath)) artifacts.push({ kind: 'symbols', path: symbolArchivePath, size: (await stat(symbolArchivePath)).size });
    return { ok: true, success: true, cancelled: false, operationId: request.operationId, outputDirectory: request.outputDirectory, archivePath, symbolArchivePath: symbolArchivePath && existsSync(symbolArchivePath) ? symbolArchivePath : undefined, artifacts, webMetrics, diagnostics, deployment: built.model, manifest };
  } catch (error) {
    const cancelled = error instanceof Error && error.message === 'NOVELTEA_EXPORT_CANCELLED';
    if (!cancelled && !(error instanceof Error && error.message === 'NOVELTEA_EXPORT_DIAGNOSTIC')) diagnostics.push(diagnostic('staging-failed', '/staging', error instanceof Error ? error.message : String(error)));
    await rm(temp, { recursive: true, force: true });
    if (archiveTemp) await rm(archiveTemp, { force: true });
    if (macosArchiveRoot) await rm(macosArchiveRoot, { recursive: true, force: true });
    if (symbolArchiveTemp) await rm(symbolArchiveTemp, { force: true });
    if (appImageTemp) await rm(appImageTemp, { force: true });
    if (dmgTemp) await rm(dmgTemp, { force: true });
    if (backedUp && !existsSync(request.outputDirectory) && existsSync(backup)) await rename(backup, request.outputDirectory);
    if (archivePath && archiveBackedUp && archiveBackup && !existsSync(archivePath) && existsSync(archiveBackup)) await rename(archiveBackup, archivePath);
    if (symbolArchivePath && symbolArchiveBackedUp && symbolArchiveBackup && !existsSync(symbolArchivePath) && existsSync(symbolArchiveBackup)) await rename(symbolArchiveBackup, symbolArchivePath);
    if (appImagePath && appImageBackedUp && appImageBackup && !existsSync(appImagePath) && existsSync(appImageBackup)) await rename(appImageBackup, appImagePath);
    if (dmgPath && dmgBackedUp && dmgBackup && !existsSync(dmgPath) && existsSync(dmgBackup)) await rename(dmgBackup, dmgPath);
    return { ok: false, success: false, cancelled, operationId: request.operationId, diagnostics: cancelled ? [...diagnostics, { severity: 'info', code: 'cancelled', path: '/staging', message: 'Platform export was cancelled.' }] : diagnostics };
  } finally { clearPlatformExportCancellation(request.operationId); }
}

export function redactPlatformStageResult(value: unknown): unknown {
  const sensitive = /(?:path|directory|root|secret|password|credential|keystore|certificate)/i;
  const visit = (item: unknown, key = ''): unknown => {
    if (sensitive.test(key)) return '<redacted>';
    if (Array.isArray(item)) return item.map((entry) => visit(entry));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, visit(entry, name)]));
    return item;
  };
  return visit(value);
}
