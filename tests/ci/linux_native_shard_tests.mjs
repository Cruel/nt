import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sharder = path.resolve('scripts/ci/linux-native-shards.py');
const transport = path.resolve('scripts/ci/linux-native-build-artifact.sh');
const env = { ...process.env, GITHUB_REPOSITORY: 'Cruel/nt', GITHUB_WORKFLOW: 'Build',
  GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2' };
const closure = ['build/linux-debug', 'build/prebuilt-shader-assets',
  'build/prebuilt-shaderc-toolchain', 'editor/dist-electron'];
const planPath = 'build/linux-debug/ci-native-shards.json';

function fixture(root) {
  const execute = (command, args, overrides = {}, cwd = root) =>
    spawnSync(command, args, { encoding: 'utf8', cwd, env: { ...env, ...overrides } });
  const run = (command, args, overrides, cwd) => {
    const result = execute(command, args, overrides, cwd);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  for (const dir of [...closure, 'one', 'two'])
    mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, 'model.cpp'), 'int model() { return 42; }\n');
  writeFileSync(path.join(root, 'main.cpp'), 'int model(); int main() { return model() == 42 ? 0 : 1; }\n');
  writeFileSync(path.join(root, 'CMakeLists.txt'), `cmake_minimum_required(VERSION 3.24)
project(native_shard_fixture LANGUAGES CXX)
enable_testing()
option(NOVELTEA_ENABLE_COVERAGE "" OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
add_library(model STATIC model.cpp)
add_executable(noveltea main.cpp)
target_link_libraries(noveltea PRIVATE model)
set_target_properties(noveltea PROPERTIES RUNTIME_OUTPUT_DIRECTORY "\${CMAKE_BINARY_DIR}/tools/editor_tool/native-cli")
add_executable(noveltea-cli-native-certify main.cpp)
target_link_libraries(noveltea-cli-native-certify PRIVATE model)
set_target_properties(noveltea-cli-native-certify PROPERTIES RUNTIME_OUTPUT_DIRECTORY "\${CMAKE_BINARY_DIR}/tools/editor_tool")
add_test(NAME setup COMMAND \${CMAKE_COMMAND} -E touch marker)
set_tests_properties(setup PROPERTIES FIXTURES_SETUP runtime)
add_test(NAME "verify [fixture]?" COMMAND /usr/bin/test -f marker)
set_tests_properties("verify [fixture]?" PROPERTIES FIXTURES_REQUIRED runtime RUN_SERIAL TRUE)
add_test(NAME cleanup COMMAND \${CMAKE_COMMAND} -E rm -f marker)
set_tests_properties(cleanup PROPERTIES FIXTURES_CLEANUP runtime)
add_test(NAME capture COMMAND \${CMAKE_COMMAND} -E touch capture)
add_test(NAME readback COMMAND /usr/bin/test -f capture)
set_tests_properties(readback PROPERTIES DEPENDS capture)
add_test(NAME lock1 COMMAND noveltea)
add_test(NAME lock2 COMMAND noveltea)
set_tests_properties(lock1 lock2 PROPERTIES RESOURCE_LOCK shared)
add_test(NAME native_authoring_project_session COMMAND noveltea)
add_test(NAME native_authoring_cli_text_stage COMMAND noveltea-cli-native-certify)
add_test(NAME native_cli_public_contract COMMAND noveltea)
add_test(NAME native_cli_daemon_owner COMMAND noveltea)
add_test(NAME native_cli_shader_validation_cache_extra COMMAND noveltea)
add_test(NAME native_cli_shader_validation_cache COMMAND \${CMAKE_COMMAND} -E false)
add_test(NAME native_cli_incremental_validation_certification COMMAND \${CMAKE_COMMAND} -E false)
add_test(NAME native_cli_dependency_mutation_certification COMMAND \${CMAKE_COMMAND} -E false)
add_test(NAME native_cli_portable_validation_cache COMMAND \${CMAKE_COMMAND} -E false)
add_test(NAME native_authoring_cli_commands COMMAND \${CMAKE_COMMAND} -E false)
add_subdirectory(one)
add_subdirectory(two)
`);
  for (const subdir of ['one', 'two'])
    writeFileSync(path.join(root, subdir, 'CMakeLists.txt'), 'add_test(NAME duplicate COMMAND noveltea)\n');
  writeFileSync(path.join(root, 'build/prebuilt-shader-assets/shader.bin'), 'shader');
  writeFileSync(path.join(root, 'build/prebuilt-shaderc-toolchain/tool'), 'tool');
  writeFileSync(path.join(root, 'editor/dist-electron/driver.mjs'), 'export {};');
  run('cmake', ['-S', root, '-B', 'build/linux-debug', '-DCMAKE_BUILD_TYPE=Debug']);
  run('cmake', ['--build', 'build/linux-debug']);
  const build = path.join(root, closure[0]);
  const cli = path.join(build, 'tools/editor_tool/native-cli');
  copyFileSync(path.join(cli, 'noveltea'), path.join(build, 'tools/editor_tool/noveltea-ui-test-runner'));
  copyFileSync(path.join(cli, 'noveltea'), path.join(cli, 'noveltea-ui-test-runner'));
  mkdirSync(path.join(cli, 'assets/system'), { recursive: true });
  mkdirSync(path.join(build, 'runtime-assets/system'), { recursive: true });
  return { execute, run };
}

