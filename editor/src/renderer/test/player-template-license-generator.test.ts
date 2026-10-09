import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';

const generator = path.resolve(process.cwd(), '../cmake/generate-player-template-metadata.mjs');
const rules = JSON.parse(
  readFileSync(path.resolve(process.cwd(), '../cmake/player-license-sources.json'), 'utf8'),
) as {
  vcpkgRuntimeRoots: string[];
  vcpkgLinuxRoots: string[];
  fetched: Record<
    string,
    {
      player?: boolean;
      version?: string;
      paths?: string[];
      evidence?: string;
      components?: Array<{ name: string; paths: string[] }>;
    }
  >;
  emscriptenPorts: Record<string, { versionPattern: string; paths: string[] }>;
};
const roots: string[] = [];
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { force: true, recursive: true });
});

function directory() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nt-player-license-generator-'));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, bytes: Buffer | string) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

function generate(root: string, android = false) {
  const build = path.join(root, 'build');
  const stage = path.join(root, 'stage');
  mkdirSync(stage, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [
      generator,
      path.join(build, 'vcpkg_installed'),
      stage,
      'v0.1.0',
      build,
      ...(android ? ['--android'] : []),
    ],
    { encoding: 'utf8' },
  );
  return { result, stage };
}

function webFixture() {
  const root = directory();
  const build = path.join(root, 'build');
  const emsdk = path.join(root, 'emsdk');
  write(build, 'CMakeCache.txt', `EMSDK:PATH=${emsdk}\n`);
  write(
    build,
    'runtime-assets/system/fonts/LiberationSans.ttf',
    readFileSync(path.resolve(process.cwd(), '../engine/assets/system/fonts/LiberationSans.ttf')),
  );
  const licenseBytes = Buffer.from('MIT License\r\nCopyright \xc2\xa9 Test\r\n', 'utf8');
  for (const [name, rule] of Object.entries(rules.fetched)) {
    if (rule.player === false) continue;
    const sourceRoot = path.join(build, '_deps', `${name}-src`);
    mkdirSync(sourceRoot, { recursive: true });
    for (const relative of rule.paths ??
      rule.components?.flatMap((part) => part.paths) ?? ['LICENSE']) {
      if (relative.startsWith('@repo/')) continue;
      write(sourceRoot, relative, licenseBytes);
    }
    if (rule.evidence)
      write(sourceRoot, rule.evidence, 'Permission is hereby granted; Lua.org, PUC-Rio');
    if (!rule.version) {
      execFileSync('git', ['init', '-q', sourceRoot]);
      execFileSync('git', [
        '-C',
        sourceRoot,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '--allow-empty',
        '-qm',
        'pinned test revision',
      ]);
    }
  }
  write(
    build,
    '_deps/rmlui_bgfx-src/CMakeLists.txt',
    '# Player integration: no separate library license',
  );
  write(build, '_deps/imgui-src/LICENSE.txt', 'MIT License\nExcluded host-only code\n');
  for (const [name, rule] of Object.entries(rules.emscriptenPorts)) {
    const directoryName = (
      {
        sdl3: 'SDL-release-3.4.2',
        freetype: 'freetype-VER-2-13-3',
        libpng: 'libpng-1.6.58',
        zlib: 'zlib-1.3.2',
      } as Record<string, string>
    )[name];
    for (const license of rule.paths) {
      write(
        emsdk,
        `upstream/emscripten/cache/ports/${name}/${directoryName}/${license}`,
        licenseBytes,
      );
    }
  }
  return { root, build, emsdk, licenseBytes };
}

function androidFixture() {
  const fixture = webFixture();
  const stage = path.join(fixture.root, 'stage');
  const sdlAar = 'source/android/app/libs/SDL3-3.4.10.aar';
  const prefabRoot = path.join(fixture.root, 'sdl-prefab');
  write(prefabRoot, 'prefab/prefab.json', JSON.stringify({ name: 'SDL3', version: '3.4.10' }));
  mkdirSync(path.dirname(path.join(stage, sdlAar)), { recursive: true });
  execFileSync('zip', ['-q', path.join(stage, sdlAar), 'prefab/prefab.json'], {
    cwd: prefabRoot,
  });
  write(
    stage,
    'source/android/prebuilt-system/fonts/LiberationSans.ttf',
    readFileSync(path.resolve(process.cwd(), '../engine/assets/system/fonts/LiberationSans.ttf')),
  );
  write(stage, 'source/android/prebuilt-native/x86_64/libSDL3.so', 'sdl native fixture');
  write(stage, 'source/android/prebuilt-native/x86_64/libnoveltea-player.so', 'player fixture');
  return { ...fixture, stage };
}

