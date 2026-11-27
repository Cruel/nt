import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const script = path.resolve('scripts/ci/windows-native-test-build.py');
const env = { ...process.env, GITHUB_REPOSITORY: 'Cruel/nt', GITHUB_WORKFLOW: 'Build',
  GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' };

test('MSVC test transport preserves actual selected CTest registrations and exact runtime bytes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nt-msvc-transport-'));
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q']);
  git(['-c', 'user.name=CI Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-qm', 'Source fixture']);
  const sha = git(['rev-parse', 'HEAD']);
  const sourceEnv = { ...env, GITHUB_SHA: sha };
  const run = (exe, args, overrides = {}) => {
    const r = spawnSync(exe, args, { cwd: root, encoding: 'utf8', env: { ...sourceEnv, ...overrides } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  };
  const attempt = (args, overrides = {}) =>
    spawnSync('python3', [script, ...args], { cwd: root, encoding: 'utf8', env: { ...sourceEnv, ...overrides } });
  const build = path.join(root, 'build/windows-release');
  const shaders = path.join(root, 'build/prebuilt-shader-assets');
  const archive = path.join(root, 'dist', `noveltea-player-template-ci-${sha}-windows-x64-release.zip`);
  const dest = path.join(root, 'artifact');
  try {
    mkdirSync(shaders, { recursive: true });
    mkdirSync(path.dirname(archive), { recursive: true });
    writeFileSync(path.join(shaders, 'fixture.bin'), 'shader');
    writeFileSync(archive, 'template');
    writeFileSync(path.join(root, 'main.cpp'), 'int main() { return 0; }\n');
    writeFileSync(path.join(root, 'CMakeLists.txt'), `cmake_minimum_required(VERSION 3.24)
project(exact_native_fixture LANGUAGES CXX)
enable_testing()
add_executable(noveltea main.cpp)
set_target_properties(noveltea PROPERTIES SUFFIX ".exe" RUNTIME_OUTPUT_DIRECTORY "\${CMAKE_BINARY_DIR}/tools/editor_tool/native-cli")
add_test(NAME early COMMAND noveltea)
set_tests_properties(early PROPERTIES LABELS early-windows)
add_test(NAME native_authoring_yaml_transaction COMMAND noveltea)
add_test(NAME native_cli_windows_pe_resources COMMAND noveltea)
add_test(NAME native_cli_repair_project COMMAND noveltea)
add_test(NAME native_cli_incremental_validation_certification COMMAND noveltea)
add_test(NAME excluded COMMAND \${CMAKE_COMMAND} -E false)
`);
    run('cmake', ['-S', root, '-B', build, '-DCMAKE_BUILD_TYPE=Release']);
    run('cmake', ['--build', build]);
    const cli = path.join(build, 'tools/editor_tool/native-cli/noveltea.exe');
    const original = readFileSync(cli);
    writeFileSync(path.join(build, 'excluded.lib'), 'not a runtime input');
    // LIEF's source examples include symlinks that cannot be followed
    // on hosted Windows. A dangling link reproduces the pre-stat failure
    // of tarfile.add(dereference=True) on this portable fixture.
    const examples = path.join(build, '_deps/noveltea_lief-src/examples');
    const docs = path.join(build, '_deps/noveltea_libfyaml-src/doc');
    for (const subtree of [examples, docs]) {
      mkdirSync(subtree, { recursive: true });
      symlinkSync(path.join(root, 'missing-source-only-target'), path.join(subtree, 'unavailable'));
    }
    // Fail closed for an unexpected missing input outside the excluded trees.
    const requiredLink = path.join(build, 'missing-runtime-input');
    symlinkSync(path.join(root, 'missing-runtime-target'), requiredLink);
    assert.notEqual(attempt(['pack', dest]).status, 0);
    rmSync(requiredLink);
    run('python3', [script, 'pack', dest]);
    assert.notEqual(attempt(['restore', dest]).status, 0, 'Refuse overlay');
    for (const p of [build, shaders, archive]) rmSync(p, { recursive: true });
    for (const overrides of [{ GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_RUN_ID: '43' },
      { GITHUB_WORKFLOW: 'Coverage' }, { GITHUB_REPOSITORY: 'Other/nt' }]) {
      assert.notEqual(attempt(['restore', dest], overrides).status, 0);
      assert.ok(!existsSync(build));
    }
    const packed = path.join(dest, 'native.tar.gz');
    const bytes = readFileSync(packed);
    writeFileSync(packed, bytes.subarray(0, bytes.length - 1));
    assert.notEqual(attempt(['restore', dest]).status, 0);
    assert.ok(!existsSync(build));
    writeFileSync(packed, bytes);
    run('python3', [script, 'restore', dest], { GITHUB_RUN_ATTEMPT: '2' });
    assert.deepEqual(readFileSync(cli), original);
    assert.equal(readFileSync(archive, 'utf8'), 'template');
    assert.equal(readFileSync(path.join(shaders, 'fixture.bin'), 'utf8'), 'shader');
    assert.ok(!existsSync(path.join(build, 'excluded.lib')));
    assert.ok(!existsSync(examples));
    assert.ok(!existsSync(docs));
    assert.match(run('ctest', ['--test-dir', build, '-L', 'early-windows', '--no-tests=error']), /100% tests passed/);
    assert.match(run('ctest', ['--test-dir', build, '-R', '^native_cli_repair_project$', '--no-tests=error']), /100% tests passed/);
    for (const p of [build, shaders, archive]) rmSync(p, { recursive: true });
    const consumer = { GITHUB_WORKFLOW: 'Extended Qualification', GITHUB_RUN_ID: '99',
      GITHUB_RUN_ATTEMPT: '3', GITHUB_SHA: 'c'.repeat(40) };
    const restoreBuild = ['restore-build', dest, sha, '42', '1'];
    for (const [args, overrides] of [
      [restoreBuild, { ...consumer, GITHUB_WORKFLOW: 'Coverage' }],
      [restoreBuild, { ...consumer, GITHUB_REPOSITORY: 'Other/nt' }],
      [['restore-build', dest, sha, '43', '1'], consumer],
      [['restore-build', dest, sha, '42', '2'], consumer],
      [['restore-build', dest, 'b'.repeat(40), '42', '1'], consumer],
      [['restore', dest], consumer],
    ]) {
      assert.notEqual(attempt(args, overrides).status, 0);
      assert.ok(!existsSync(build));
    }
    run('python3', [script, ...restoreBuild], consumer);
    assert.deepEqual(readFileSync(cli), original);
    assert.equal(readFileSync(archive, 'utf8'), 'template');
    assert.match(run('ctest', ['--test-dir', build, '-R', '^native_cli_incremental_validation_certification$', '--no-tests=error'], consumer), /100% tests passed/);
    assert.notEqual(attempt(restoreBuild, consumer).status, 0, 'Refuse cross-run overlay');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
