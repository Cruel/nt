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
});

test('native instrumentation records execution without instrumenting dependency targets', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nt-coverage-'));
  const build = path.join(root, 'build');
  const module = path.resolve('cmake/NovelTeaCoverage.cmake');
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  try {
    for (const directory of ['engine', 'deps']) mkdirSync(path.join(root, directory));
    writeFileSync(path.join(root, 'CMakeLists.txt'), `cmake_minimum_required(VERSION 3.24)\nproject(coverage LANGUAGES C CXX)\nset(CMAKE_EXPORT_COMPILE_COMMANDS ON)\nadd_subdirectory(deps)\nadd_subdirectory(engine)\ninclude("${module}")\n`);
    writeFileSync(path.join(root, 'deps/CMakeLists.txt'), 'add_library(dependency STATIC dep.cpp)\n');
    writeFileSync(path.join(root, 'deps/dep.cpp'), 'int dependency() { return 0; }\n');
    writeFileSync(path.join(root, 'engine/CMakeLists.txt'), 'add_library(model STATIC model.cpp)\nadd_executable(probe main.cpp)\ntarget_link_libraries(probe PRIVATE model dependency)\n');
    writeFileSync(path.join(root, 'engine/model.cpp'), 'int model(int value) { if (value > 0) return 0; return 1; }\n');
    writeFileSync(path.join(root, 'engine/main.cpp'), 'int model(int); int main() { return model(1); }\n');
    run('cmake', ['-S', root, '-B', build, '-DNOVELTEA_ENABLE_COVERAGE=ON', '-DCMAKE_C_COMPILER=gcc', '-DCMAKE_CXX_COMPILER=g++']);
    run('cmake', ['--build', build]);
    run(path.join(build, 'engine/probe'), []);
    const commands = JSON.parse(readFileSync(path.join(build, 'compile_commands.json'), 'utf8'));
    assert.match(commands.find((entry) => entry.file.endsWith('model.cpp')).command, /--coverage/);
    assert.doesNotMatch(commands.find((entry) => entry.file.endsWith('dep.cpp')).command, /--coverage/);
    assert.ok(existsSync(path.join(build, 'engine/CMakeFiles/model.dir/model.cpp.gcda')));
    run('cmake', ['-S', root, '-B', build, '-DNOVELTEA_ENABLE_COVERAGE=OFF']);
    const normalCommands = JSON.parse(readFileSync(path.join(build, 'compile_commands.json'), 'utf8'));
    for (const entry of normalCommands) assert.doesNotMatch(entry.command, /--coverage/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing or malformed coverage is not silently reported as zero coverage', () => {
  assert.throws(() => coverageSummary('cpp', {}));
  assert.throws(() => coverageSummary('editor', { total: {} }));
  assert.throws(() => coverageSummary('combined', {}));
});