function getIndex(stage: string) {
  return JSON.parse(readFileSync(path.join(stage, 'licenses/index.json'), 'utf8')) as {
    components: Array<{
      component: string;
      version: string;
      files: Array<{
        path: string;
        size: number;
        sha256: string;
      }>;
    }>;
  };
}

describe('resolved player-template license generation', () => {
  it.skipIf(process.platform === 'win32')(
    'resolves deterministic Android ABI/flavor notices for the fetched and packaged dependency closure',
    () => {
      const fixture = androidFixture();
      const first = generate(fixture.root, true);
      expect(first.result.status, first.result.stderr).toBe(0);
      const index = getIndex(first.stage);
      const names = index.components.map((item) => item.component);
      for (const name of ['SDL3', 'bgfx', 'bx', 'bimg', 'freetype', 'lua', 'Liberation Sans'])
        expect(names).toContain(name);
      expect(names).not.toContain('imgui');
      expect(names).not.toContain('rmlui_bgfx');
      const sdl = index.components.find((item) => item.component === 'SDL3')!;
      expect(sdl.version).toBe('3.4.10');
      expect(readFileSync(path.join(first.stage, sdl.files[0]!.path))).toEqual(
        readFileSync(path.resolve(process.cwd(), '../cmake/licenses/sdl3-3.4.10-LICENSE.txt')),
      );
      const firstIndex = readFileSync(path.join(first.stage, 'licenses/index.json'));
      const firstSbom = readFileSync(path.join(first.stage, 'SBOM.cdx.json'));
      const second = generate(fixture.root, true);
      expect(second.result.status, second.result.stderr).toBe(0);
      expect(readFileSync(path.join(second.stage, 'licenses/index.json'))).toEqual(firstIndex);
      expect(readFileSync(path.join(second.stage, 'SBOM.cdx.json'))).toEqual(firstSbom);
      expect(
        JSON.parse(firstSbom.toString()).components.map((item: { name: string }) => item.name),
      ).toEqual(names);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects missing composite licenses and unmapped Android native or Java dependencies',
    () => {
      const fixture = androidFixture();
      expect(generate(fixture.root, true).result.status).toBe(0);
      const bimgLicense = path.join(fixture.build, '_deps/bgfx.cmake-src/bimg/LICENSE');
      rmSync(bimgLicense);
      expect(generate(fixture.root, true).result.stderr).toContain(
        'Required bimg license source missing',
      );
      writeFileSync(bimgLicense, fixture.licenseBytes);
      write(fixture.stage, 'source/android/prebuilt-native/x86_64/libunknown.so', 'unmapped');
      expect(generate(fixture.root, true).result.stderr).toContain(
        'Unmapped shipped Android native library',
      );
      rmSync(path.join(fixture.stage, 'source/android/prebuilt-native/x86_64/libunknown.so'));
      write(fixture.stage, 'source/android/app/libs/another-runtime.jar', 'unmapped');
      expect(generate(fixture.root, true).result.stderr).toContain(
        'Unmapped Android Java/AAR dependency',
      );
    },
  );
  it('produces byte-preserved, named composite notices and deterministic SBOM/index files', () => {
    const fixture = webFixture();
    const first = generate(fixture.root);
    expect(first.result.status, first.result.stderr).toBe(0);
    const index = getIndex(first.stage);
    for (const name of ['bgfx', 'bx', 'bimg', 'lua', 'Liberation Sans', 'freetype'])
      expect(index.components.some((item) => item.component === name)).toBe(true);
    expect(index.components.some((item) => item.component === 'imgui')).toBe(false);
    expect(index.components.some((item) => item.component === 'rmlui_bgfx')).toBe(false);
    const bgfx = index.components.find((item) => item.component === 'bgfx')!;
    expect(readFileSync(path.join(first.stage, bgfx.files[0]!.path))).toEqual(fixture.licenseBytes);
    expect(bgfx.files[0]!.sha256).toBe(hash(fixture.licenseBytes));
    const indexBytes = readFileSync(path.join(first.stage, 'licenses/index.json'));
    const sbomBytes = readFileSync(path.join(first.stage, 'SBOM.cdx.json'));
    const second = generate(fixture.root);
    expect(second.result.status, second.result.stderr).toBe(0);
    expect(readFileSync(path.join(second.stage, 'licenses/index.json'))).toEqual(indexBytes);
    expect(readFileSync(path.join(second.stage, 'SBOM.cdx.json'))).toEqual(sbomBytes);
    expect(
      JSON.parse(sbomBytes.toString()).components.map((item: { name: string }) => item.name),
    ).toEqual(index.components.map((item) => item.component));
  });

  it('fails if composite license text is missing or replaced by a placeholder', () => {
    const fixture = webFixture();
    const target = path.join(fixture.build, '_deps/bgfx.cmake-src/bimg/LICENSE');
    rmSync(target);
    expect(generate(fixture.root).result.stderr).toContain('Required bimg license source missing');
    writeFileSync(target, 'No dependency notice file was found in the resolved source tree.');
    expect(generate(fixture.root).result.stderr).toContain('placeholder text');
  });

  it('fails if Emscripten port version resolution is ambiguous', () => {
    const fixture = webFixture();
    write(
      fixture.emsdk,
      'upstream/emscripten/cache/ports/sdl3/SDL-release-3.5.0/LICENSE.txt',
      'MIT License',
    );
    expect(generate(fixture.root).result.stderr).toContain('Ambiguous Emscripten port sdl3');
  });

  it('uses installed target-vcpkg copyright text and omits host-only tools and tests', () => {
    const root = directory();
    const build = path.join(root, 'build');
    const target = 'x64-linux-noveltea';
    write(build, 'CMakeCache.txt', `VCPKG_TARGET_TRIPLET:STRING=${target}\n`);
    const bundledFont = readFileSync(
      path.resolve(process.cwd(), '../engine/assets/system/fonts/LiberationSans.ttf'),
    );
    write(build, 'runtime-assets/system/fonts/LiberationSans.ttf', bundledFont);
    const packagedFont = 'stage/assets/system/fonts/LiberationSans.ttf';
    write(root, packagedFont, bundledFont);
    const installed = [...rules.vcpkgRuntimeRoots, ...rules.vcpkgLinuxRoots];
    const names = [...installed, 'brotli', 'bzip2', 'expat', 'catch2', 'imgui', 'vcpkg-cmake'];
    const text = Buffer.from('MIT License\r\nOriginal source\r\n');
    const freeTypeText = Buffer.from('FreeType License\nPage one\fPage two\n');
    const statusEntries = names.map(
      (name) =>
        `Package: ${name}\nVersion: 1.0.0\n${name === 'dbus' ? 'Depends: expat\n' : ''}Architecture: ${name.startsWith('vcpkg-') ? 'x64-linux' : target}\nStatus: install ok installed\n`,
    );
    const featureEntries = [
      `Package: freetype\nFeature: brotli\nDepends: brotli\nArchitecture: ${target}\nStatus: install ok installed\n`,
      `Package: freetype\nFeature: bzip2\nDepends: bzip2\nArchitecture: ${target}\nStatus: install ok installed\n`,
      `Package: sdl3\nFeature: dbus\nDepends: dbus\nArchitecture: ${target}\nStatus: install ok installed\n`,
    ];
    const statusFile = 'vcpkg_installed/vcpkg/status';
    write(build, statusFile, [...statusEntries, ...featureEntries].join('\n'));
    for (const name of names) {
      const source = `vcpkg_installed/${target}/share/${name}/copyright`;
      write(build, source, name === 'freetype' ? freeTypeText : text);
    }
    const { result, stage } = generate(root);
    expect(result.status, result.stderr).toBe(0);
    const index = getIndex(stage);
    expect(index.components.some((item) => item.component === 'sdl3')).toBe(true);
    expect(index.components.some((item) => item.component === 'dbus')).toBe(true);
    for (const name of ['brotli', 'bzip2', 'expat'])
      expect(index.components.some((item) => item.component === name)).toBe(true);
    expect(index.components.some((item) => item.component === 'catch2')).toBe(false);
    expect(index.components.some((item) => item.component === 'imgui')).toBe(false);
    expect(index.components.some((item) => item.component === 'vcpkg-cmake')).toBe(false);
    const sdl = index.components.find((item) => item.component === 'sdl3')!;
    expect(readFileSync(path.join(stage, sdl.files[0]!.path))).toEqual(text);
    const freetype = index.components.find((item) => item.component === 'freetype')!;
    expect(readFileSync(path.join(stage, freetype.files[0]!.path))).toEqual(freeTypeText);

    rmSync(path.join(root, packagedFont));
    expect(generate(root).result.stderr).toContain('Required desktop template font is missing');
    write(root, packagedFont, bundledFont);

    // Installed target feature dependencies cannot silently disappear from the SBOM/notices.
    const withoutBrotli = statusEntries.filter((_, index) => names[index] !== 'brotli');
    write(build, statusFile, [...withoutBrotli, ...featureEntries].join('\n'));
    expect(generate(root).result.stderr).toContain('Missing installed player dependency brotli');

    write(build, statusFile, [...statusEntries, statusEntries[0], ...featureEntries].join('\n'));
    expect(generate(root).result.stderr).toContain('Ambiguous installed player dependency');
  });
});
