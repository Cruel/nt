import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function diagnosticOptions(env = process.env) {
  const scenario = env.NT_DIAGNOSTIC_SCENARIO ?? 'empty-playback';
  const iterations = Number(env.NT_DIAGNOSTIC_ITERATIONS ?? '20');
  if (!['empty-playback', 'feature-lab', 'certification'].includes(scenario))
    throw new Error(`Unknown diagnostic scenario: ${scenario}`);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 50)
    throw new Error('Diagnostic iterations must be an integer between 1 and 50.');
  return { scenario, iterations: scenario === 'certification' ? 1 : iterations };
}

export async function recordCommand({ command, args, cwd, env, root, label, stdinPath, timeoutMs = 600_000 }) {
  if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid diagnostic command label.');
  const directory = path.join(root, 'commands', label);
  await mkdir(directory, { recursive: true });
  const stdout = openSync(path.join(directory, 'stdout.log'), 'w');
  const stderr = openSync(path.join(directory, 'stderr.log'), 'w');
  const stdin = stdinPath ? openSync(stdinPath, 'r') : undefined;
  const started = Date.now();
  let timedOut = false;
  let spawnError;
  let result;
  try {
    result = await new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd, env, stdio: [stdin ?? 'ignore', stdout, stderr], detached: process.platform !== 'win32',
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        if (!child.pid) return;
        if (process.platform === 'win32') {
          spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
            if (error.code !== 'ESRCH') spawnError = error.message;
          }
        }
      }, timeoutMs);
      child.on('error', (error) => { spawnError = error.message; });
      child.on('close', (exitCode, signal) => {
        clearTimeout(timeout);
        resolve({ exitCode, signal });
      });
    });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
    if (stdin !== undefined) closeSync(stdin);
  }
  const record = {
    label, command, args, cwd, stdinPath, ...result, timedOut, spawnError,
    durationMs: Date.now() - started,
    success: result.exitCode === 0 && !timedOut && !spawnError,
  };
  await writeFile(path.join(directory, 'result.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export async function prepareShaderFreeFixture(root) {
  for (const collection of ['shaders', 'materials'])
    await rm(path.join(root, 'records', collection), { recursive: true, force: true });
  const foyerPath = path.join(root, 'records/rooms/foyer.json');
  const foyer = JSON.parse(await readFile(foyerPath, 'utf8'));
  foyer.data.background.material = null;
  await writeFile(foyerPath, `${JSON.stringify(foyer, null, 2)}\n`);
  await writeFile(path.join(root, 'records/layouts/fixture-hud/layout.lua'),
    'local room_id = "gallery"\nfunction save_and_reload() Game.save("fixture"); Game.load("fixture") end\n');
}

async function main() {
  const options = diagnosticOptions();
  const root = path.resolve(process.env.NT_DIAGNOSTIC_ROOT ?? 'build/cli-diagnostics');
  const cli = path.resolve(process.env.NOVELTEA_CLI_PATH ?? 'build/cli/windows/noveltea.exe');
  const summary = { ...options, status: 'running', commands: [] };
  await mkdir(root, { recursive: true });
  const save = () => writeFile(path.join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const invoke = async (label, command, args, extra = {}) => {
    const record = await recordCommand({ command, args, cwd: repositoryRoot, env: process.env, root, label, ...extra });
    summary.commands.push(record);
    await save();
    console.log(`${label}: ${record.success ? 'PASS' : 'FAIL'} (${record.durationMs} ms)`);
    if (!record.success) throw new Error(`${label} failed; see commands/${label} and invocations artifacts.`);
    return record;
  };
  try {
    await save();
    if (options.scenario === 'certification') {
      await invoke('certification', process.execPath, ['editor/scripts/certify-noveltea-cli.mjs'], { timeoutMs: 1_800_000 });
    } else {
      const project = path.join(root, 'project');
      // Keep fixtures and generated caches alongside evidence for offline request replay.
      await rm(project, { recursive: true, force: true });
      if (options.scenario === 'empty-playback') {
        await invoke('materialize', process.execPath, [
          'editor/dist-electron/tools/materialize-platform-export-fixture.mjs', '--root', project, '--target', 'web',
        ]);
        await prepareShaderFreeFixture(project);
        await invoke('create-test', cli, ['--project', project, '--json', 'entity', 'create', 'tests', 'cache-certification']);
      } else {
        await cp(path.join(repositoryRoot, 'tests/projects/feature-lab'), project, { recursive: true });
      }
      const specPath = path.join(root, 'empty-playback.json');
      await writeFile(specPath, `${JSON.stringify({
        schema: 'noveltea.editor.playback', version: 1, id: 'certification-empty', steps: [], finalExpectations: [],
      })}\n`);
      for (let iteration = 1; iteration <= options.iterations; iteration++) {
        await rm(path.join(project, '.noveltea/cache/runtime'), { recursive: true, force: true });
        for (const temperature of ['cold', 'warm']) {
          const label = `${options.scenario}-${iteration}-${temperature}`;
          if (options.scenario === 'empty-playback') {
            await invoke(label, cli, ['--project', project, '--json', 'test', 'run-ui-spec'], { stdinPath: specPath });
          } else {
            await invoke(label, cli, ['--project', project, '--json', 'test', 'run']);
          }
        }
      }
    }
    summary.status = 'passed';
  } catch (error) {
    summary.status = 'failed';
    summary.error = error.message;
    process.exitCode = 1;
    console.error(error.message);
  } finally {
    await save();
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(process.env.GITHUB_STEP_SUMMARY,
        `## Windows CLI diagnostics\n\nScenario: **${options.scenario}**; result: **${summary.status}**.\n\n` +
        'See the diagnostic artifact for summary.json, per-command logs, captured native requests, debugger logs, and any crash dump.\n');
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
