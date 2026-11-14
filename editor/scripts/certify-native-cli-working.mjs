// Standalone native CLI working-source certification. The addon only generates
// current XXH3 fixture revisions; the relocated CLI does not load it or Node.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = path.resolve(
  process.argv[2] ??
    path.join(repo, 'build/linux-authoring-release/tools/editor_tool/native-cli/noveltea'),
);
const addon = require(path.join(repo, 'build/native-authoring-host/noveltea-authoring-node.node'));
const temp = mkdtempSync(path.join(os.tmpdir(), 'noveltea-working-cert-'));
const root = path.join(temp, 'project');
const binary = path.join(temp, path.basename(executable));
const source = 'records/rooms/active-text.yaml';
const sha = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const get = (relative) => readFileSync(path.join(root, relative));
const put = (relative, bytes) => {
  const filename = path.join(root, relative);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, bytes);
};
const command = (...args) => {
  const result = spawnSync(binary, ['--project', root, '--json', ...args], { encoding: 'utf8' });
  assert.equal(result.error, undefined, String(result.error));
  const data = JSON.parse(result.stdout);
  assert.equal(result.status, data.exitCode, result.stderr);
  return data;
};
const working = () => command('validate', '--working');
const ordinary = () => command('--no-daemon', 'validate');
const projected = '.noveltea/editor/working/';
const expectedSourceUrl = 'project:/' + projected + 'files/' + source;
const originalProjectHash = sha(
  readFileSync(path.join(repo, 'tests/projects/feature-lab', source)),
);