test('exact Debug test artifact carries a dependency-safe and complete runnable CTest partition', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nt-native-shards-'));
  try {
    const { run, execute } = fixture(root);
    const build = path.join(root, closure[0]);
    const artifact = path.join(root, 'artifact');
    const binary = path.join(build, 'tools/editor_tool/native-cli/noveltea');
    const original = readFileSync(binary);
    symlinkSync('noveltea', path.join(path.dirname(binary), 'alias'));
    run('python3', [sharder, 'plan']);
    const plan = JSON.parse(readFileSync(path.join(root, planPath), 'utf8'));
    const tests = JSON.parse(run('ctest', ['--test-dir', build, '--show-only=json-v1'])).tests;
    const names = Object.fromEntries(Object.entries(plan.shards).map(([key, ids]) =>
      [key, ids.map(id => tests[id - 1].name)]));
    assert.deepEqual(Object.keys(names), ['native-1', 'native-2', 'native-3', 'native-4', 'cli-1', 'cli-2']);
    assert.deepEqual([...names['native-1'], ...names['native-2'], ...names['native-3'], ...names['native-4']].sort(), [
      'setup', 'verify [fixture]?', 'cleanup', 'capture', 'readback', 'lock1', 'lock2',
      'native_authoring_project_session', 'native_authoring_cli_text_stage', 'duplicate', 'duplicate',
    ].sort());
    assert.deepEqual([...names['cli-1'], ...names['cli-2']].sort(), [
      'native_cli_public_contract', 'native_cli_daemon_owner', 'native_cli_shader_validation_cache_extra',
    ].sort());
    for (const group of [['setup', 'verify [fixture]?', 'cleanup'], ['capture', 'readback'],
      ['lock1', 'lock2'], ['duplicate', 'duplicate']]) {
      assert.ok(Object.values(names).some(list =>
        group.every(name => list.includes(name)) && list.filter(name => name === group[0]).length >= group.filter(name => name === group[0]).length),
        'Connected test occurrences must remain in one shard: ' + group);
    }
    const before = readFileSync(path.join(root, planPath));
    run('python3', [sharder, 'plan']);
    assert.deepEqual(readFileSync(path.join(root, planPath)), before, 'Stable partition');
    run('bash', [transport, 'pack', artifact]);
    assert.notEqual(execute('bash', [transport, 'restore', artifact]).status, 0, 'No build overlay');
    for (const dir of closure) rmSync(path.join(root, dir), { recursive: true });
    for (const changed of [{ GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_RUN_ID: '43' },
      { GITHUB_RUN_ATTEMPT: '1' }, { GITHUB_REPOSITORY: 'Other/nt' }, { GITHUB_WORKFLOW: 'Coverage' }]) {
      assert.notEqual(execute('bash', [transport, 'restore', artifact], changed).status, 0);
      assert.ok(!existsSync(build), 'Invalid producer identity must fail before extraction');
    }
    const other = path.join(root, 'other');
    mkdirSync(other);
    assert.notEqual(execute('bash', [transport, 'restore', artifact], {}, other).status, 0);
    assert.ok(!existsSync(path.join(other, 'build')));
    mkdirSync(path.join(root, closure[3]), { recursive: true });
    assert.notEqual(execute('bash', [transport, 'restore', artifact]).status, 0, 'No Node driver overlay');
    rmSync(path.join(root, closure[3]), { recursive: true });
    const archive = path.join(artifact, 'native-test-build.tar.zst');
    const bytes = readFileSync(archive);
    writeFileSync(archive, bytes.subarray(0, bytes.length - 1));
    assert.notEqual(execute('bash', [transport, 'restore', artifact]).status, 0);
    assert.ok(!existsSync(build));
    writeFileSync(archive, bytes);
    run('bash', [transport, 'restore', artifact], { GITHUB_RUN_ATTEMPT: '3' });
    assert.deepEqual(readFileSync(binary), original);
    assert.deepEqual(readFileSync(path.join(build, 'tools/editor_tool/noveltea-ui-test-runner')), original);
    assert.deepEqual(readFileSync(path.join(path.dirname(binary), 'noveltea-ui-test-runner')), original);
    assert.equal(readlinkSync(path.join(path.dirname(binary), 'alias')), 'noveltea');
    assert.ok(!existsSync(path.join(build, 'libmodel.a')));
    assert.ok(!existsSync(path.join(build, 'CMakeFiles/model.dir/model.cpp.o')));
    assert.equal(readFileSync(path.join(root, closure[1], 'shader.bin'), 'utf8'), 'shader');
    assert.equal(readFileSync(path.join(root, closure[2], 'tool'), 'utf8'), 'tool');
    assert.equal(readFileSync(path.join(root, closure[3], 'driver.mjs'), 'utf8'), 'export {};');
    // Actual CTest runs, no recompilation or replacement executable. Each
    // shard executes only its planned registrations, including duplicate names.
    for (const [shard, ids] of Object.entries(plan.shards)) {
      const output = run('python3', [sharder, 'run', shard]);
      assert.match(output, new RegExp(`100% tests passed, 0 tests failed out of ${ids.length}\\b`));
    }
    const metadata = path.join(build, 'CTestTestfile.cmake');
    writeFileSync(metadata, readFileSync(metadata, 'utf8') + '\nadd_test(extra /usr/bin/true)\n');
    assert.notEqual(execute('python3', [sharder, 'run', 'native-1']).status, 0, 'Changed restored inventory');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a newly introduced dependency across the original Build selections fails closed', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nt-native-shard-cross-suite-'));
  try {
    const { execute, run } = fixture(root);
    const file = path.join(root, 'CMakeLists.txt');
    writeFileSync(file, readFileSync(file, 'utf8') +
      '\nset_tests_properties(native_cli_public_contract PROPERTIES DEPENDS capture)\n');
    run('cmake', ['-S', root, '-B', 'build/linux-debug']);
    const result = execute('python3', [sharder, 'plan']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /group crosses the original Build selectors/);
    assert.ok(!existsSync(path.join(root, planPath)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('Feature Lab receives exact runtime bytes without the full CTest closure', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nt-native-lab-'));
  try {
    const { run, execute } = fixture(root);
    run('python3', [sharder, 'plan']);
    const artifact = path.join(root, 'lab-artifact');
    const cli = path.join(root, closure[0], 'tools/editor_tool/native-cli');
    const bytes = readFileSync(path.join(cli, 'noveltea'));
    run('bash', [transport, 'pack', artifact, 'feature-lab']);
    for (const dir of closure) rmSync(path.join(root, dir), { recursive: true });
    assert.notEqual(execute('bash', [transport, 'restore', artifact]).status, 0, 'No profile substitution');
    run('bash', [transport, 'restore', artifact, 'feature-lab']);
    assert.deepEqual(readFileSync(path.join(cli, 'noveltea')), bytes);
    assert.deepEqual(readFileSync(path.join(cli, 'noveltea-ui-test-runner')), bytes);
    assert.ok(existsSync(path.join(root, closure[0], 'runtime-assets/system')));
    assert.ok(!existsSync(path.join(root, planPath)));
    assert.ok(!existsSync(path.join(root, closure[3])));
    run(path.join(cli, 'noveltea'), []);
    run(path.join(cli, 'noveltea-ui-test-runner'), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
