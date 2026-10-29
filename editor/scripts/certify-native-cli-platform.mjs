// #517: installed public CLI differential for native-authoritative platform export.
// Use disposable copies, an isolated template registry, and independent daemons.
// The build/release matrix handles real host target packaging; this portable
// fixture certifies Web publication and other target preflight/error contracts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCertificationRoot } from './certification-temp-root.mjs';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNovelTeaVersion } from '../../scripts/noveltea-version.mjs';
import {
  isolatedProductionEnvironment,
  readPortableZipMembers,
} from './native-production-qualification.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.resolve(process.argv[2] ?? 'build/cli/linux/noveltea');
const independentMode = process.argv[3] === '--candidate' || process.argv[3] === '--production';
if (process.argv.length > (independentMode ? 4 : 3))
  throw new Error(
    'Usage: certify-native-cli-platform.mjs [installed-cli] [--candidate|--production]',
  );
const root = await createCertificationRoot('noveltea-517-platform-');
const oracle = path.join(root, 'legacy');
const candidate = path.join(root, 'native');
const projects = independentMode ? [candidate] : [oracle, candidate];
const registry = path.join(root, 'templates');
const source = path.join(root, 'template-source');
const archive = path.join(root, 'template.tar.gz');
const token = 'native-517-web@build-1';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
let applicationId = '';
const selectedProfile = 'canonical-web';
const baseline = {
  ...(independentMode
    ? isolatedProductionEnvironment(process.env, path.join(root, 'home'))
    : { ...process.env, NOVELTEA_CLI_CERTIFICATION: '1' }),
  NOVELTEA_TEMPLATE_REGISTRY_ROOT: registry,
};

function invoke(args, { native = false, project = null, daemon = false, timeout = 240_000 } = {}) {
  const commandArgs = [...args];
  const outputFlag = commandArgs.indexOf('--output');
  if (project && outputFlag >= 0 && commandArgs[outputFlag + 1]?.startsWith('dist/'))
    commandArgs[outputFlag + 1] = path.join(project, commandArgs[outputFlag + 1]);
  const run = spawnSync(
    cli,
    [
      ...(daemon ? [] : ['--no-daemon']),
      '--json',
      ...(project ? ['--project', project] : []),
      ...commandArgs,
    ],
    {
      cwd: root,
      env: independentMode
        ? baseline
        : {
            ...baseline,
            NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE: native ? '1' : '0',
            NOVELTEA_CLI_CERTIFICATION_POISON_LEGACY_WORKSPACE: native ? '1' : '0',
            NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `nt517-${process.pid}-${native ? 'native' : 'legacy'}`,
            NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: path.join(
              root,
              native ? 'native-daemon' : 'legacy-daemon',
            ),
          },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout,
    },
  );
  assert.ifError(run.error);
  assert.ok(run.stdout.trim(), `No CLI JSON for ${args.join(' ')}: ${run.stderr}`);
  const response = JSON.parse(run.stdout);
  assert.equal(run.status, response.exitCode, `${run.stdout}\n${run.stderr}`);
  return response;
}

