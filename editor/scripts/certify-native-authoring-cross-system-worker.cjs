const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const [addon, cli] = process.argv.slice(2);
const production = process.argv[4] === '--production';
const candidate = process.argv[4] === '--candidate';
const workerScript = path.resolve('dist-electron/authoring-worker/native-authoring-worker.cjs');
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const cacheFile = (root) => path.join(root, '.noveltea/cache/authoring/native-clean-current.json');
const nativeEnv =
  production || candidate
    ? { ...process.env }
    : {
        ...process.env,
        NOVELTEA_CLI_CERTIFICATION: '1',
        NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE: '1',
        NOVELTEA_CLI_CERTIFICATION_POISON_LEGACY_WORKSPACE: '1',
      };

function runCli(root, project, args, daemon = false) {
  const run = spawnSync(
    cli,
    [
      ...(daemon ? [] : ['--no-daemon']),
      '--json',
      ...(project ? ['--project', project] : []),
      ...args,
    ],
    {
      cwd: root,
      env:
        production || candidate
          ? nativeEnv
          : {
              ...nativeEnv,
              NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `noveltea-520-${process.pid}`,
              NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: path.join(root, 'daemon'),
            },
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  assert.ifError(run.error);
  assert.equal(run.stderr, '', `CLI stderr for ${args.join(' ')}`);
  const result = JSON.parse(run.stdout);
  assert.equal(run.status, result.exitCode, `${args.join(' ')}: ${run.stdout}`);
  assert.equal(result.success, true, `${args.join(' ')}: ${run.stdout}`);
  return result;
}

/** Keep the CLI daemon request live while the independent editor worker
 * saves. Unlike spawnSync this does not block delivery of worker replies. */
async function runCliConcurrent(root, project, args) {
  const child = spawn(cli, ['--json', '--project', project, ...args], {
    cwd: root,
    env:
      production || candidate
        ? nativeEnv
        : {
            ...nativeEnv,
            NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `noveltea-520-${process.pid}`,
            NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: path.join(root, 'daemon'),
          },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(stderr, '', 'Concurrent CLI wrote stderr');
  const response = JSON.parse(stdout);
  assert.equal(status, response.exitCode, `Concurrent CLI exit: ${stdout}`);
  // The native transaction lock is intentionally nonblocking across
  // independent writers. BUSY is a valid safe rejection, not a partial write.
  if (!response.success) {
    assert.ok(status === 4 || status === 5, stdout);
    assert.ok(
      response.diagnostics.some(
        (d) => d.code === 'WORKSPACE_BUSY' || /WORKSPACE_BUSY/u.test(d.message),
      ),
      stdout,
    );
  }
  return response;
}

function editorSession(root, name) {
  const worker = new Worker(workerScript, {
    workerData: { addonPath: addon, root, sessionId: name, generation: 1, pollIntervalMs: 80 },
  });
  const messages = [];
  let counter = 0;
  worker.on('message', (message) => messages.push(message));

  function until(predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error('Timed out waiting for native Project worker')),
        25000,
      );
      const fail = (error) => finish(error);
      const onMessage = (message) => {
        if (message.type === 'failure') finish(new Error(message.error));
        else if (predicate(message)) finish(null, message);
      };
      function finish(error, value) {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', fail);
        worker.off('exit', onExit);
        if (error) reject(error);
        else resolve(value);
      }
      const onExit = (code) => finish(new Error(`Native worker exited: ${code}`));
      worker.on('message', onMessage);
      worker.on('error', fail);
      worker.on('exit', onExit);
      for (const message of messages) onMessage(message);
    });
  }

  return {
    open: () => until((event) => event.type === 'snapshot'),
    request: async (operation, fields = {}) => {
      const requestId = ++counter;
      const pending = until((event) => event.type === 'response' && event.requestId === requestId);
      worker.postMessage({ requestId, operation, ...fields });
      return (await pending).result;
    },
    delta: (file) =>
      until((event) => event.type === 'delta' && event.changedSourcePaths.includes(file)),
    close: () => worker.terminate(),
  };
}

