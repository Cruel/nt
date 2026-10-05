import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

test('native suite snapshots remain independent and merge their coverage union', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nt-coverage-'));
  const build = path.join(root, 'build');
  const module = path.resolve('cmake/NovelTeaCoverage.cmake');
  const reporter = path.resolve('scripts/native-coverage.mjs');
  const config = readFileSync(path.resolve('cmake/gcovr.cfg'), 'utf8');
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', cwd: root });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  try {
    for (const directory of ['engine/src', 'deps', 'cmake']) mkdirSync(path.join(root, directory), { recursive: true });
    writeFileSync(path.join(root, 'cmake/gcovr.cfg'), config);
    writeFileSync(path.join(root, 'CMakeLists.txt'), `cmake_minimum_required(VERSION 3.24)\nproject(coverage LANGUAGES C CXX)\nset(CMAKE_EXPORT_COMPILE_COMMANDS ON)\nadd_subdirectory(deps)\nadd_subdirectory(engine)\ninclude("${module}")\n`);
    writeFileSync(path.join(root, 'deps/CMakeLists.txt'), 'add_library(dependency STATIC dep.cpp)\n');
    writeFileSync(path.join(root, 'deps/dep.cpp'), 'int dependency() { return 0; }\n');
    writeFileSync(path.join(root, 'engine/CMakeLists.txt'), 'add_library(model STATIC src/model.cpp)\nadd_executable(probe src/main.cpp)\ntarget_link_libraries(probe PRIVATE model dependency)\n');
    writeFileSync(path.join(root, 'engine/src/model.cpp'), 'int model(int value) {\n  if (value < 0) return 1;\n  if (value > 0) {\n    return 0;\n  }\n  return 0;\n}\n');
    writeFileSync(path.join(root, 'engine/src/main.cpp'), 'int model(int);\nint main(int argc, char**) { return model(argc > 2 ? -1 : argc > 1 ? 0 : 1); }\n');
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
    for (const suite of ['ctest', 'feature-lab', 'combined']) {
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
