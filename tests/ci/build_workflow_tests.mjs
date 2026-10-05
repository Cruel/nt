import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/build.yml', import.meta.url), 'utf8');
const releaseWorkflow = readFileSync(
  new URL('../../.github/workflows/release.yml', import.meta.url),
  'utf8',
);
const cmakePresets = JSON.parse(
  readFileSync(new URL('../../CMakePresets.json', import.meta.url), 'utf8'),
);
const rootCmake = readFileSync(new URL('../../CMakeLists.txt', import.meta.url), 'utf8');
const playerCmake = readFileSync(new URL('../../apps/player/CMakeLists.txt', import.meta.url), 'utf8');
const vcpkg = readFileSync(
  new URL('../../.github/actions/setup-linux-vcpkg/action.yml', import.meta.url),
  'utf8',
);
const cliBuildScript = readFileSync(
  new URL('../../editor/scripts/build-noveltea-cli.mjs', import.meta.url),
  'utf8',
);

function job(name) {
  const match = workflow.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'm'));
  assert.ok(match, `Missing job ${name}`);
  return match[0];
}

function step(source, name) {
  const start = source.indexOf(`- name: ${name}\n`);
  assert.notEqual(start, -1, `Missing step ${name}`);
  const end = source.indexOf('- name: ', start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

function field(source, name) {
  const match = source.match(new RegExp(`^\\s+${name}: (.+)$`, 'm'));
  assert.ok(match, `Missing field ${name}`);
  return match[1];
}

test('CLI certification receives same-run shader headers without depending on caches', () => {
  const producer = job('linux-cli');
  const consumer = job('linux-cli-certify');
  const upload = step(producer, 'Upload CLI certification shader headers');
  const download = step(consumer, 'Download CLI certification shader headers');
  const cliUpload = step(producer, 'Upload NovelTea host CLI');
  const cliDownload = step(consumer, 'Download NovelTea host CLI');
  const artifact = 'noveltea-cli-certification-shader-headers';
  const includePath = 'build/linux-authoring-release/_deps/bgfx.cmake-src/bgfx/src';
  assert.match(upload, /uses: actions\/upload-artifact@/);
  assert.match(download, /uses: actions\/download-artifact@/);
  assert.ok(upload.includes(`name: ${artifact}`));
  assert.ok(download.includes(`name: ${artifact}`));
  assert.equal(field(upload, 'path'), includePath);
  assert.equal(field(download, 'path'), includePath);
  assert.equal(field(upload, 'if-no-files-found'), 'error');
  assert.equal(field(cliUpload, 'path'), 'build/cli/linux');
  assert.equal(field(cliDownload, 'path'), 'build/cli/linux');
  assert.equal(field(consumer, 'needs'), 'linux-cli');
  assert.doesNotMatch(consumer, /setup-linux-vcpkg|actions\/cache|run-id:/);
  assert.ok(consumer.indexOf(download) < consumer.indexOf('- name: Certify NovelTea host CLI'));
});

test('differential-only CLI certification builds its Node reference bundle in the clean matrix job', () => {
  const consumer = job('linux-cli-certify');
  const bundleBuild = step(consumer, 'Build Node reference bundle for differential-only shard');
  const certification = step(consumer, 'Certify NovelTea host CLI');
  assert.equal(field(bundleBuild, 'if'), "matrix.sections == 'differential'");
  assert.match(bundleBuild, /pnpm -C editor exec vp pack/);
  assert.ok(consumer.indexOf(bundleBuild) < consumer.indexOf(certification));
});

test('vcpkg binary caches have independent configuration writers and refresh on new commits', () => {
  const sdk = step(vcpkg, 'Cache vcpkg SDK');
  const binaries = step(vcpkg, 'Cache vcpkg binaries');
  const installed = step(vcpkg, 'Cache vcpkg installed tree');
  assert.equal(field(sdk, 'path'), '.cache/vcpkg');
  assert.equal(field(binaries, 'path'), '.cache/vcpkg-binary');
  assert.ok(field(binaries, 'key').includes("${{ inputs['binary-scope'] }}"));
  assert.ok(field(binaries, 'key').endsWith('${{ github.sha }}'));
  assert.ok(field(binaries, 'key').includes("${{ inputs['cache-prefix'] }}"));
  assert.ok(
    binaries.includes(
      "restore-keys: |\n          ${{ inputs['cache-prefix'] }}-vcpkg-binary-${{ inputs['binary-scope'] }}-",
    ),
  );
  assert.match(binaries, /binary-fallback-scope/);
  assert.doesNotMatch(installed, /fallback|vcpkg-binary/);

  const expectedWriters = new Map([
    ['linux', 'linux-debug'],
    ['linux-cli', 'linux-authoring-release'],
    ['linux-cooperative', 'linux-no-threads'],
    ['linux-sanitize', 'linux-sanitize'],
  ]);
  const writers = new Set();
  for (const [jobName, scope] of expectedWriters) {
    const setup = step(job(jobName), 'Set up vcpkg');
    assert.equal(field(setup, 'binary-scope'), scope);
    assert.ok(!writers.has(scope), `vcpkg binary writer '${scope}' is shared by parallel jobs`);
    writers.add(scope);
  }
  assert.equal(field(step(job('linux-cooperative'), 'Set up vcpkg'), 'scope'), 'linux-debug');
  assert.equal(
    field(step(job('linux-cooperative'), 'Set up vcpkg'), 'binary-fallback-scope'),
    'linux-debug',
  );
});

test('CI publishes distinct informational coverage summaries and detailed artifacts', () => {
  const native = job('linux');
  const editor = job('editor');
  assert.match(step(native, 'Configure'), /NOVELTEA_ENABLE_COVERAGE=ON/);
  const ctest = step(native, 'CTest');
  const ctestReport = step(native, 'Report CTest coverage');
  const resetLab = step(native, 'Reset Feature Lab coverage counters');
  const lab = step(native, 'Feature Lab authored Tests');
  const labReport = step(native, 'Report Feature Lab coverage');
  const combined = step(native, 'Report combined native coverage');
  assert.match(step(native, 'Configure'), /NOVELTEA_BUILD_HOST_TOOLS=ON/);
  assert.match(step(native, 'Build Node coverage driver'), /vp pack/);
  assert.match(lab, /NOVELTEA_NATIVE_TOOL_BRIDGE: .*build\/linux-debug\/tools\/editor_tool\/noveltea-tooling-bridge/);
  assert.match(lab, /NOVELTEA_UI_TEST_RUNNER: .*build\/linux-debug\/tools\/editor_tool\/noveltea-ui-test-runner/);
  assert.match(lab, /--project tests\/projects\/feature-lab --json test run/);
  assert.ok(native.indexOf(step(native, 'Reset CTest coverage counters')) < native.indexOf(ctest));
  assert.ok(native.indexOf(ctest) < native.indexOf(ctestReport));
  assert.ok(native.indexOf(ctestReport) < native.indexOf(resetLab));
  assert.ok(native.indexOf(resetLab) < native.indexOf(lab));
  assert.ok(native.indexOf(lab) < native.indexOf(labReport));
  assert.ok(native.indexOf(labReport) < native.indexOf(combined));
  assert.match(ctestReport, /native-coverage\.mjs report .*\/ctest/);
  assert.match(labReport, /native-coverage\.mjs report .*\/feature-lab/);
  assert.match(combined, /native-coverage\.mjs merge/);
  for (const report of [ctestReport, labReport, combined]) {
    assert.match(report, /coverage-summary\.mjs cpp .*GITHUB_STEP_SUMMARY/);
    assert.equal(field(report, 'if'), '${{ !cancelled() }}');
  }
  assert.match(step(editor, 'Test'), /test:coverage/);
  assert.match(step(editor, 'Summarize editor coverage'), /coverage-summary\.mjs editor .*GITHUB_STEP_SUMMARY/);
  assert.match(step(native, 'Upload C++ coverage'), /name: noveltea-coverage-cpp/);
  assert.match(step(editor, 'Upload editor coverage'), /name: noveltea-coverage-editor/);
  assert.doesNotMatch(native, /--fail-under/);
});

test('desktop player and authoring presets keep compatibility floors separate', () => {
  const presets = new Map(cmakePresets.configurePresets.map((preset) => [preset.name, preset]));
  const linuxPlayer = presets.get('linux-release');
  const linuxAuthoring = presets.get('linux-authoring-release');
  const windowsPlayer = presets.get('windows-release');
  const macPlayer = presets.get('macos-release');
  const macAuthoring = presets.get('macos-authoring-release');
  assert.ok(linuxPlayer && linuxAuthoring && windowsPlayer && macPlayer && macAuthoring);
  assert.equal(linuxPlayer.cacheVariables.VCPKG_TARGET_TRIPLET, 'x64-linux-noveltea');
  assert.match(linuxPlayer.cacheVariables.CMAKE_EXE_LINKER_FLAGS, /-static-libstdc\+\+ -static-libgcc/);
  assert.equal(linuxAuthoring.cacheVariables.VCPKG_TARGET_TRIPLET, 'x64-linux-authoring-noveltea');
  assert.equal(linuxAuthoring.cacheVariables.CMAKE_EXE_LINKER_FLAGS, '');
  assert.match(playerCmake, /CMAKE_SYSTEM_NAME STREQUAL "Linux"[\s\S]*LINKER:--as-needed/);
  assert.equal(windowsPlayer.cacheVariables.NOVELTEA_TARGET_WINDOWS_10_1809, 'ON');
  assert.equal(windowsPlayer.cacheVariables.CMAKE_C_FLAGS, undefined);
  assert.equal(windowsPlayer.cacheVariables.CMAKE_CXX_FLAGS, undefined);
  assert.match(rootCmake, /if\(NOVELTEA_TARGET_WINDOWS_10_1809\)/);
  assert.match(rootCmake, /NTDDI_VERSION=0x0A000006/);
  assert.equal(macPlayer.cacheVariables.CMAKE_OSX_DEPLOYMENT_TARGET, '11.0');
  assert.equal(macAuthoring.cacheVariables.CMAKE_OSX_DEPLOYMENT_TARGET, '14.0');
  assert.equal(macAuthoring.cacheVariables.VCPKG_TARGET_TRIPLET, 'arm64-osx-authoring-noveltea');
});

test('Windows C++ policy runs lightweight native suites before shipped targets', () => {
  const windowsPolicy = job('windows');
  const configure = step(windowsPolicy, 'Configure Windows release');
  const lightweightBuild = step(windowsPolicy, 'Build Windows lightweight native tests');
  const lightweightRun = step(windowsPolicy, 'Test Windows lightweight native suites');
  const shippedBuild = step(windowsPolicy, 'Build shipped Windows targets');
  assert.match(configure, /-DVCPKG_MANIFEST_FEATURES=tests/);
  assert.match(configure, /-DBUILD_TESTING=ON/);
  assert.match(lightweightBuild, /--target noveltea_daemon_tests noveltea_runtime_cache_probe_tests noveltea_windows_project_watcher_tests/);
  assert.match(lightweightRun, /ctest --test-dir build\/windows-release --output-on-failure -L early-windows/);
  assert.doesNotMatch(shippedBuild, /noveltea_daemon_tests|noveltea_runtime_cache_probe_tests|noveltea_windows_project_watcher_tests/);
  assert.ok(windowsPolicy.indexOf('Build Windows lightweight native tests') < windowsPolicy.indexOf('Build shipped Windows targets'));
});

test('Windows CLI preserves static winpthreads without colliding with ScriptC time shims', () => {
  assert.match(cliBuildScript, /libwinpthread-scriptc\.a/);
  for (const symbol of ['clock_gettime32', 'clock_gettime64', 'nanosleep32', 'nanosleep64']) {
    assert.match(cliBuildScript, new RegExp(`--redefine-sym=\\$\\{symbol\\}=`));
  }
  assert.doesNotMatch(
    cliBuildScript,
    /compilerLibrary\('gcc', '-print-file-name=libwinpthread\.a', 'libwinpthread\.a'\),\n\s*\]/,
  );
});

test('shader tool consumers use the pinned bgfx-matched nt-tools bundle', () => {
  assert.match(workflow, /^  NOVELTEA_SHADERC_TOOLCHAIN_TAG: r6$/m);

  const shaderAssets = job('shader-assets');
  const download = step(shaderAssets, 'Download standalone shaderc');
  assert.match(
    download,
    /Cruel\/nt-tools\/releases\/download\/\$NOVELTEA_SHADERC_TOOLCHAIN_TAG\/noveltea-bgfx-shaderc-linux-x64\.tar\.gz/,
  );
  assert.match(download, /test -x "\$shaderc_root\/bin\/shaderc"/);
  assert.match(download, /resources\/bgfx_shader\.sh/);
  assert.match(download, /BGFX_SHADER_INCLUDE=\$shaderc_root\/resources/);

  const hostCliDownload = step(job('linux-cli'), 'Download prebuilt embedded bgfx tool closure');
  assert.match(hostCliDownload, /gh release download "\$NOVELTEA_SHADERC_TOOLCHAIN_TAG"/);
});

test('C++ formatting runs as an early pinned-tool gate before shader assets', () => {
  const format = job('cxx-format');
  assert.match(format, /name: C\+\+ formatting/);
  assert.match(
    format,
    /uses: astral-sh\/setup-uv@c18668ad3cf93ea998bef934396af7bb5c839dc7 # v10\.2\.0/,
  );
  assert.match(format, /enable-cache: false/);
  assert.match(step(format, 'Check C++ formatting'), /cmake\/RunClangFormat\.cmake/);
  assert.match(step(format, 'Check C++ formatting'), /-DMODE=check/);
  assert.equal(field(job('shader-assets'), 'needs'), 'cxx-format');
});

test('Web editor preview verifies the actual devtools-off and devtools-on Emscripten export surfaces', () => {
  const preview = job('web-preview');
  const build = step(preview, 'Verify devtools-off transport and build editor preview');
  assert.match(preview, /actions\/setup-node@v6/);
  assert.match(build, /-DNOVELTEA_ENABLE_DEVTOOLS=OFF/);
  assert.match(build, /check-web-editor-preview-exports\.mjs .*index\.js off/);
  assert.match(build, /-DNOVELTEA_ENABLE_DEVTOOLS=ON/);
  assert.match(build, /check-web-editor-preview-exports\.mjs .*index\.js on/);
  assert.ok(
    build.indexOf('-DNOVELTEA_ENABLE_DEVTOOLS=OFF') <
      build.indexOf('-DNOVELTEA_ENABLE_DEVTOOLS=ON'),
  );
});

test('native build and release jobs verify the linked devtools capability matrix', () => {
  const linux = job('linux');
  const verifyEnabled = step(linux, 'Verify native devtools composition');
  assert.match(
    verifyEnabled,
    /check-native-devtools-symbols\.sh build\/linux-debug\/apps\/sandbox\/noveltea-sandbox on/,
  );
  assert.match(
    verifyEnabled,
    /check-native-devtools-symbols\.sh build\/linux-debug\/apps\/player\/noveltea-player on/,
  );

  assert.match(
    releaseWorkflow,
    /name: Verify production player excludes developer components[\s\S]*check-native-devtools-symbols\.sh build\/linux-release\/apps\/player\/noveltea-player off/,
  );
});

test('artifact consumers do not wait for unrelated test and cooperative build jobs', () => {
  assert.equal(field(job('editor'), 'needs'), '[linux-cli, web-preview]');
  assert.equal(field(job('android'), 'needs'), '[shader-assets, linux-cli]');
  assert.equal(field(job('linux-cooperative'), 'needs'), 'shader-assets');
  assert.equal(field(job('android-cooperative'), 'needs'), 'shader-assets');
});

test('CI keeps shared-display CTest runs serial until their isolation is established', () => {
  assert.doesNotMatch(workflow, /CTEST_PARALLEL_LEVEL:/);
  for (const name of ['linux', 'linux-sanitize']) {
    const commands = job(name).split('\n').filter((line) => line.includes('ctest --test-dir'));
    assert.equal(commands.length, 1);
    assert.doesNotMatch(commands[0], /--parallel|\s-j/);
  }
});

test('CI leaves compile concurrency automatic while serializing heavyweight Linux links', () => {
  assert.doesNotMatch(workflow, /CMAKE_BUILD_PARALLEL_LEVEL:/);
  assert.doesNotMatch(workflow, /VCPKG_MAX_CONCURRENCY:/);
  assert.doesNotMatch(workflow, /-DCMAKE_JOB_POOLS=|-DCMAKE_JOB_POOL_LINK=/);

  const presets = new Map(cmakePresets.configurePresets.map((preset) => [preset.name, preset]));
  for (const name of ['linux-debug', 'linux-release']) {
    const preset = presets.get(name);
    assert.ok(preset, `Missing CMake preset ${name}`);
    assert.equal(preset.cacheVariables.CMAKE_JOB_POOLS, 'link_pool=1');
    assert.equal(preset.cacheVariables.CMAKE_JOB_POOL_LINK, 'link_pool');
  }
  assert.equal(presets.get('linux-sanitize')?.inherits, 'linux-debug');
  assert.match(releaseWorkflow, /preset: linux-release/);
  assert.doesNotMatch(step(job('linux'), 'Build'), /--parallel|\s-j\d*/);
});