async function checkCache(root, paths) {
  const value = JSON.parse(await readFile(cacheFile(root), 'utf8'));
  assert.equal(value.contract, 'noveltea.native-clean-validation.v1');
  assert.ok(value.semanticKey && value.semanticFingerprint, 'Native semantic proof missing');
  assert.equal(value.projectRoot, (await realpath(root)).replaceAll(path.sep, '/'));
  for (const revision of Object.values(value.revisions))
    assert.match(
      revision,
      /^(?:absent|sha256:[0-9a-f]{64})$/,
      'Cache contains an unproved source revision',
    );
  for (const file of paths)
    assert.equal(value.revisions[file], sha(await readFile(path.join(root, file))), file);
  return value;
}

async function main() {
  // The independently launched CLI's broker uses this scratch directory as
  // its socket root. macOS's long per-user TMPDIR can exceed sun_path before
  // the broker appends /daemon-<identity>.sock.
  const scratch = await mkdtemp(
    process.platform === 'darwin'
      ? '/tmp/nt-x-'
      : path.join(os.tmpdir(), 'noveltea-520-cross-system-'),
  );
  const project = path.join(scratch, 'project');
  const sessions = [];
  try {
    runCli(scratch, null, ['project', 'create', project, '--name', 'Saved Project']);
    runCli(scratch, project, ['entity', 'create', 'rooms', 'intro']);
    const manifestPath = path.join(project, 'project.yaml');
    await writeFile(
      manifestPath,
      `${await readFile(manifestPath, 'utf8')}\nentrypoint:\n  kind: room\n  id: intro\n`,
    );

    const editor = editorSession(project, 'editor-dirty');
    sessions.push(editor);
    const opened = await editor.open();
    assert.equal(opened.snapshot.workingRevision, 0);
    const cold = await editor.request('validateClean');
    assert.equal(cold.valid, true, JSON.stringify(cold.diagnostics));
    assert.equal(cold.cacheHit, false, 'First editor session must validate disk, not fake a hit');
    const originalCache = await checkCache(project, ['project.yaml', 'records/rooms/intro.yaml']);

    // The independently launched CLI must admit the editor's exact semantic
    // and physical cache entry; a miss would republish and change its mtime.
    const oldDate = new Date('2001-01-01T00:00:00.000Z');
    await utimes(cacheFile(project), oldDate, oldDate);
    const oldMtime = (await stat(cacheFile(project))).mtimeMs;
    const cliValidation = runCli(scratch, project, ['validate'], true);
    const cacheAfterCli = (await stat(cacheFile(project))).mtimeMs;
    if (cacheAfterCli !== oldMtime) {
      const republished = JSON.parse(await readFile(cacheFile(project), 'utf8'));
      const differences = Object.fromEntries(
        [
          'contract',
          'semanticKey',
          'semanticFingerprint',
          'projectRoot',
          'revisions',
          'result',
          'resident',
        ]
          .filter(
            (field) => JSON.stringify(originalCache[field]) !== JSON.stringify(republished[field]),
          )
          .map((field) => [field, { editor: originalCache[field], cli: republished[field] }]),
      );
      throw new Error(
        `CLI missed editor cache: ${JSON.stringify({
          differences,
          cliCacheHit: cliValidation.native?.cacheHit,
          nativeResult: cliValidation.native,
        }).slice(0, 15000)}`,
      );
    }

    const changed = await editor.request('patch', {
      expectedRevision: 0,
      patches: [{ operation: 'replace', path: '/project/name', value: 'Unsaved editor draft' }],
    });
    assert.equal(changed.accepted, true, changed.error);
    assert.equal(changed.snapshot.dirty, true);
    assert.equal((await readFile(manifestPath, 'utf8')).includes('Unsaved editor draft'), false);
    runCli(scratch, project, ['validate']);
    assert.equal((await stat(cacheFile(project))).mtimeMs, oldMtime);
    assert.equal(
      (await editor.request('validateClean')).cacheHit,
      false,
      'Dirty editor used disk cache',
    );

    // CLI's own transaction is observed by the still-dirty editor without
    // making the CLI share that working Project's unsaved name.
    runCli(scratch, project, ['entity', 'create', 'rooms', 'created-by-cli'], true);
    const added = await editor.delta('records/rooms/created-by-cli.yaml');
    const addedPath = 'records/rooms/created-by-cli.yaml';
    assert.equal(
      added.observation.revisions[addedPath],
      sha(await readFile(path.join(project, addedPath))),
    );
    assert.equal(changed.snapshot.dirty, true);
    runCli(scratch, project, ['validate']);
    const cliCache = await checkCache(project, ['project.yaml', addedPath]);
    assert.equal(cliCache.semanticKey, originalCache.semanticKey);
    assert.equal(cliCache.semanticFingerprint, originalCache.semanticFingerprint);
    assert.notDeepEqual(cliCache.revisions, originalCache.revisions);

    const cleanEditor = editorSession(project, 'independent-clean-editor');
    sessions.push(cleanEditor);
    const cleanOpened = await cleanEditor.open();
    assert.equal(cleanOpened.snapshot.dirty, false);
    const imported = await cleanEditor.request('validateClean');
    assert.equal(imported.cacheHit, true, "Independent editor missed CLI's clean cache");

    // The editor's revision-checked Save is the only operation that publishes
    // its dirty name. A fresh CLI must see the new disk revision, not old cache.
    const saved = await editor.request('saveOwners', {
      expectedRevision: changed.snapshot.workingRevision,
      owners: ['project'],
      keepMine: false,
      comments: 'keep',
    });
    assert.equal(saved.accepted, true, saved.error);
    assert.match(await readFile(manifestPath, 'utf8'), /Unsaved editor draft/);
    runCli(scratch, project, ['validate'], true);
    const newCache = await checkCache(project, ['project.yaml', addedPath]);
    assert.equal(newCache.semanticFingerprint, cliCache.semanticFingerprint);
    assert.notEqual(newCache.revisions['project.yaml'], cliCache.revisions['project.yaml']);
    const reopened = editorSession(project, 'after-editor-save');
    sessions.push(reopened);
    const reopenedInitial = await reopened.open();
    assert.equal((await reopened.request('validateClean')).cacheHit, true);

    // A separate resident CLI daemon may mutate another physical owner while
    // the native editor publishes its own dirty record. No process shares
    // in-memory authority, and neither publication may erase the other.
    const racingPatch = await reopened.request('patch', {
      expectedRevision: reopenedInitial.snapshot.workingRevision,
      patches: [{ operation: 'replace', path: '/project/name', value: 'Saved during CLI edit' }],
    });
    assert.equal(racingPatch.accepted, true, racingPatch.error);
    const concurrentCli = runCliConcurrent(scratch, project, [
      'entity',
      'create',
      'rooms',
      'during-editor-save',
    ]);
    const concurrentSave = reopened.request('saveOwners', {
      expectedRevision: racingPatch.snapshot.workingRevision,
      owners: ['project'],
      keepMine: false,
      comments: 'keep',
    });
    const [savedDuringCli, cliAttempt] = await Promise.all([concurrentSave, concurrentCli]);
    assert.equal(savedDuringCli.accepted, true, savedDuringCli.error);
    assert.match(await readFile(manifestPath, 'utf8'), /Saved during CLI edit/);
    if (!cliAttempt.success) {
      // A rejected concurrent publication may not have written any part of
      // the new owner. Once the other writer releases the lock, retry.
      await assert.rejects(stat(path.join(project, 'records/rooms/during-editor-save.yaml')));
      runCli(scratch, project, ['entity', 'create', 'rooms', 'during-editor-save'], true);
    }
    assert.equal(
      (await stat(path.join(project, 'records/rooms/during-editor-save.yaml'))).isFile(),
      true,
    );
    runCli(scratch, project, ['validate'], true);
    console.log(
      'Native editor/CLI two-way exact-cache admission, isolated dirty state, CLI watcher, concurrent daemon/editor edits and editor Save passed.',
    );
  } finally {
    await Promise.all(sessions.map((session) => session.close()));
    try {
      runCli(scratch, null, ['daemon', 'stop'], true);
    } catch {
      // Preserve the original certification failure, if any.
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
