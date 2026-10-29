import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const workflow = readFileSync(new URL('../../.github/workflows/build.yml', import.meta.url), 'utf8');
const releaseWorkflow = readFileSync(
  new URL('../../.github/workflows/release.yml', import.meta.url),
  'utf8',
);
const cmakePresets = JSON.parse(
  readFileSync(new URL('../../CMakePresets.json', import.meta.url), 'utf8'),
);
const rootCmake = readFileSync(new URL('../../CMakeLists.txt', import.meta.url), 'utf8');
const nativeCoverageCmake = readFileSync(
  new URL('../../cmake/NovelTeaCoverage.cmake', import.meta.url),
  'utf8',
);
const compilerPolicyCmake = readFileSync(
  new URL('../../cmake/NovelTeaCompilerPolicy.cmake', import.meta.url),
  'utf8',
);
const windowsSoftwareGlSetup = readFileSync(
  new URL('../../scripts/setup-windows-software-opengl.ps1', import.meta.url),
  'utf8',
);
const windowsReleaseSmoke = readFileSync(
  new URL('../../tests/native_cli/windows_release_smoke.py', import.meta.url),
  'utf8',
);
const editorToolCmake = readFileSync(
  new URL('../../tools/editor_tool/CMakeLists.txt', import.meta.url),
  'utf8',
);
const nativeAuthoringCmake = readFileSync(
  new URL('../../tools/project_authoring/CMakeLists.txt', import.meta.url),
  'utf8',
);
const reconciliationTests = readFileSync(
  new URL('../../editor/src/renderer/test/native-authoring-reconciliation.test.ts', import.meta.url),
  'utf8',
);
const playerCmake = readFileSync(new URL('../../apps/player/CMakeLists.txt', import.meta.url), 'utf8');
const vcpkg = readFileSync(
  new URL('../../.github/actions/setup-linux-vcpkg/action.yml', import.meta.url),
  'utf8',
);
const cliBuildScript = readFileSync(
  new URL('../../editor/scripts/build-noveltea-cli.mjs', import.meta.url),
  'utf8',
);
const publicCliContracts = readFileSync(
  new URL('../../editor/scripts/certify-native-cli-public-contracts.mjs', import.meta.url),
  'utf8',
);
const candidateContracts = readFileSync(
  new URL('../../editor/scripts/certify-native-candidate-contracts.mjs', import.meta.url),
  'utf8',
);

function releaseJob(name) {
  const match = releaseWorkflow.match(
    new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'm'),
  );
  assert.ok(match, `Missing release job ${name}`);
  return match[0];
}

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

test('sanitizer CI keeps optimized instrumentation and a bounded first-party test selection', () => {
  const sanitizerPreset = cmakePresets.configurePresets.find(
    (preset) => preset.name === 'linux-sanitize',
  );
  assert.ok(sanitizerPreset);
  assert.equal(sanitizerPreset.cacheVariables.NOVELTEA_ENABLE_SANITIZERS, 'ON');
  assert.equal(sanitizerPreset.cacheVariables.NOVELTEA_BUILD_FUZZERS, 'ON');
  for (const flags of ['CMAKE_C_FLAGS_DEBUG', 'CMAKE_CXX_FLAGS_DEBUG']) {
    assert.match(sanitizerPreset.cacheVariables[flags], /-O1\b/);
    assert.doesNotMatch(sanitizerPreset.cacheVariables[flags], /-DNDEBUG\b/);
  }
  const lane = step(
    job('linux-sanitize'),
    'Run strict ASan, LeakSanitizer, UBSan, and parser fuzz smoke tests',
  );
  assert.match(lane, /ASAN_OPTIONS: detect_leaks=1:halt_on_error=1/);
  assert.match(lane, /-L '\^\(asan-smoke\|fuzz-smoke\)\$'/);
  assert.match(lane, /--timeout 300/);
  assert.doesNotMatch(lane, /\s-E\s/);
  assert.match(
    nativeAuthoringCmake,
    /native_authoring_yaml[\s\S]*?PROPERTIES LABELS "asan-smoke"/,
  );
  assert.match(
    readFileSync(new URL('../../tests/CMakeLists.txt', import.meta.url), 'utf8'),
    /LABELS "robustness;fuzz-smoke"/,
  );
});

