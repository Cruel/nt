import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { coverageSummary } from '../../scripts/coverage-summary.mjs';

test('coverage summaries retain separate tool metrics and uncovered counts without a gate', () => {
  assert.equal(coverageSummary('cpp', {
    line_total: 10, line_covered: 2, branch_total: 8, branch_covered: 0,
  }), '## C++ coverage\n\n| Metric | Covered / Total | Coverage |\n| --- | --- | --- |\n| Lines | 2 / 10 | 20.00% |\n| Branches | 0 / 8 | 0.00% |\n\nInformational hole detector; coverage does not prove behavioral correctness.\n');
  const editor = coverageSummary('editor', { total: {
    lines: { total: 10, covered: 5 }, functions: { total: 2, covered: 1 },
    branches: { total: 0, covered: 0 },
  } });
  assert.match(editor, /## Editor coverage/);
  assert.match(editor, /Functions \| 1 \/ 2 \| 50.00%/);
  assert.match(editor, /Branches \| 0 \/ 0 \| n\/a/);
  assert.match(coverageSummary('cpp', {
    line_total: 10, line_covered: 2, branch_total: 8, branch_covered: 0,
  }, 'Feature Lab'), /## C\+\+ coverage — Feature Lab/);
});

test('native suite snapshots remain independent and merge their coverage union', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nt-coverage-'));
  const build = path.join(root, 'build');
  const module = path.resolve('cmake/NovelTeaCoverage.cmake');
  const reporter = path.resolve('scripts/native-coverage.mjs');
  const config = readFileSync(path.resolve('cmake/gcovr.cfg'), 'utf8');
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', cwd: root });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result;
  };
  try {
    for (const directory of ['engine/src', 'deps', 'cmake']) mkdirSync(path.join(root, directory), { recursive: true });
    writeFileSync(path.join(root, 'cmake/gcovr.cfg'), config);
    writeFileSync(path.join(root, 'CMakeLists.txt'), `cmake_minimum_required(VERSION 3.24)\nproject(coverage LANGUAGES C CXX)\nset(CMAKE_EXPORT_COMPILE_COMMANDS ON)\nadd_subdirectory(deps)\nadd_subdirectory(engine)\ninclude("${module}")\n`);
    writeFileSync(path.join(root, 'deps/CMakeLists.txt'), 'add_library(dependency STATIC dep.cpp)\n');
    writeFileSync(path.join(root, 'deps/dep.cpp'), 'int dependency() { return 0; }\n');
    writeFileSync(path.join(root, 'engine/CMakeLists.txt'), 'add_library(model STATIC src/model.cpp)\nadd_executable(probe src/main.cpp)\ntarget_link_libraries(probe PRIVATE model dependency)\n');
    // Different branch results must remain observable even at -Og: an
    // optimizer is allowed to remove branches with identical outcomes.
    writeFileSync(path.join(root, 'engine/src/model.cpp'), 'int model(int value) {\n  if (value < 0) return 1;\n  if (value > 0) return 2;\n  return 0;\n}\n');
    // Exercise the same startup isolation helper used by the real native CLI,
    // rather than reproducing the per-process path convention in JavaScript.
    const isolationHeader = path.resolve('tools/editor_tool/native_cli_gcov_isolation.hpp');
    writeFileSync(path.join(root, 'engine/src/main.cpp'),
      `#include "${isolationHeader}"\nint model(int);\nint main(int argc, char**) {\n  noveltea::cli::isolate_native_cli_gcov_process();\n  return model(argc > 2 ? -1 : argc > 1 ? 0 : 1) == 1 ? 1 : 0;\n}\n`);

    run('cmake', ['-S', root, '-B', build, '-DNOVELTEA_ENABLE_COVERAGE=ON', '-DCMAKE_C_COMPILER=gcc', '-DCMAKE_CXX_COMPILER=g++']);
    run('cmake', ['--build', build]);
    run(path.join(build, 'engine/probe'), []);
    const commands = JSON.parse(readFileSync(path.join(build, 'compile_commands.json'), 'utf8'));
    assert.match(commands.find((entry) => entry.file.endsWith('model.cpp')).command, /--coverage/);
    assert.match(commands.find((entry) => entry.file.endsWith('model.cpp')).command, /-fprofile-update=atomic/);
    assert.doesNotMatch(commands.find((entry) => entry.file.endsWith('dep.cpp')).command, /--coverage/);
    const counters = path.join(build, 'engine/CMakeFiles/model.dir/src/model.cpp.gcda');
    const notes = path.join(build, 'engine/CMakeFiles/model.dir/src/model.cpp.gcno');
    assert.ok(existsSync(counters));
    const reports = path.join(root, 'reports');
    run(process.execPath, [reporter, 'report', build, path.join(reports, 'ctest')]);
    const firstSnapshot = readFileSync(path.join(reports, 'ctest/coverage.json'), 'utf8');
    run(process.execPath, [reporter, 'reset', build]);
    assert.ok(!existsSync(counters));
    assert.ok(existsSync(notes));
    // CTest A and CTest B must not write the same .gcda, including if the
    // first test has a late-exiting daemon. Their offline merge must retain
    // counters from both tests without introducing runtime merge errors.
    const isolated = build + '.gcov-cli';
    const isolatedRun = (name, args) => {
      const cli = spawnSync(path.join(build, 'engine/probe'), args, {
        env: { ...process.env, GCOV_PREFIX: path.join(isolated, name), GCOV_PREFIX_STRIP: '0' },
        encoding: 'utf8',
      });
      assert.equal(cli.status, 0, cli.stderr);
    };
    isolatedRun('native_cli_test_a', []);
    isolatedRun('native_cli_test_b', ['other-branch']);
    // Long-lived daemon/owner workers write to their own PID-specific
    // siblings, never the foreground CLI's per-test .gcda files. The offline
    // merger must include these process-specific roots too.
    isolatedRun('native_cli_test_a.process-99999999', ['other-branch']);
    // Multiple foreground invocations from one Python CTest may overlap and
    // exit in any order. They must not touch the shared per-test .gcda, even
    // when GCOV_PREFIX initially points to the same directory for all six.
    const concurrentRoot = path.join(isolated, 'native_cli_test_concurrent');
    const jobs = Array.from({ length: 6 }, (_, i) => new Promise((resolve, reject) => {
      const child = spawn(path.join(build, 'engine/probe'), i % 2 ? ['other-branch'] : [], {
        env: {
          ...process.env,
          NOVELTEA_NATIVE_CLI_GCOV_ROOT: concurrentRoot,
          GCOV_PREFIX: concurrentRoot,
          GCOV_PREFIX_STRIP: '0',
        },
        stdio: 'ignore',
      });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`probe exited ${code}`)));
    }));
    await Promise.all(jobs);
    const privateRoots = readdirSync(isolated).filter((name) =>
      /^native_cli_test_concurrent\.process-[1-9][0-9]*$/.test(name));
    assert.equal(privateRoots.length, 6);
    assert.ok(!existsSync(path.join(concurrentRoot, build.replace(/^\/+/, ''),
      'engine/CMakeFiles/model.dir/src/model.cpp.gcda')));
    for (const name of privateRoots) {
      assert.ok(existsSync(path.join(isolated, name, build.replace(/^\/+/, ''),
        'engine/CMakeFiles/model.dir/src/model.cpp.gcda')));
    }

    // Simulate an instrumented detached owner that is still alive when its
    // CTest has finished. Its profile does not exist until the process exits.
    // Snapshotting immediately silently omits this coverage; a snapshot
    // during a real daemon's libgcov exit can corrupt the file instead.
    const late = spawn('bash', ['-c',
      'export GCOV_PREFIX="$GCOV_ROOT/native_cli_test_late.process-$$"; sleep 0.4; exec "$1" "$2"',
      '_', path.join(build, 'engine/probe'), 'other-branch'], {
      env: { ...process.env, GCOV_ROOT: isolated, GCOV_PREFIX_STRIP: '0' },
      stdio: 'ignore',
    });
    assert.ok(late.pid > 0);
    mkdirSync(path.join(isolated, `native_cli_test_late.process-${late.pid}`), {
      recursive: true,
    });
    assert.ok(!existsSync(counters));
    const redirected = path.join(isolated, 'native_cli_test_a', build.replace(/^\/+/, ''),
      'engine/CMakeFiles/model.dir/src/model.cpp.gcda');
    assert.ok(existsSync(redirected));
    assert.ok(existsSync(redirected.replace('native_cli_test_a', 'native_cli_test_b')));
    assert.ok(existsSync(redirected.replace('native_cli_test_a', 'native_cli_test_a.process-99999999')));
    const restored = run(process.execPath, [reporter, 'restore-isolated', build]);
    assert.match(restored.stdout, /Restored merged native CLI coverage from 10 isolated roots/);
    assert.ok(existsSync(counters));
    run(process.execPath, [reporter, 'report', build, path.join(reports, 'ctest-cli')]);
    const first = JSON.parse(readFileSync(path.join(reports, 'ctest/summary.json'), 'utf8'));
    const isolatedMerged = JSON.parse(readFileSync(path.join(reports, 'ctest-cli/summary.json'), 'utf8'));
    assert.ok(isolatedMerged.branch_covered > first.branch_covered);
    run(process.execPath, [reporter, 'reset', build]);
    run(path.join(build, 'engine/probe'), ['other-branch']);
    run(process.execPath, [reporter, 'report', build, path.join(reports, 'feature-lab')]);
    const unrelated = spawnSync(path.join(build, 'engine/probe'), ['negative', 'branch']);
    assert.equal(unrelated.status, 1);
    run(process.execPath, [reporter, 'merge', reports]);
    const summary = (suite) => JSON.parse(readFileSync(path.join(reports, suite, 'summary.json'), 'utf8'));
    const ctest = summary('ctest');
    const lab = summary('feature-lab');
    const combined = summary('combined');
    assert.equal(ctest.branch_total, lab.branch_total);
    assert.equal(combined.branch_total, ctest.branch_total);
    assert.ok(combined.branch_covered > ctest.branch_covered);
    assert.ok(combined.branch_covered > lab.branch_covered);
    assert.ok(combined.branch_covered < ctest.branch_covered + lab.branch_covered);
    assert.ok(combined.branch_covered < combined.branch_total);
    assert.equal(readFileSync(path.join(reports, 'ctest/coverage.json'), 'utf8'), firstSnapshot);
    for (const suite of ['ctest', 'ctest-cli', 'feature-lab', 'combined']) {
      assert.ok(existsSync(path.join(reports, suite, 'index.html')));
      const files = JSON.parse(readFileSync(path.join(reports, suite, 'coverage.json'), 'utf8')).files;
      assert.ok(files.length > 0);
      assert.ok(files.every((file) => file.file.startsWith('engine/src/')));
    }
    run('cmake', ['-S', root, '-B', build, '-DNOVELTEA_ENABLE_COVERAGE=OFF']);
    const normalCommands = JSON.parse(readFileSync(path.join(build, 'compile_commands.json'), 'utf8'));
    for (const entry of normalCommands) assert.doesNotMatch(entry.command, /--coverage/);
    const rejectedReset = spawnSync(process.execPath, [reporter, 'reset', build], { encoding: 'utf8' });
    assert.notEqual(rejectedReset.status, 0);
    assert.match(rejectedReset.stderr, /Counter reset requires a NOVELTEA_ENABLE_COVERAGE=ON build/);
    assert.ok(existsSync(counters));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing or malformed coverage is not silently reported as zero coverage', () => {
  assert.throws(() => coverageSummary('cpp', {}));
  assert.throws(() => coverageSummary('editor', { total: {} }));
  assert.throws(() => coverageSummary('combined', {}));
});