try {
  cpSync(path.join(repo, 'tests/projects/feature-lab'), root, { recursive: true });
  cpSync(executable, binary);
  cpSync(path.join(path.dirname(executable), 'assets'), path.join(temp, 'assets'), {
    recursive: true,
  });
  assert.equal(ordinary().success, true, 'feature lab disk baseline');
  assert.equal(working().success, true, 'no manifested working sources');
  const missing = spawnSync(
    binary,
    ['--json', '--project', path.join(temp, 'not-a-project'), 'validate', '--working'],
    { encoding: 'utf8' },
  );
  assert.equal(
    JSON.parse(missing.stdout).success,
    false,
    'missing Project never validates as clean',
  );

  const saved = get(source);
  const dirty = Buffer.concat([
    saved,
    Buffer.from('\n# Unsaved, but source-valid working change.\n'),
  ]);
  const checkpoint = {
    version: 1,
    projectId: 'feature-lab',
    projectRoot: realpathSync(root),
    checkpoint: {
      batches: [],
      textSources: {},
      conflicts: {},
      pendingFields: {},
      ownerEvidence: {
        'rooms/active-text': {
          diskRevision: addon.sourceRevision(saved),
          baseline: {},
          working: {},
        },
      },
    },
  };
  put('.noveltea/editor/native-dirty-state.json', JSON.stringify(checkpoint));
  assert.equal(
    working().diagnostics[0]?.code,
    'WORKING_SOURCE_UNTRUSTED',
    'a dirty checkpoint cannot validate as a clean Project before publication',
  );
  const publishedRevision = sha(dirty);
  put(projected + 'files/' + source, dirty);
  put(projected + 'baselines/' + publishedRevision.slice(7) + '.blob', dirty);
  const manifest = {
    schema: 'noveltea.editor.working-sources',
    projectId: 'feature-lab',
    projectRoot: realpathSync(root),
    publication: 1,
    entries: {
      [source]: {
        representation: 'file',
        publishedRevision,
        pendingRevision: null,
        diskRevision: addon.sourceRevision(saved),
        checkpointRevision: sha('fixture'),
        localStateRevision: null,
      },
    },
  };
  const saveManifest = () => put(projected + 'manifest.json', JSON.stringify(manifest));
  saveManifest();
  const validWorking = working();
  assert.equal(validWorking.success, true, 'source-valid unsaved working overlay');
  assert.equal(validWorking.working, true);
  assert.deepEqual(working(), validWorking, 'repeat working validation is deterministic');
  assert.equal(sha(get(source)), sha(saved), 'read-only validation cannot write tracked source');

  checkpoint.checkpoint.ownerEvidence['rooms/diagnostics-pre'] = {
    diskRevision: addon.sourceRevision(get('records/rooms/diagnostics-pre.yaml')),
    baseline: {},
    working: {},
  };
  put('.noveltea/editor/native-dirty-state.json', JSON.stringify(checkpoint));
  assert.equal(
    working().diagnostics[0]?.code,
    'WORKING_SOURCE_UNTRUSTED',
    'an unprojected dirty owner cannot be silently ignored',
  );
  delete checkpoint.checkpoint.ownerEvidence['rooms/diagnostics-pre'];
  checkpoint.checkpoint.pendingFields['/rooms/active-text/data/count'] = '-';
  put('.noveltea/editor/native-dirty-state.json', JSON.stringify(checkpoint));
  assert.equal(
    working().diagnostics[0]?.code,
    'WORKING_SOURCE_PENDING',
    'unprojected pending input cannot be ignored',
  );
  delete checkpoint.checkpoint.pendingFields['/rooms/active-text/data/count'];
  put('.noveltea/editor/native-dirty-state.json', JSON.stringify(checkpoint));

  put(projected + 'files/' + source, 'data: [\n');
  const invalid = working();
  assert.equal(invalid.success, false, 'invalid working YAML must fail clean disk');
  assert.ok(
    invalid.diagnostics.some((diagnostic) => diagnostic.sourceUrl === expectedSourceUrl),
    JSON.stringify(invalid.diagnostics),
  );
  assert.equal(ordinary().success, true, 'disk-only default ignores malformed working YAML');
  assert.equal(sha(get(source)), sha(saved), 'invalid working check must not Save');

  put(projected + 'files/' + source, dirty);
  assert.equal(working().success, true, 'repairing working file clears validation');
  put(source, Buffer.concat([saved, Buffer.from('\n# physical disk changed\n')]));
  assert.equal(
    working().diagnostics[0]?.code,
    'WORKING_SOURCE_STALE',
    'disk mutation after publication cannot produce a successful validation',
  );
  put(source, saved);

  const baselinePath = projected + 'baselines/' + publishedRevision.slice(7) + '.blob';
  put(baselinePath, 'damaged baseline');
  assert.equal(
    working().diagnostics[0]?.code,
    'WORKING_SOURCE_UNTRUSTED',
    'invalid immutable publication evidence',
  );
  put(baselinePath, dirty);

  manifest.projectId = 'different-project';
  saveManifest();
  assert.equal(
    working().diagnostics[0]?.code,
    'WORKING_SOURCE_UNTRUSTED',
    'cross-Project manifest',
  );
  manifest.projectId = 'feature-lab';
  saveManifest();

  put(
    projected + 'pending/' + source + '.json',
    JSON.stringify({ fieldText: { '/rooms/active-text/data/count': '-' }, namedText: {} }),
  );
  manifest.entries[source].pendingRevision = sha(get(projected + 'pending/' + source + '.json'));
  saveManifest();
  assert.equal(
    working().diagnostics[0]?.code,
    'WORKING_SOURCE_PENDING',
    'unrepresentable raw pending values cannot certify a clean Project',
  );
  manifest.entries[source].pendingRevision = null;
  saveManifest();
  assert.equal(
    working().diagnostics[0]?.code,
    'WORKING_SOURCE_UNTRUSTED',
    'orphaned working input not represented by manifest must not be ignored',
  );
  rmSync(path.join(root, projected + 'pending/' + source + '.json'));
  assert.equal(working().success, true, 'cleaned orphan pending source is no longer obstructed');

  rmSync(path.join(root, projected + 'files/' + source));
  symlinkSync(path.join(root, source), path.join(root, projected + 'files/' + source));
  assert.equal(
    working().diagnostics[0]?.code,
    'WORKING_SOURCE_UNSAFE',
    'working symlink cannot escape source authority',
  );

  assert.equal(sha(get(source)), originalProjectHash, 'physical source remains unchanged');
  console.log(
    'Native CLI --working validated with relocated binary, clean/dirty YAML, repair, stale disk, identity, pending and symlink failures.',
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