test('optimized GCC sanitizers preserve strict warnings except libstdc++ regex false positives', () => {
  assert.match(
    compilerPolicyCmake,
    /CMAKE_CXX_COMPILER_ID STREQUAL "GNU" AND NOVELTEA_ENABLE_SANITIZERS/,
  );
  assert.match(compilerPolicyCmake, /-Wno-error=maybe-uninitialized/);
  assert.match(compilerPolicyCmake, /target_compile_options\("\$\{target\}" PRIVATE -Werror\)/);
  assert.doesNotMatch(compilerPolicyCmake, /-Wno-error(?![=-])/);
});

test('Windows Build and Release provision pinned software GL only for an actual player launch', () => {
  const setupName = 'Install pinned software OpenGL for Windows player launch';
  const buildWindows = job('windows');
  const releaseWindows = releaseJob('desktop-hosts');
  for (const lane of [buildWindows, releaseWindows]) {
    const installation = step(lane, setupName);
    const launch = step(
      lane,
      lane === buildWindows
        ? 'Generate current Windows player template and launch native C++ export'
        : 'Export and launch real Windows player through native C++ CLI',
    );
    assert.match(installation, /scripts\/setup-windows-software-opengl\.ps1/);
    assert.ok(lane.indexOf(installation) < lane.indexOf(launch));
    assert.match(launch, /tests\/native_cli\/windows_release_smoke\.py/);
  }
  assert.match(windowsSoftwareGlSetup, /\$version = '26\.2\.4'/);
  assert.match(windowsSoftwareGlSetup, /mesa3d-\$version-release-msvc\.7z/);
  assert.match(windowsSoftwareGlSetup, /351fc8c8b695878ffb3eaa044b3ead08672a48b1a045e3c3e3975811df0f6695/);
  assert.match(windowsSoftwareGlSetup, /Get-FileHash.*SHA256/);
  assert.match(windowsSoftwareGlSetup, /libgallium_wgl\.dll/);
  assert.match(windowsReleaseSmoke, /shutil\.copytree\(output, launch_root\)/);
  assert.match(windowsReleaseSmoke, /'GALLIUM_DRIVER': 'llvmpipe'/);
  assert.match(windowsReleaseSmoke, /\[renderer\] bgfx core initialized:/);
});

