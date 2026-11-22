import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function requireCoverageBuild(buildDirectory) {
  const cache = readFileSync(path.join(buildDirectory, 'CMakeCache.txt'), 'utf8');
  if (!/^NOVELTEA_ENABLE_COVERAGE:BOOL=ON$/m.test(cache)) {
    throw new Error('Counter reset requires a NOVELTEA_ENABLE_COVERAGE=ON build');
  }
}

export function resetCoverageCounters(buildDirectory) {
  requireCoverageBuild(buildDirectory);
  let removed = 0;
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.gcda')) {
        rmSync(file);
        removed++;
      }
    }
  }
  visit(buildDirectory);
  return removed;
}

function containsCounters(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.gcda')) return true;
    if (entry.isDirectory() && containsCounters(path.join(directory, entry.name))) return true;
  }
  return false;
}

// A native broker can finish its CTest parent while an orphaned owner is
// still flushing libgcov at process exit. A recursively copied .gcda at that
// instant is neither a complete snapshot nor a valid merge input. Per-PID
// paths are only useful if the process that owns them is known to be done.
function nativeProcessRunning(pid) {
  try {
    // On Linux a terminated child can temporarily remain as a zombie. It
    // has already finished its gcov writes and need not await parent reaping.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterName = stat.slice(stat.lastIndexOf(')') + 2);
    return afterName[0] !== 'Z' && afterName[0] !== 'X';
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return false;
    throw error;
  }
}

function awaitExitedCoverageProcesses(isolated) {
  const pending = readdirSync(isolated, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const match = /\.process-([1-9][0-9]*)$/.exec(entry.name);
      return match ? [{ name: entry.name, pid: Number(match[1]) }] : [];
    });
  if (!pending.length) return;
  if (process.platform !== 'linux') {
    throw new Error('Native process coverage quiescence requires Linux /proc.');
  }
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 30000;
  while (true) {
    const live = pending.filter(({ pid }) => nativeProcessRunning(pid));
    if (!live.length) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Instrumented native daemon processes have not exited; refusing to snapshot live .gcda: ${live.map(({ name }) => name).join(', ')}`,
      );
    }
    Atomics.wait(sleep, 0, 0, 75);
  }
}

export function restoreIsolatedCoverageCounters(buildDirectory) {
  requireCoverageBuild(buildDirectory);
  const build = path.resolve(buildDirectory);
  // Per-test GCOV_PREFIX roots and per-PID broker/worker sibling roots are
  // configured by tools/editor_tool/CMakeLists.txt and native_cli.cpp.
  // Each is a separate directory beside (not inside) the build directory.
  const isolated = build + '.gcov-cli';
  awaitExitedCoverageProcesses(isolated);
  const work = mkdtempSync(path.join(process.env.RUNNER_TEMP || tmpdir(), 'noveltea-gcov-merge-'));
  let merged = null;
  let count = 0;
  try {
    for (const entry of readdirSync(isolated, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // GCOV_PREFIX_STRIP=0 retains the absolute object directory beneath each test root.
      const source = path.join(isolated, entry.name, build.slice(path.parse(build).root.length));
      if (!existsSync(source) || !containsCounters(source)) continue;
      // Snapshot before merging; a detached test daemon can still write to
      // its own root, but cannot change another test or the merged snapshot.
      const snapshot = path.join(work, `test-${count}`);
      cpSync(source, snapshot, { recursive: true });
      if (merged === null) {
        merged = snapshot;
      } else {
        const output = path.join(work, `merged-${count}`);
        const result = spawnSync('gcov-tool', ['merge', '-o', output, merged, snapshot], {
          encoding: 'utf8',
        });
        if (result.error) throw result.error;
        if (result.status !== 0) {
          throw new Error(`gcov-tool merge failed for ${entry.name}: ${result.stdout}${result.stderr}`);
        }
        merged = output;
      }
      count++;
    }
    if (!merged) throw new Error(`No isolated native CLI coverage counters in ${isolated}`);
    // This is the only writer to the reporting tree. All instrumented CLI
    // processes write solely to their own per-test GCOV_PREFIX.
    resetCoverageCounters(build);
    cpSync(merged, build, { recursive: true });
    console.log(`Restored merged native CLI coverage from ${count} isolated tests.`);
  } finally {
    rmSync(work, { recursive: true, force: true });
    // Do not delete the per-test roots: late daemon exits may still write there.
  }
}

function gcovr(arguments_) {
  const result = spawnSync('uv', ['tool', 'run', 'gcovr==8.4', '--config', 'cmake/gcovr.cfg', ...arguments_], {
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`gcovr failed with exit status ${result.status}`);
}

function reportOutputs(directory) {
  mkdirSync(directory, { recursive: true });
  return [
    '--html-details', path.join(directory, 'index.html'),
    '--json', path.join(directory, 'coverage.json'),
    '--json-summary', path.join(directory, 'summary.json'),
    '--xml', path.join(directory, 'cobertura.xml'),
  ];
}

export function snapshotCoverage(buildDirectory, outputDirectory) {
  gcovr([buildDirectory, ...reportOutputs(outputDirectory)]);
}

export function mergeCoverage(outputRoot) {
  // Read only frozen suite snapshots, never the live counters of the last suite.
  gcovr([
    '--add-tracefile', path.join(outputRoot, 'ctest/coverage.json'),
    '--add-tracefile', path.join(outputRoot, 'ctest-cli/coverage.json'),
    '--add-tracefile', path.join(outputRoot, 'feature-lab/coverage.json'),
    ...reportOutputs(path.join(outputRoot, 'combined')),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , command, input, output] = process.argv;
  if (command === 'reset' && input && !output) {
    console.log(`Removed ${resetCoverageCounters(input)} coverage counter files.`);
  } else if (command === 'report' && input && output) {
    snapshotCoverage(input, output);
  } else if (command === 'merge' && input && !output) {
    mergeCoverage(input);
  } else if (command === 'restore-isolated' && input && !output) {
    restoreIsolatedCoverageCounters(input);
  } else {
    throw new Error('Usage: native-coverage.mjs reset <build> | report <build> <output> | merge <output-root> | restore-isolated <build>');
  }
}
