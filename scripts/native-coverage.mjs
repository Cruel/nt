import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

// GCC 13 writes a 16-byte gcda header followed by tagged records (negative
// record lengths encode zero counter blocks) and a final zero tag. gcov-tool
// can silently accept a truncated file, or crash later when merging it with
// a complete profile. Check record boundaries before admitting snapshots.
export function assertCompleteGcda(file) {
  const bytes = readFileSync(file);
  let offset = 16;
  let functionRecords = 0;
  const fail = () => {
    throw new Error(
      `Incomplete GCC gcov profile (${bytes.length} bytes, ${functionRecords} functions, offset ${offset}): ${file}`,
    );
  };
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'adcg') fail();
  while (offset + 4 <= bytes.length) {
    const tag = bytes.readUInt32LE(offset);
    if (tag === 0) {
      if (offset + 4 === bytes.length && functionRecords > 0) return;
      fail();
    }
    if (offset + 8 > bytes.length) fail();
    const length = bytes.readInt32LE(offset + 4);
    if (tag === 0x01000000) functionRecords++;
    offset += 8 + Math.max(0, length);
    if (offset > bytes.length) fail();
  }
  fail();
}

function assertCompleteCounterTree(directory, evidenceRoot, profileName) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      assertCompleteCounterTree(file, evidenceRoot, profileName);
    } else if (entry.isFile() && entry.name.endsWith('.gcda')) {
      try {
        assertCompleteGcda(file);
      } catch (error) {
        // Keep only the failed input, never a gigabyte-scale gcov build tree.
        // Coverage's existing artifact-upload step preserves this diagnostic.
        mkdirSync(evidenceRoot, { recursive: true });
        const digest = createHash('sha256').update(file).digest('hex').slice(0, 12);
        const evidence = path.join(evidenceRoot, `${profileName}-${digest}.gcda`);
        if (statSync(file).size <= 16 * 1024 * 1024) copyFileSync(file, evidence);
        writeFileSync(`${evidence}.txt`, `${error.message}\n`);
        throw error;
      }
    }
  }
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

function terminatedCoverageRoots(isolated) {
  const excluded = new Set();
  for (const entry of readdirSync(isolated, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^native_(?:cli|authoring_cli)_[a-z0-9_]+$/.test(entry.name))
      continue;
    const manifest = path.join(isolated, entry.name, 'terminated-process-pids.txt');
    if (!existsSync(manifest)) continue;
    const contents = readFileSync(manifest, 'utf8');
    if (!/^(?:[1-9][0-9]*\n)*$/.test(contents)) {
      throw new Error(`Invalid terminated-process coverage manifest: ${manifest}`);
    }
    const pids = contents.trim().split('\n').filter(Boolean);
    // Independent CTest and broker observers can record the same signal;
    // duplicate PID evidence is harmless, but an unbounded log is not.
    if (pids.length > 1024) {
      throw new Error(`Invalid terminated-process PID inventory in ${manifest}`);
    }
    for (const pid of pids) excluded.add(`${entry.name}.process-${pid}`);
  }
  return excluded;
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
  const terminated = terminatedCoverageRoots(isolated);
  const work = mkdtempSync(path.join(process.env.RUNNER_TEMP || tmpdir(), 'noveltea-gcov-merge-'));
  const snapshots = [];
  try {
    const skipped = [];
    for (const entry of readdirSync(isolated, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (terminated.has(entry.name)) {
        skipped.push(entry.name);
        continue;
      }
      // GCOV_PREFIX_STRIP=0 retains the absolute object directory beneath each test root.
      const source = path.join(isolated, entry.name, build.slice(path.parse(build).root.length));
      if (!existsSync(source) || !containsCounters(source)) continue;
      assertCompleteCounterTree(
        source,
        path.join(path.dirname(build), 'reports/coverage/cpp/diagnostics'),
        entry.name,
      );
      const snapshot = path.join(work, `test-${snapshots.length}`);
      cpSync(source, snapshot, { recursive: true });
      snapshots.push({ directory: snapshot, source: entry.name });
    }
    if (!snapshots.length) {
      throw new Error(`No isolated native CLI coverage counters in ${isolated}`);
    }
    if (skipped.length) {
      console.log(
        `Excluded ${skipped.length} deliberately terminated native CLI PID roots from gcov merge: ${skipped.sort().join(', ')}`,
      );
    }

    // Pairwise rounds keep the merge tree balanced. Merging each process
    // directly into an ever-growing accumulator reprocesses earlier gcov
    // profiles O(N²) times when a CTest launches hundreds of CLI invocations.
    let layer = snapshots;
    for (let round = 0; layer.length > 1; ++round) {
      const next = [];
      for (let index = 0; index < layer.length; index += 2) {
        if (index + 1 >= layer.length) {
          next.push(layer[index]);
          continue;
        }
        const left = layer[index];
        const right = layer[index + 1];
        const output = path.join(work, `merged-${round}-${index / 2}`);
        const result = spawnSync(
          'gcov-tool',
          ['merge', '-o', output, left.directory, right.directory],
          { encoding: 'utf8' },
        );
        if (result.error) throw result.error;
        if (result.status !== 0) {
          throw new Error(
            `gcov-tool merge failed for ${left.source} + ${right.source}: ${result.stdout}${result.stderr}`,
          );
        }
        rmSync(left.directory, { recursive: true, force: true });
        rmSync(right.directory, { recursive: true, force: true });
        next.push({ directory: output, source: `${left.source} + ${right.source}` });
      }
      layer = next;
    }
    const merged = layer[0].directory;
    // This is the only writer to the reporting tree. All instrumented CLI
    // processes write solely to their own per-test GCOV_PREFIX.
    resetCoverageCounters(build);
    cpSync(merged, build, { recursive: true });
    console.log(`Restored merged native CLI coverage from ${snapshots.length} isolated roots.`);
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