test('Linux production CLI enables its cross-host export certification targets explicitly', () => {
  const producer = job('linux-cli');
  const certification = step(
    producer,
    'Certify cross-host native macOS and Android export and publication recovery',
  );
  assert.match(rootCmake, /option\(NOVELTEA_CLI_CROSS_HOST_EXPORT_CERTIFY/);
  assert.match(
    rootCmake,
    /if\(NOVELTEA_CLI_CROSS_HOST_EXPORT_CERTIFY\)[\s\S]{0,260}enable_testing\(\)/,
  );
  assert.match(
    editorToolCmake,
    /if\(BUILD_TESTING OR NOVELTEA_CLI_CROSS_HOST_EXPORT_CERTIFY\)/,
  );
  assert.match(
    certification,
    /cmake --preset linux-authoring-release -DNOVELTEA_CLI_CROSS_HOST_EXPORT_CERTIFY=ON/,
  );
  assert.match(certification, /-DNOVELTEA_PREBUILT_SHADER_ASSET_ROOT=/);
  assert.match(certification, /-DNOVELTEA_COMPILE_SHADERS=OFF/);
  for (const target of [
    'noveltea-cli-macos-export-certify',
    'noveltea-cli-android-export-certify',
    'noveltea-cli-platform-publication-certify',
  ]) {
    assert.ok(editorToolCmake.includes(`add_executable(${target}`));
    assert.ok(certification.includes(target));
  }
  assert.ok(
    certification.indexOf('cmake --preset linux-authoring-release') <
      certification.indexOf('cmake --build --preset linux-authoring-release'),
  );
  assert.match(certification, /ctest --test-dir build\/linux-authoring-release/);
});

test('Linux host CLI builds the renderer before checking native production closure', () => {
  const linuxCli = job('linux-cli');
  const renderer = step(linuxCli, 'Build renderer required by native production closure');
  const closure = step(linuxCli, 'Certify native production closure');
  assert.match(renderer, /pnpm -C editor exec vp build/);
  assert.match(closure, /pnpm -C editor run check:native-production-closure/);
  assert.ok(linuxCli.indexOf(renderer) < linuxCli.indexOf(closure));
});

test('Linux installed CLI certification builds the renderer after packing native bundles', () => {
  const consumer = job('linux-cli-certify');
  const pack = step(consumer, 'Build native editor and ScriptC production bundles');
  const renderer = step(consumer, 'Build renderer required by installed CLI production certification');
  const certification = step(consumer, 'Certify installed native CLI production');
  assert.match(pack, /pnpm -C editor exec vp pack/);
  assert.match(renderer, /pnpm -C editor exec vp build/);
  assert.ok(consumer.indexOf(pack) < consumer.indexOf(renderer));
  assert.ok(consumer.indexOf(renderer) < consumer.indexOf(certification));
});

test('Windows native export certification installs pinned Node and Agent Kit dependencies', () => {
  const windows = job('windows');
  const installPnpm = step(windows, 'Install pnpm');
  const node = step(windows, 'Set up repository Node.js');
  const install = step(windows, 'Install dependencies for native Agent Kit generation');
  const nativeBuild = step(windows, 'Build native Windows platform exporter certification targets');
  assert.match(installPnpm, /pnpm\/action-setup@v6/);
  assert.match(node, /node-version-file: .node-version/);
  assert.match(install, /pnpm install --frozen-lockfile/);
  assert.ok(windows.indexOf(installPnpm) < windows.indexOf(install));
  assert.ok(windows.indexOf(node) < windows.indexOf(install));
  assert.ok(windows.indexOf(install) < windows.indexOf(nativeBuild));
});

test('production CLI public contracts validate shipped ScriptC provenance, not candidate output', () => {
  assert.match(
    candidateContracts,
    /'certify-native-cli-public-contracts\.mjs',[\s\S]*?production \? \[cli, '--production'\] : \[cli\]/,
  );
  assert.match(
    publicCliContracts,
    /process\.argv\[3\] === '--production'\s*\? 'editor\/dist-scriptc-island'\s*: 'editor\/dist-scriptc-native-island'/,
  );
});

test('standalone CI contract tests install the editor YAML parser before execution', () => {
  const policy = job('cxx-runtime-policy');
  const installPnpm = step(policy, 'Install pnpm for CI contract fixtures');
  const install = step(policy, 'Install workspace dependencies for YAML contract tests');
  const testContracts = step(policy, 'Test CI contracts');
  assert.match(installPnpm, /pnpm\/action-setup@v6/);
  assert.match(install, /pnpm install --frozen-lockfile/);
  assert.ok(policy.indexOf(installPnpm) < policy.indexOf(install));
  assert.ok(policy.indexOf(install) < policy.indexOf(testContracts));
});

test('native Project worker crash diagnosis runs only on Windows', () => {
  const workerHosts = job('native-authoring-hosts');
  const diagnosis = step(workerHosts, 'Diagnose Windows native authoring worker failure');
  assert.equal(field(diagnosis, 'if'), "failure() && runner.os == 'Windows'");
});

test('native reconciliation fixture cleanup awaits native worker exit before deleting sources', () => {
  assert.doesNotMatch(reconciliationTests, /\bbridge\.close\(\)/);
  assert.match(
    reconciliationTests,
    /await bridge\.closeAndWait\(\);\s*await rm\(root, \{ recursive: true, force: true \}\)/,
  );
  assert.match(reconciliationTests, /const deterministicPollIntervalMs = 0;/);
  assert.doesNotMatch(reconciliationTests, /pollIntervalMs:\s*[1-9]/);
  assert.match(reconciliationTests, /pollIntervalMs: deterministicPollIntervalMs/g);
});

test('release Linux and Windows CLI certification build the required renderer first', () => {
  const producer = releaseJob('shader-assets');
  const consumer = releaseJob('windows-cli');
  for (const [release, cliBuild] of [
    [producer, 'Build NovelTea host CLI'],
    [consumer, 'Build native production bundles'],
  ]) {
    const renderer = step(release, 'Build renderer required by native production certification');
    const certification = step(
      release,
      release === producer ? 'Certify NovelTea host CLI' : 'Certify Windows CLI',
    );
    assert.match(renderer, /pnpm -C editor exec vp build/);
    assert.ok(release.indexOf(step(release, cliBuild)) < release.indexOf(renderer));
    assert.ok(release.indexOf(renderer) < release.indexOf(certification));
  }
});

test('release Windows CLI build and certification are separate same-run artifact stages', () => {
  const producer = releaseJob('windows-cli-build');
  const consumer = releaseJob('windows-cli');
  const cliUpload = step(producer, 'Upload Windows CLI build');
  const headersUpload = step(producer, 'Upload Windows CLI certification shader headers');
  const cliDownload = step(consumer, 'Download Windows CLI build');
  const headersDownload = step(consumer, 'Download Windows CLI certification shader headers');
  const bundleBuild = step(consumer, 'Build native production bundles');
  const certification = step(consumer, 'Certify Windows CLI');

  assert.match(producer, /pnpm -C editor run noveltea:build/);
  assert.doesNotMatch(consumer, /pnpm -C editor run noveltea:build/);
  assert.match(consumer, /needs: \[release-metadata, windows-cli-build\]/);
  assert.equal(field(cliUpload, 'path'), 'build/cli/windows');
  assert.equal(field(cliDownload, 'path'), 'build/cli/windows');
  assert.equal(
    field(headersUpload, 'path'),
    'build/windows-cli-gnu/_deps/bgfx.cmake-src/bgfx/src',
  );
  assert.equal(
    field(headersDownload, 'path'),
    'build/windows-cli-gnu/_deps/bgfx.cmake-src/bgfx/src',
  );
  assert.equal(field(cliUpload, 'retention-days'), '1');
  assert.equal(field(headersUpload, 'retention-days'), '1');
  assert.match(bundleBuild, /pnpm -C editor exec vp pack/);
  assert.ok(consumer.indexOf(cliDownload) < consumer.indexOf(certification));
  assert.ok(consumer.indexOf(headersDownload) < consumer.indexOf(certification));
  assert.ok(consumer.indexOf(bundleBuild) < consumer.indexOf(certification));
  assert.doesNotMatch(consumer, /Cache vcpkg SDK and binaries|Set up Zig for ScriptC Windows target/);
});

test('release Linux CLI artifact consumers restore both required executable bits', () => {
  for (const name of ['desktop-hosts', 'web', 'android']) {
    const consumer = releaseJob(name);
    const chmod = step(consumer, 'Make NovelTea host CLI executable');
    assert.match(chmod, /chmod \+x build\/cli\/linux\/noveltea build\/cli\/linux\/noveltea-ui-test-runner/);
    assert.ok(consumer.indexOf(chmod) < consumer.indexOf('Validate canonical export fixture') ||
      !consumer.includes('Validate canonical export fixture'));
  }
});

test('workflows do not spend Actions cache quota on package-manager or downloadable SDK caches', () => {
  const workflowRoot = new URL('../../.github/workflows/', import.meta.url);
  const sources = readdirSync(workflowRoot)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => readFileSync(new URL(name, workflowRoot), 'utf8'))
    .join('\n');
  assert.doesNotMatch(sources, /cache: pnpm/);
  assert.doesNotMatch(sources, /cache: gradle/);
  assert.doesNotMatch(sources, /name: Cache Emscripten SDK/);
  assert.doesNotMatch(sources, /name: Cache SDL3 Android AAR/);
});

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
  const certification = step(consumer, 'Certify installed native CLI production');
  assert.match(certification, /pnpm -C editor run noveltea:certify/);
  assert.ok(consumer.indexOf(download) < consumer.indexOf(certification));
});

