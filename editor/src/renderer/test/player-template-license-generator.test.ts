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

function generate(root: string) {
  const build = path.join(root, 'build');
  const stage = path.join(root, 'stage');
  mkdirSync(stage, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [generator, path.join(build, 'vcpkg_installed'), stage, 'v0.1.0', build],
    { encoding: 'utf8' },
  );
  return { result, stage };
}

function webFixture() {
  const root = directory();
  const build = path.join(root, 'build');
  const emsdk = path.join(root, 'emsdk');
  write(build, 'CMakeCache.txt', `EMSDK:PATH=${emsdk}\n`);
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
    const installed = [...rules.vcpkgRuntimeRoots, ...rules.vcpkgLinuxRoots];
    const names = [...installed, 'catch2', 'imgui', 'vcpkg-cmake'];
    const text = Buffer.from('MIT License\r\nOriginal source\r\n');
    write(
      build,
      'vcpkg_installed/vcpkg/status',
      names
        .map(
          (name) =>
            `Package: ${name}\nVersion: 1.0.0\nArchitecture: ${name.startsWith('vcpkg-') ? 'x64-linux' : target}\nStatus: install ok installed\n`,
        )
        .join('\n'),
    );
    for (const name of names)
      write(build, `vcpkg_installed/${target}/share/${name}/copyright`, text);
    const { result, stage } = generate(root);
    expect(result.status, result.stderr).toBe(0);
    const index = getIndex(stage);
    expect(index.components.some((item) => item.component === 'sdl3')).toBe(true);
    expect(index.components.some((item) => item.component === 'dbus')).toBe(true);
    expect(index.components.some((item) => item.component === 'catch2')).toBe(false);
    expect(index.components.some((item) => item.component === 'imgui')).toBe(false);
    expect(index.components.some((item) => item.component === 'vcpkg-cmake')).toBe(false);
    const sdl = index.components.find((item) => item.component === 'sdl3')!;
    expect(readFileSync(path.join(stage, sdl.files[0]!.path))).toEqual(text);
  });
});
