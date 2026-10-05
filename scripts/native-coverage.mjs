import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function resetCoverageCounters(buildDirectory) {
  const cache = readFileSync(path.join(buildDirectory, 'CMakeCache.txt'), 'utf8');
  if (!/^NOVELTEA_ENABLE_COVERAGE:BOOL=ON$/m.test(cache)) {
    throw new Error('Counter reset requires a NOVELTEA_ENABLE_COVERAGE=ON build');
  }
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
  } else {
    throw new Error('Usage: native-coverage.mjs reset <build> | report <build> <output> | merge <output-root>');
  }
}