test('installed native CLI certification builds the required native production bundles in the clean job', () => {
  const consumer = job('linux-cli-certify');
  const bundleBuild = step(consumer, 'Build native editor and ScriptC production bundles');
  const certification = step(consumer, 'Certify installed native CLI production');
  assert.match(bundleBuild, /pnpm -C editor exec vp pack/);
  assert.ok(consumer.indexOf(bundleBuild) < consumer.indexOf(certification));
  assert.doesNotMatch(consumer, /matrix\.sections/);
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
  const cliReset = step(native, 'Reset native CLI CTest coverage counters');
  const cliCtest = step(native, 'Native CLI CTest');
  const cliReport = step(native, 'Report native CLI CTest coverage');
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
  assert.ok(native.indexOf(ctestReport) < native.indexOf(cliReset));
  assert.ok(native.indexOf(cliReset) < native.indexOf(cliCtest));
  assert.ok(native.indexOf(cliCtest) < native.indexOf(cliReport));
  assert.ok(native.indexOf(cliReport) < native.indexOf(resetLab));
  assert.match(ctest, /-E '\^\(native_cli_\|native_authoring_cli_commands\$\)'/);
  assert.match(cliCtest, /-R '\^\(native_cli_\|native_authoring_cli_commands\$\)'/);
  assert.match(step(native, 'Build excluded native CLI certification target'), /--target noveltea-cli-native-certify/);
  assert.ok(native.indexOf(resetLab) < native.indexOf(lab));
  assert.ok(native.indexOf(lab) < native.indexOf(labReport));
  assert.ok(native.indexOf(labReport) < native.indexOf(combined));
  assert.match(ctestReport, /native-coverage\.mjs report .*\/ctest/);
  assert.match(cliReport, /native-coverage\.mjs report .*\/ctest-cli/);
  assert.match(labReport, /native-coverage\.mjs report .*\/feature-lab/);
  assert.match(combined, /native-coverage\.mjs merge/);
  for (const report of [ctestReport, cliReport, labReport, combined]) {
    assert.match(report, /coverage-summary\.mjs cpp .*GITHUB_STEP_SUMMARY/);
    assert.equal(field(report, 'if'), '${{ !cancelled() }}');
  }
  assert.match(step(editor, 'Test'), /test:coverage/);
  assert.equal(field(step(editor, 'Test'), 'id'), 'editor-tests');
  for (const label of [
    'Summarize editor coverage',
    'Publish editor coverage to Codecov',
    'Upload editor coverage',
  ])
    assert.match(field(step(editor, label), 'if'), /steps\.editor-tests\.outcome == 'success'/);
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

test('native coverage stages verified FFmpeg for Feature Lab video preparation', () => {
  const linux = job('linux');
  const stage = step(linux, 'Stage pinned FFmpeg for Feature Lab');
  const tests = step(linux, 'Feature Lab authored Tests');
  // A failed C++ policy or CTest step must not suppress the media prerequisite
  // while the independently reported Feature Lab suite is still scheduled.
  assert.equal(field(stage, 'if'), '${{ !cancelled() }}');
  assert.match(stage, /node editor\/scripts\/private-media-tools\.mjs build\/coverage-media/);
  assert.match(tests, /NOVELTEA_FFMPEG: .*build\/coverage-media\/tools\/ffmpeg\/bin\/ffmpeg/);
  assert.ok(linux.indexOf(stage) < linux.indexOf(tests));
});

test('release editor consumers restore bundled FFmpeg executable permissions', () => {
  const marker = '- name: Make NovelTea host tools executable';
  const start = releaseWorkflow.indexOf(marker);
  assert.notEqual(start, -1);
  const block = releaseWorkflow.slice(start, releaseWorkflow.indexOf('- name: ', start + marker.length));
  assert.match(block, /tools\/ffmpeg\/bin\/ffmpeg/);
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
    assert.equal(commands.length, 2);
    for (const command of commands) assert.doesNotMatch(command, /--parallel|\s-j/);
  }
});

test('sanitizer native Agent Kit generation has installed Node workspace dependencies', () => {
  const sanitizer = job('linux-sanitize');
  const node = step(sanitizer, 'Set up Node.js');
  const dependencies = step(sanitizer, 'Install workspace dependencies for native Agent Kit');
  const build = step(sanitizer, 'Build sanitizer targets');
  assert.match(node, /node-version-file: \.node-version/);
  assert.match(dependencies, /pnpm install --frozen-lockfile/);
  assert.ok(sanitizer.indexOf(step(sanitizer, 'Install pnpm')) < sanitizer.indexOf(node));
  assert.ok(sanitizer.indexOf(node) < sanitizer.indexOf(dependencies));
  assert.ok(sanitizer.indexOf(dependencies) < sanitizer.indexOf(build));
});

test('platform export fixtures use the maintained native materializer, not retired build tools', () => {
  const fixture = readFileSync(
    new URL('../../editor/scripts/run-platform-export-fixture.mjs', import.meta.url),
    'utf8',
  );
  assert.match(fixture, /materialize-native-platform-export-fixture\.mjs/);
  assert.doesNotMatch(fixture, /path\.join\([^\n]*'dist-build-tools'|spawnSync\('pnpm'/);
});

test('Android metadata-only update fixtures preserve gameplay while changing the app version', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'noveltea-android-revisions-'));
  const generator = fileURLToPath(
    new URL('../../editor/scripts/materialize-native-platform-export-fixture.mjs', import.meta.url),
  );
  const sourceGallery = readFileSync(
    new URL('../../tests/fixtures/native-platform-export-web/records/rooms/gallery.yaml', import.meta.url),
    'utf8',
  );
  try {
    for (const revision of [1, 2]) {
      const destination = path.join(root, `revision-${revision}`);
      execFileSync(process.execPath, [generator, '--root', destination, '--target', 'android', '--revision', String(revision)]);
      const gallery = readFileSync(path.join(destination, 'records/rooms/gallery.yaml'), 'utf8');
      assert.equal(gallery, sourceGallery, 'App version update must not silently alter gameplay');
      const manifest = readFileSync(path.join(destination, 'project.yaml'), 'utf8');
      assert.match(manifest, new RegExp(`versionName: 2026-10-09\\.${revision}`));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Editor CI exercises the native Project compiler through a cold Runtime Package export', () => {
  const editor = job('editor');
  const compile = step(editor, 'Verify native cold Project compilation and Runtime Package export');
  assert.match(compile, /NOVELTEA_CLI_PATH/);
  assert.match(compile, /--no-daemon/);
  assert.match(compile, /package export/);
  assert.match(compile, /unzip -t/);
  assert.doesNotMatch(compile, /project:compile|compiled-project-golden|dist-build-tools/);
  const emulator = readFileSync(
    new URL('../../.github/android-emulator-smoke.sh', import.meta.url),
    'utf8',
  );
  assert.match(emulator, /check_materialized_package 'Initial APK' "\$package_sha_v1"/);
  assert.match(emulator, /check_materialized_package 'Updated APK' "\$package_sha_v2"/);
  assert.doesNotMatch(emulator, /\$before" != "\$after|\$package_sha_v1" != "\$package_sha_v2/);
});

test('Editor CI builds and supplies its own native authoring addon before distribution', () => {
  const editor = job('editor');
  assert.ok(
    editor.includes(
      'NOVELTEA_AUTHORING_NODE_ADDON: ${{ github.workspace }}/build/native-authoring-host/noveltea-authoring-node.node',
    ),
  );
  const dependencies = step(editor, 'Install dependencies');
  const buildAddon = step(editor, 'Build native Project authoring addon');
  const distribution = step(editor, 'Build and verify portable stage');
  assert.match(buildAddon, /node editor\/scripts\/build-native-authoring-addon\.mjs --addon-only/);
  assert.ok(editor.indexOf(dependencies) < editor.indexOf(buildAddon));
  assert.ok(editor.indexOf(buildAddon) < editor.indexOf(distribution));
  assert.doesNotMatch(editor, /needs: \[[^\]]*native-authoring-hosts/);
});

test('Editor CI builds and verifies the real native worker before running addon-backed tests', () => {
  const editor = job('editor');
  const addon = step(editor, 'Build native Project authoring addon');
  const build = step(editor, 'Build');
  const worker = step(editor, 'Verify native authoring worker bundle before tests');
  const tests = step(editor, 'Test');
  assert.match(build, /pnpm -C editor run build/);
  assert.match(worker, /test -s editor\/dist-electron\/authoring-worker\/native-authoring-worker\.cjs/);
  assert.ok(editor.indexOf(addon) < editor.indexOf(build));
  assert.ok(editor.indexOf(build) < editor.indexOf(worker));
  assert.ok(editor.indexOf(worker) < editor.indexOf(tests));
  const viteConfig = readFileSync(new URL('../../editor/vite.config.ts', import.meta.url), 'utf8');
  assert.match(
    viteConfig,
    /'compile:electron':\s*\{[\s\S]*?output: \[[\s\S]*?'dist-electron\/authoring-worker\/\*\*'/,
  );
});

test('editor bundle validation requires distributed outputs, not retired Project compilers', () => {
  const validator = readFileSync(
    new URL('../../editor/scripts/validate-bundle-policy.mjs', import.meta.url),
    'utf8',
  );
  assert.match(validator, /main\.cjs/);
  assert.match(validator, /preload\.cjs/);
  assert.doesNotMatch(validator, /requiredOutputs\.compiler|requiredOutputs\.goldens|fixtureRoot/);
  assert.match(validator, /build-only producer leaked into distributed tools/);
});

test('fetched LIEF is host-only Windows PE tooling, never a player dependency', () => {
  const inventory = JSON.parse(
    readFileSync(new URL('../../cmake/player-license-sources.json', import.meta.url), 'utf8'),
  );
  assert.equal(inventory.fetched.noveltea_lief.player, false);
  assert.match(editorToolCmake, /target_link_libraries\(noveltea_cli_windows_pe PUBLIC LIEF::LIEF\)/);
  assert.match(
    readFileSync(new URL('../../cmake/generate-player-template-metadata.mjs', import.meta.url), 'utf8'),
    /if \(rule\.player === false\) continue;/,
  );
});

test('release desktop hosts install editor dependencies before the Windows CMake Agent Kit build', () => {
  const desktop = releaseJob('desktop-hosts');
  const pnpm = step(desktop, 'Set up pnpm for desktop export and native tooling');
  const node = step(desktop, 'Set up Node.js for desktop export and native tooling');
  const dependencies = step(desktop, 'Install root workspace dependencies for desktop export and native tooling');
  const build = step(desktop, 'Build non-Linux desktop player');
  assert.match(pnpm, /pnpm\/action-setup@v6/);
  assert.match(node, /node-version-file: \.node-version/);
  assert.match(dependencies, /pnpm install --frozen-lockfile/);
  assert.ok(desktop.indexOf(pnpm) < desktop.indexOf(node));
  assert.ok(desktop.indexOf(node) < desktop.indexOf(dependencies));
  assert.ok(desktop.indexOf(dependencies) < desktop.indexOf(build));
});

test('native gcov preserves atomic counters and debuggability without forcing -O0', () => {
  assert.match(nativeCoverageCmake, /--coverage -fprofile-update=atomic -Og -g/);
  assert.doesNotMatch(nativeCoverageCmake, /target_compile_options\([^\n]* -O0/);
  assert.match(nativeCoverageCmake, /target_link_options\([^\n]*--coverage/);
});

test('release certification obtains evidence from real native exports, never retired integration tests', () => {
  assert.doesNotMatch(releaseWorkflow, /platform-export-canonical-integration\.test\.ts/);
  const desktop = releaseJob('desktop-hosts');
  assert.match(desktop, /NOVELTEA_CANONICAL_EVIDENCE_OUTPUT:/);
  assert.match(desktop, /tests\/native_cli\/(?:linux|windows)_release_smoke\.py/);
  const macos = releaseJob('macos-certify');
  assert.match(macos, /tests\/native_cli\/macos_release_smoke\.py/);
  assert.match(macos, /NOVELTEA_CANONICAL_EVIDENCE_OUTPUT:/);
  const web = releaseJob('web');
  assert.match(web, /noveltea-release-native-cli-linux-x64/);
  assert.match(web, /native-web-threads-nested/);
  assert.match(web, /NOVELTEA_CANONICAL_EVIDENCE_OUTPUT=.*canonical-web-single-nested-fixture-evidence\.json/);
  assert.match(web, /--case threads-root:\/:dist\/native-web-threads/);
  const android = releaseJob('android');
  assert.match(android, /native-canonical-export-evidence\.mjs/);
  assert.match(android, /canonical-android-arm64-fixture-evidence\.json/);
  assert.match(android, /canonical-android-x86_64-fixture-evidence\.json/);
});

test('macOS player and CLI compile concurrently with independent triplets and artifact handoff', () => {
  const desktop = releaseJob('desktop-hosts');
  const cli = releaseJob('macos-cli');
  const certify = releaseJob('macos-certify');
  const inventory = releaseJob('release-inventory');
  const editor = releaseJob('desktop-editor');
  assert.match(desktop, /preset: macos-release/);
  assert.match(desktop, /noveltea-release-macos-player-build/);
  assert.doesNotMatch(desktop, /run: pnpm -C editor run noveltea:build/);
  assert.match(cli, /runs-on: macos-26/);
  assert.match(cli, /run: pnpm -C editor run noveltea:build/);
  assert.match(cli, /noveltea-release-host-cli-macos-arm64/);
  assert.match(cli, /macos-authoring-release\/vcpkg_installed/);
  assert.match(certify, /needs: \[release-metadata, desktop-hosts, macos-cli\]/);
  assert.match(certify, /noveltea-release-macos-player-build/);
  assert.match(certify, /noveltea-release-host-cli-macos-arm64/);
  assert.ok(certify.indexOf('Download macOS host CLI') < certify.indexOf('Finalize and launch macOS app bundle export'));
  assert.match(certify, /noveltea-platform-certification-macos-arm64-release\.json/);
  assert.match(certify, /noveltea-desktop-host-macos-arm64-release-dist/);
  assert.match(editor, /macos-cli/);
  assert.match(inventory, /macos-certify/);
});

test('native release certification uses private short macOS broker sockets and native daemon evidence', () => {
  const broker = readFileSync(
    new URL('../../tools/editor_tool/tooling_daemon_broker.cpp', import.meta.url),
    'utf8',
  );
  const daemon = readFileSync(
    new URL('../../editor/scripts/certify-native-daemon-validation.mjs', import.meta.url),
    'utf8',
  );
  assert.match(broker, /#if defined\(__APPLE__\)\s+const auto fallback =\s+std::filesystem::path\("\/tmp"\)/);
  assert.match(broker, /nested\.string\(\)\.size\(\) \+ socket_suffix_bytes < sizeof\(sockaddr_un::sun_path\)/);
  assert.match(broker, /ensure_private_runtime_directory\(fallback\)/);
  assert.match(daemon, /engineeringCounters\?\.exactResultHits/);
  assert.match(daemon, /started\.engineeringCounters !== undefined/);
  assert.match(daemon, /verify\(execute\(argv\), invalidOracle\)/);
  assert.doesNotMatch(daemon, /filter\(\(line\) => line\.startsWith\('\[native-disk-validation\]/);
});

test('canonical release notices follow the actual packaged Asset inventory', () => {
  const evidence = readFileSync(
    new URL('../../scripts/native-canonical-export-evidence.mjs', import.meta.url),
    'utf8',
  );
  assert.match(evidence, /compiled\.resources\.assets\.map\(\(asset\) => asset\.id\)/);
  assert.match(evidence, /attachment\.purpose === 'distribution-notice'/);
  assert.match(evidence, /actualNotices\.size === expectedNotices\.size/);
  assert.match(evidence, /Project license notice digest does not match packaged bytes/);
  assert.doesNotMatch(evidence, /notices\.notices\?\.length === 3/);
});

test('unsigned Android release AAB checks derived APK identity without imposing debug signing', () => {
  const nativeAndroid = readFileSync(
    new URL('../../tools/editor_tool/native_cli_platform_stage.cpp', import.meta.url),
    'utf8',
  );
  assert.match(nativeAndroid, /android-bundletool-identity-invalid/);
  assert.match(nativeAndroid, /android-bundletool-signature-invalid/);
  assert.match(
    nativeAndroid,
    /\(settings\.signing_requested \|\| flavor == "debug"\) &&\s*!verify_apk_signature\(derived\)/,
  );
});

test('Android libpng source is checksum-pinned for player-template provenance', () => {
  const declaration = [...rootCmake.matchAll(/FetchContent_Declare\(\s*([\w.]+)([\s\S]*?)\n\s*\)/gi)]
    .find((match) => match[1] === 'libpng');
  assert.ok(declaration, 'Missing libpng source declaration');
  assert.match(declaration[2], /\bURL_HASH SHA256=[a-f0-9]{64}\b/);
});

test('sanitizer passes partition GPU smoke tests without disabling engine leak checks', () => {
  const sanitizer = job('linux-sanitize');
  const strict = step(sanitizer, 'Run strict ASan, LeakSanitizer, UBSan, and parser fuzz smoke tests');
  const gpu = step(sanitizer, 'Run GPU smoke tests under ASan and UBSan');
  assert.equal(field(strict, 'ASAN_OPTIONS'), 'detect_leaks=1:halt_on_error=1');
  assert.equal(field(gpu, 'ASAN_OPTIONS'), 'detect_leaks=0:halt_on_error=1');
  assert.equal(field(gpu, 'UBSAN_OPTIONS'), 'halt_on_error=1:print_stacktrace=1');
  const strictSelection = /-L '([^']+)'/.exec(strict)?.[1];
  const included = /-R '([^']+)'/.exec(gpu)?.[1];
  assert.equal(strictSelection, '^(asan-smoke|fuzz-smoke)$');
  assert.ok(included, 'GPU smoke tests must select their own explicit test family');
  assert.doesNotMatch(strict, /-E '([^']+)'/);
  assert.match(nativeAuthoringCmake, /PROPERTIES LABELS "asan-smoke"/);
  const selection = new RegExp(included);
  for (const name of ['noveltea_native_video_texture_smoke', 'noveltea_presentation_readback_capture',
    'noveltea_rmlui_readback_verify', 'noveltea_sandbox_runtime_video_smoke']) {
    assert.ok(selection.test(name), `${name} must run in the GPU pass`);
  }
  for (const name of ['noveltea_asset_residency_matrix', 'noveltea_parser_fuzz_smoke',
    'noveltea_structured_prefetch']) {
    assert.ok(!selection.test(name), `${name} must retain strict leak detection`);
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