function errorProjection(response) {
  const normalizeRoot = (message) =>
    [oracle, candidate].reduce(
      (current, project) =>
        current
          .replaceAll(project, '<project>')
          .replaceAll(project.replaceAll('\\', '/'), '<project>'),
      message,
    );
  return {
    success: response.success,
    exitCode: response.exitCode,
    errors: response.diagnostics
      .filter((item) => item.severity === 'error')
      .map(({ code, path, message }) => ({
        code,
        path,
        message: normalizeRoot(message),
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

function compare(args, { daemon = false, expectedSuccess, label = args.join(' ') } = {}) {
  const legacy = independentMode ? null : invoke(args, { project: oracle, daemon });
  const native = invoke(args, { project: candidate, daemon, native: true });
  if (legacy) {
    assert.deepEqual(
      errorProjection(native),
      errorProjection(legacy),
      `Installed CLI parity failed for ${label}`,
    );
  } else {
    assert.equal(
      native.diagnostics.some((item) => item.code === 'CLI_NATIVE_CANDIDATE_UNCLAIMED'),
      false,
    );
    if (!native.success)
      assert.ok(
        native.diagnostics.some((item) => item.severity === 'error' && item.code && item.path),
        `Missing structured native preflight failure: ${label}`,
      );
  }
  if (expectedSuccess !== undefined)
    assert.equal(
      native.success,
      expectedSuccess,
      `${label}: ${JSON.stringify(native.diagnostics)}`,
    );
  console.log(`  ${daemon ? 'daemon' : 'cold'}: ${label}`);
  return { legacy, native };
}

async function makeTemplate() {
  const noticePath = 'licenses/noveltea-certification-fixture--license.txt';
  const noticeText = Buffer.from('MIT License\nCopyright (c) NovelTea certification fixture\n');
  const indexText = Buffer.from(
    JSON.stringify({
      format: 'noveltea.engine-licenses',
      components: [
        {
          component: 'noveltea-certification-fixture',
          displayName: 'NovelTea certification fixture',
          version: '1.0',
          files: [{ path: noticePath, size: noticeText.length, sha256: hash(noticeText) }],
        },
      ],
    }) + '\n',
  );
  const sbom = Buffer.from(
    JSON.stringify({
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      version: 1,
      components: [{ type: 'library', name: 'noveltea-certification-fixture', version: '1.0' }],
    }) + '\n',
  );
  const entries = [
    [noticePath, noticeText, 'notice'],
    ['licenses/index.json', indexText, 'notice'],
    ['SBOM.cdx.json', sbom, 'support'],
    ['player.js', Buffer.from('globalThis.Module = globalThis.Module || {};\n'), 'player'],
    ['player.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), 'player'],
    ['player.data', Buffer.from('certification-data\n'), 'system-asset'],
  ];
  const inventory = [];
  for (const [relative, data, role] of entries) {
    const filename = path.join(source, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, data);
    inventory.push({
      path: relative,
      size: data.length,
      mode: (await stat(filename)).mode & 0o777,
      sha256: hash(data),
      role,
    });
  }
  const { version } = readNovelTeaVersion(repositoryRoot);
  await writeFile(
    path.join(source, 'template.json'),
    JSON.stringify({
      format: 'noveltea.player-template',
      formatVersion: 1,
      templateId: 'native-517-web',
      buildId: 'build-1',
      engineVersion: version,
      platform: 'web',
      architecture: 'wasm32',
      minimumPlatformVersion: 'certification',
      graphicsBackends: ['webgl2'],
      shaderVariants: ['essl-300'],
      compiledProjectFormatVersion: 1,
      playerRuntimeApiVersion: 1,
      compiledFeatures: ['lua', 'web-threads'],
      capabilities: ['external-url'],
      buildFlavor: 'debug',
      playerVariant: 'standard',
      packageAccessModes: ['web-fetch'],
      files: inventory,
      runtimeDependencies: [
        { path: noticePath, kind: 'notice' },
        { path: 'licenses/index.json', kind: 'notice' },
      ],
      artifacts: {
        archive: path.basename(archive),
        symbols: 'symbols.tar.gz',
        sbom: 'SBOM.cdx.json',
        notices: 'licenses/index.json',
      },
      provenance: { provider: 'local', source: 'certification' },
      host: { assembly: 'any', requiresToolchain: false, tools: [] },
    }),
  );
  const tar = spawnSync('cmake', ['-E', 'tar', 'czf', archive, '.'], {
    cwd: source,
    encoding: 'utf8',
  });
  assert.ifError(tar.error);
  assert.equal(tar.status, 0, tar.stderr);
  const installed = invoke(['platform', 'template', 'install', archive, '--force'], {
    native: true,
  });
  assert.equal(installed.success, true, JSON.stringify(installed.diagnostics));
}

function exportArgs(extra = []) {
  return [
    'platform',
    'export',
    '--output',
    'dist/platform-web',
    '--profile',
    selectedProfile,
    '--template',
    token,
    ...extra,
  ];
}

async function comparePublished() {
  if (independentMode) {
    for (const file of ['index.html', 'manifest.webmanifest', 'player.json'])
      assert.ok((await stat(path.join(candidate, 'dist/platform-web', file))).isFile(), file);
    // The C++ publisher must not overwrite editor-owned drafts/recovery state.
    // It records the successful identity in an editor-local sidecar, merged
    // into state when the editor next opens the Project.
    const identity = JSON.parse(
      await readFile(
        path.join(candidate, '.noveltea/editor/platform-export-identity.json'),
        'utf8',
      ),
    );
    assert.equal(identity.format, 'noveltea.platform-export-identity');
    assert.equal(identity.applicationId, applicationId);
    const player = JSON.parse(
      await readFile(path.join(candidate, 'dist/platform-web/player.json')),
    );
    const published = await readFile(
      path.join(candidate, 'dist/platform-web', player.package.path),
    );
    assert.equal(hash(published), player.package.sha256, 'Native publication checksum mismatch.');
    const game = readPortableZipMembers(published).get('game');
    assert.ok(game, 'Native platform export omitted compiled gameplay.');
    assert.ok(
      JSON.parse(game.toString('utf8')).project?.name,
      'Published gameplay has no Project identity.',
    );
    return;
  }
  for (const name of ['index.html', 'manifest.webmanifest', 'player.json']) {
    const left = await readFile(path.join(oracle, 'dist/platform-web', name));
    const right = await readFile(path.join(candidate, 'dist/platform-web', name));
    assert.deepEqual(right, left, `Native platform publication changed ${name} bytes.`);
  }
  for (const project of [oracle, candidate]) {
    const state = JSON.parse(
      await readFile(path.join(project, '.noveltea/editor/state.json'), 'utf8'),
    );
    assert.ok(
      state.lastSuccessfulPlatformExportIdentity,
      'Successful export omitted local identity.',
    );
    assert.equal(state.lastSuccessfulPlatformExportIdentity.applicationId, applicationId);
  }
  const oraclePlayer = JSON.parse(
    await readFile(path.join(oracle, 'dist/platform-web/player.json')),
  );
  const candidatePlayer = JSON.parse(
    await readFile(path.join(candidate, 'dist/platform-web/player.json')),
  );
  const left = await readFile(path.join(oracle, 'dist/platform-web', oraclePlayer.package.path));
  const right = await readFile(
    path.join(candidate, 'dist/platform-web', candidatePlayer.package.path),
  );
  assert.equal(hash(left), oraclePlayer.package.sha256);
  assert.equal(hash(right), candidatePlayer.package.sha256);
  assert.deepEqual(right, left, 'Native platform export changed the published .ntpkg bytes.');
}

try {
  if (independentMode)
    await mkdir(path.join(root, 'home/runtime'), { recursive: true, mode: 0o700 });
  const generatedRoot = path.join(root, 'generated-project');
  const generator = path.join(
    repositoryRoot,
    'editor/scripts/materialize-native-platform-export-fixture.mjs',
  );
  const generated = spawnSync(
    process.execPath,
    [generator, '--root', generatedRoot, '--target', 'web'],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.ifError(generated.error);
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  const projectFixture = path.dirname(JSON.parse(generated.stdout).projectPath);
  let manifest = await readFile(path.join(projectFixture, 'project.yaml'), 'utf8');
  const match = manifest.match(/applicationId: ([^\n]+)/);
  assert.ok(match, 'Fixture must contain a platform application ID.');
  applicationId = match[1].trim();
  await Promise.all(projects.map((project) => cp(projectFixture, project, { recursive: true })));
  // The canonical fixture has one selected Web profile. Duplicate it
  // without reparsing/reformatting restricted YAML to exercise ambiguity.
  const start = manifest.indexOf('    - format: noveltea.platform-export-profile');
  const end = manifest.indexOf('  assetMemoryPolicies:', start);
  assert.ok(start >= 0 && end > start, 'Fixture lacks the expected Web profile source.');
  const duplicate = manifest
    .slice(start, end)
    .replace('id: canonical-web', 'id: canonical-web-secondary')
    .replace('label: Canonical Web', 'label: Secondary Web');
  manifest = manifest.slice(0, end) + duplicate + manifest.slice(end);
  await Promise.all(
    projects.map((project) => writeFile(path.join(project, 'project.yaml'), manifest)),
  );
  await Promise.all(
    projects.map((project) =>
      rm(path.join(project, '.noveltea'), { recursive: true, force: true }),
    ),
  );
  // This installed-transport differential exercises publication without
  // comparing the legacy shader compiler (which has a separate response-
  // shape defect). The existing material/shader export suites cover it.
  for (const project of projects) {
    const roomPath = path.join(project, 'records/rooms/foyer.yaml');
    const room = await readFile(roomPath, 'utf8');
    const withoutMaterial = room.replace(
      /    materialApplication:\n      material: fixture-material\n      parameters: \{\}\n      textures: \{\}\n/u,
      '',
    );
    assert.notEqual(withoutMaterial, room, 'Canonical fixture Material application moved.');
    await writeFile(roomPath, withoutMaterial);
    await rm(path.join(project, 'records/materials/fixture-material.yaml'));
    await rm(path.join(project, 'shaders/fixture.fs.sc'));
  }
  await makeTemplate();
  // Project-independent commands must not acquire native Project admission.
  assert.equal(invoke(['platform', 'template', 'list'], { native: true }).success, true);
  const configPath = path.join(root, 'headless-config.json');
  assert.equal(invoke(['platform', 'config', 'init', configPath], { native: true }).success, true);

  compare(['platform', 'export', '--output', 'dist/platform-web', '--check'], {
    expectedSuccess: false,
    label: 'ambiguous profile',
  });
  const missingProfile = exportArgs(['--check']);
  missingProfile[missingProfile.indexOf('--profile') + 1] = 'missing';
  compare(missingProfile, {
    expectedSuccess: false,
    label: 'missing profile',
  });
  compare(exportArgs(['--check', '--signing-profile', 'missing']), {
    expectedSuccess: false,
    label: 'missing signing profile',
  });
  compare(exportArgs(['--check', '--config', path.join(root, 'absent.json')]), {
    expectedSuccess: false,
    label: 'invalid private config',
  });
  compare(exportArgs(['--check', '--config', configPath, '--sign']), {
    expectedSuccess: false,
    label: 'explicit config without signing credentials',
  });
  compare(exportArgs(['--check']), {
    expectedSuccess: false,
    label: 'untrusted template requires acknowledgement',
  });
  compare(exportArgs(['--check', '--allow-untrusted-template', '--allow-localization-warnings']), {
    expectedSuccess: true,
    label: 'full selected-profile preflight',
  });
  compare(
    exportArgs([
      '--check',
      '--config',
      configPath,
      '--allow-untrusted-template',
      '--allow-localization-warnings',
    ]),
    { expectedSuccess: true, label: 'private config preflight' },
  );
  for (const project of projects)
    await assert.rejects(lstat(path.join(project, 'dist/platform-web')), { code: 'ENOENT' });

  compare(exportArgs(['--check', '--allow-untrusted-template', '--allow-localization-warnings']), {
    daemon: true,
    expectedSuccess: true,
    label: 'resident daemon preflight',
  });
  compare(exportArgs(['--allow-untrusted-template', '--allow-localization-warnings']), {
    expectedSuccess: true,
    label: 'real platform publication',
  });
  await comparePublished();

  compare(exportArgs(['--check', '--allow-untrusted-template', '--allow-localization-warnings']), {
    expectedSuccess: false,
    label: 'collision without --force',
  });
  compare(
    exportArgs([
      '--check',
      '--force',
      '--allow-untrusted-template',
      '--allow-localization-warnings',
    ]),
    {
      expectedSuccess: true,
      label: 'acknowledged replacement preflight',
    },
  );
  for (const project of projects) {
    await symlink(path.join(project, 'dist/platform-web'), path.join(project, 'dist/link-output'));
  }
  compare(
    [
      'platform',
      'export',
      '--output',
      'dist/link-output',
      '--profile',
      selectedProfile,
      '--template',
      token,
      '--check',
      '--force',
      '--allow-untrusted-template',
      '--allow-localization-warnings',
    ],
    { expectedSuccess: false, label: 'symlink output refused even with --force' },
  );

  for (const project of projects) {
    if (independentMode) {
      const filename = path.join(project, '.noveltea/editor/platform-export-identity.json');
      const identity = JSON.parse(await readFile(filename, 'utf8'));
      identity.applicationId = 'com.example.old';
      identity.saveNamespace = 'old-save';
      identity.completedAt = '9999-12-31T23:59:59.999Z';
      await writeFile(filename, JSON.stringify(identity));
    } else {
      const filename = path.join(project, '.noveltea/editor/state.json');
      const state = JSON.parse(await readFile(filename, 'utf8'));
      state.lastSuccessfulPlatformExportIdentity = {
        applicationId: 'com.example.old',
        saveNamespace: 'old-save',
      };
      await writeFile(filename, JSON.stringify(state));
    }
  }
  compare(exportArgs(['--check', '--force', '--allow-untrusted-template']), {
    expectedSuccess: false,
    label: 'changed identity requires acknowledgement',
  });
  compare(
    exportArgs([
      '--check',
      '--force',
      '--allow-identity-change',
      '--allow-untrusted-template',
      '--allow-localization-warnings',
    ]),
    { expectedSuccess: true, label: 'acknowledged identity change' },
  );

  console.log(
    `Native platform installed-CLI preflight and publication ${independentMode ? 'independent contracts' : 'differential'} PASSED.`,
  );
  console.log('Signing credentials were not supplied: real certificate signing was NOT certified.');
} finally {
  for (const native of independentMode ? [true] : [false, true]) {
    try {
      invoke(['daemon', 'stop'], { native });
    } catch {
      // Preserve the original differential failure.
    }
  }
  if (process.env.NOVELTEA_517_KEEP_FAILED === '1')
    console.error(`Retaining native platform differential fixture: ${root}`);
  else await rm(root, { recursive: true, force: true });
}
