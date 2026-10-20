// #519: small, repeatable installed-CLI Project authority timing gate.
// This is deliberately independent of Feature Lab and shader compilation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const cli = path.resolve(process.argv[2] ?? 'build/cli/linux/noveltea');
const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-519-performance-'));
const baseline = path.join(root, 'legacy');
const native = path.join(root, 'native');
const envBase = { ...process.env, NOVELTEA_CLI_CERTIFICATION: '1' };

function execute(project, candidate, args, daemon = true) {
  const started = performance.now();
  const effectiveArgs = [...args];
  const output = effectiveArgs.indexOf('--output');
  if (output >= 0)
    effectiveArgs[output + 1] = path.join(
      root,
      candidate ? 'native-export.ntproject' : 'legacy-export.ntproject',
    );
  const run = spawnSync(
    cli,
    [
      ...(daemon ? [] : ['--no-daemon']),
      '--json',
      ...(project ? ['--project', project] : []),
      ...effectiveArgs,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...envBase,
        NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE: candidate ? '1' : '0',
        NOVELTEA_CLI_CERTIFICATION_POISON_LEGACY_WORKSPACE: candidate ? '1' : '0',
        NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `noveltea-519-benchmark-${process.pid}-${candidate ? 'native' : 'legacy'}`,
        NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: path.join(
          root,
          candidate ? 'native-daemon' : 'legacy-daemon',
        ),
      },
    },
  );
  assert.ifError(run.error);
  assert.equal(run.stderr, '', `JSON command emitted stderr: ${args.join(' ')}`);
  const payload = JSON.parse(run.stdout);
  assert.equal(run.status, payload.exitCode, `${args.join(' ')} failed: ${run.stdout}`);
  return { milliseconds: performance.now() - started, payload };
}

const measurements = [];
function compare(label, args, daemon = true) {
  const legacy = execute(baseline, false, args, daemon);
  const current = execute(native, true, args, daemon);
  assert.equal(current.payload.success, legacy.payload.success, `${label} semantic result changed`);
  assert.equal(current.payload.exitCode, legacy.payload.exitCode, `${label} exit category changed`);
  assert.equal(
    current.payload.success,
    true,
    `${label}: ${JSON.stringify(current.payload.diagnostics)}`,
  );
  const ratio = current.milliseconds / Math.max(legacy.milliseconds, 1);
  // Busy shared CI hosts and first-time daemon/bootstrap work have large fixed
  // jitter. Flag only *both* a 3x slowdown and >500 ms of extra wall time.
  // This detects material regressions without falsely failing tiny sub-ms
  // local work when whole-process startup dominates.
  assert.ok(
    ratio <= 3 || current.milliseconds - legacy.milliseconds <= 500,
    `${label} material regression: ${current.milliseconds.toFixed(1)}ms native vs ` +
      `${legacy.milliseconds.toFixed(1)}ms legacy (${ratio.toFixed(2)}x).`,
  );
  const row = {
    label,
    oracleMs: Math.round(legacy.milliseconds),
    nativeMs: Math.round(current.milliseconds),
    ratio: Number(ratio.toFixed(2)),
  };
  measurements.push(row);
  console.log(`  ${label}: oracle=${row.oracleMs}ms candidate=${row.nativeMs}ms (${row.ratio}x)`);
}

try {
  const created = execute(
    null,
    false,
    ['project', 'create', baseline, '--name', 'Performance Fixture'],
    false,
  );
  assert.equal(created.payload.success, true);
  await cp(baseline, native, { recursive: true });
  for (const project of [baseline, native]) {
    const room = execute(
      project,
      project === native,
      ['entity', 'create', 'rooms', 'performance'],
      false,
    );
    assert.equal(room.payload.success, true);
    const manifest = path.join(project, 'project.yaml');
    await writeFile(
      manifest,
      `${await readFile(manifest, 'utf8')}\nentrypoint:\n  kind: room\n  id: performance\n`,
    );
  }

  compare('cold standalone validation', ['validate'], false);
  // A standalone validation may persist the exact-result cache. Remove it
  // before daemon cold admission so the oracle cannot return a 20 ms cached
  // result against the candidate's actual first native Project admission.
  for (const project of [baseline, native])
    await rm(path.join(project, '.noveltea/cache'), { recursive: true, force: true });
  compare('cold daemon admission', ['validate']);
  compare('unchanged warm validation', ['validate']);

  for (const project of [baseline, native]) {
    const room = path.join(project, 'records/rooms/performance.yaml');
    await writeFile(room, `${await readFile(room, 'utf8')}\n# benchmark changed Room source\n`);
  }
  compare('one-record YAML change', ['validate']);

  for (const project of [baseline, native]) {
    const lua = path.join(project, 'scripts/bootstrap.lua');
    await writeFile(lua, `${await readFile(lua, 'utf8')}\n-- benchmark changed Lua source\n`);
  }
  compare('one-source Lua change', ['validate']);
  // No platform template or external signing credentials are necessary for
  // the Project-export admission+serialization boundary.
  compare(
    'Project export preparation',
    ['project', 'export', '--output', 'export.ntproject'],
    false,
  );
  console.log(`Native CLI performance gate PASSED: ${measurements.length} stages.`);
  console.log(JSON.stringify({ format: 'noveltea.native-cli-performance', measurements }));
} finally {
  for (const candidate of [false, true]) {
    try {
      execute(null, candidate, ['daemon', 'stop']);
    } catch {
      /* preserve the original error */
    }
  }
  await rm(root, { recursive: true, force: true });
}
