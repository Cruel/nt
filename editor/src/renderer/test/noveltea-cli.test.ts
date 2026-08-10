import { describe, expect, it } from 'vite-plus/test';
import { runNovelTeaCli } from '../../cli/application';
import { NOVELTEA_CLI_WORKSPACE_DIAGNOSTIC_CODES } from '../../cli/contracts';
import {
  PHASE_SIX_NODE_REFERENCE_COMMANDS,
  novelTeaNodeReferenceRunner,
} from '../../cli/node-reference-runner';
import type { NovelTeaCliNativeToolService } from '../../cli/native-tool-service';
import { createDefaultAuthoringRecord } from '../project/entity-operations';
import {
  createAuthoringProject,
  type AuthoringProject,
} from '../../shared/project-schema/authoring-project';
import {
  InMemoryProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  projectWorkspaceFiles,
} from '../../shared/project-workspace';

const root = '/projects/headless';

function validProject() {
  const project = createAuthoringProject({ id: 'headless', name: 'Headless' });
  project.rooms.start = createDefaultAuthoringRecord(
    'rooms',
    'start',
  ) as typeof project.rooms.start;
  project.entrypoint = { kind: 'room', id: 'start' };
  return project;
}

function fixture(project: AuthoringProject = validProject()) {
  const files = Object.fromEntries(
    Object.entries(projectWorkspaceFiles(project, project.editor)).map(([file, text]) => [
      `${root}/${file}`,
      text,
    ]),
  );
  const fileSystem = new InMemoryProjectWorkspaceFileSystem(files);
  const workspace = new ProjectWorkspaceService(fileSystem);
  return { project, fileSystem, workspace };
}

function options(
  value: ReturnType<typeof fixture>,
  cwd = root,
  nativeTools?: NovelTeaCliNativeToolService,
) {
  return {
    cwd,
    fileSystem: value.fileSystem,
    workspace: value.workspace,
    ...(nativeTools ? { nativeTools } : {}),
  };
}

function projectWithSourceReference() {
  const project = createAuthoringProject({ id: 'headless', name: 'Headless' });
  project.rooms.foyer = createDefaultAuthoringRecord(
    'rooms',
    'foyer',
  ) as typeof project.rooms.foyer;
  project.entrypoint = { kind: 'room', id: 'foyer' };
  project.scripts.logic = createDefaultAuthoringRecord(
    'scripts',
    'logic',
  ) as typeof project.scripts.logic;
  project.scripts.logic!.data.source = {
    kind: 'inline-lua',
    source: 'local destination = "foyer"\n',
  };
  return project;
}

describe('NovelTea Phase 6 headless CLI', () => {
  it('keeps help/version project-independent and documents direct file editing', async () => {
    const help = await runNovelTeaCli(['--help'], { cwd: '/missing' });
    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe('');
    expect(help.stdout).toContain('Edit record JSON, Lua, RML, and RCSS source files directly');
    expect(help.stdout).toContain('noveltea validate');

    const version = await runNovelTeaCli(['--json', '--version'], { cwd: '/missing' });
    expect(version.exitCode).toBe(0);
    expect(version.stderr).toBe('');
    expect(version.stdout.endsWith('\n')).toBe(true);
    expect(version.stdout.split('\n')).toHaveLength(2);
    expect(JSON.parse(version.stdout)).toMatchObject({
      success: true,
      exitCode: 0,
      version: '1.0.0',
    });
  });

  it('publishes the fixed workspace/path diagnostic vocabulary', () => {
    expect(NOVELTEA_CLI_WORKSPACE_DIAGNOSTIC_CODES).toEqual([
      'CLI_USAGE',
      'WORKSPACE_NOT_FOUND',
      'WORKSPACE_MANIFEST_READ',
      'WORKSPACE_MANIFEST_INVALID',
      'WORKSPACE_VERSION_UNSUPPORTED',
      'WORKSPACE_PATH_INVALID',
      'WORKSPACE_RECORD_ID_PATH_MISMATCH',
      'WORKSPACE_DUPLICATE_RECORD_ID',
      'WORKSPACE_SOURCE_OWNERSHIP_CONFLICT',
      'WORKSPACE_SOURCE_READ',
      'WORKSPACE_REVISION_CONFLICT',
      'WORKSPACE_BUSY',
      'WORKSPACE_TRANSACTION_RECOVERY_CONFLICT',
      'WORKSPACE_EXTERNAL_STRUCTURAL_INVALID',
      'AGENT_KIT_WORKSPACE_UNSUPPORTED',
    ]);
  });

  it('validates command syntax before project discovery and enforces global option ordering', async () => {
    const unknown = await runNovelTeaCli(['unknown'], { cwd: '/missing' });
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain('Unknown command path');

    const misplaced = await runNovelTeaCli(['validate', '--json'], { cwd: '/missing' });
    expect(misplaced.exitCode).toBe(2);
    expect(misplaced.stderr).toContain('validate does not accept arguments');

    const unknownCollection = await runNovelTeaCli(['usages', 'not-a-collection', 'anything'], {
      cwd: '/missing',
    });
    expect(unknownCollection.exitCode).toBe(2);
    expect(unknownCollection.stderr).toContain("Unknown collection 'not-a-collection'");

    const unsupportedAssetCreate = await runNovelTeaCli(
      ['entity', 'create', 'assets', 'new-asset'],
      {
        cwd: '/missing',
      },
    );
    expect(unsupportedAssetCreate.exitCode).toBe(2);
    expect(unsupportedAssetCreate.stderr).toContain('Generic Asset creation is not supported');
  });

  it('reads stdin only for the exact test run-spec command path', async () => {
    const value = fixture();
    let reads = 0;
    const unrelated = await runNovelTeaCli(
      ['--json', 'entity', 'create', 'rooms', 'run-spec', '--dry-run'],
      {
        ...options(value),
        readStdinText() {
          reads += 1;
          return '{}';
        },
      },
    );
    expect(unrelated.exitCode).toBe(0);
    expect(reads).toBe(0);

    const nativeTools: NovelTeaCliNativeToolService = {
      async compileShaders() {
        return { ok: true, success: true, diagnostics: [], outputs: [] };
      },
      async runHeadlessTest() {
        return { ok: true, success: true };
      },
      async runUiTest() {
        return { ok: true, success: true };
      },
      async exportPackage() {
        return { ok: true, success: true };
      },
      shaderc() {
        return 0;
      },
    };
    const runSpec = await runNovelTeaCli(['--json', 'test', 'run-spec'], {
      ...options(value, root, nativeTools),
      readStdinText() {
        reads += 1;
        return JSON.stringify({
          schema: 'noveltea.editor.playback',
          version: 2,
          id: 'stdin-test',
          steps: [],
        });
      },
    });
    expect(runSpec.exitCode).toBe(0);
    expect(reads).toBe(1);
  });

  it('discovers project.json upward, accepts explicit roots, and ignores retired filenames', async () => {
    const value = fixture();
    const upward = await runNovelTeaCli(
      ['--json', 'validate'],
      options(value, `${root}/records/rooms`),
    );
    expect(upward.exitCode).toBe(0);
    expect(JSON.parse(upward.stdout).projectRoot).toBe(root);

    const explicit = await runNovelTeaCli(
      ['--project', root, '--json', 'validate'],
      options(value, '/elsewhere'),
    );
    expect(explicit.exitCode).toBe(0);

    const retired = new InMemoryProjectWorkspaceFileSystem({
      '/legacy/game.json': '{}\n',
      '/legacy/game': '{}\n',
    });
    const notFound = await runNovelTeaCli(['--json', 'validate'], {
      cwd: '/legacy',
      fileSystem: retired,
      workspace: new ProjectWorkspaceService(retired),
    });
    expect(notFound.exitCode).toBe(3);
    expect(JSON.parse(notFound.stdout).diagnostics[0].code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('stops at a malformed or unsupported nested project.json instead of walking upward', async () => {
    const outer = fixture();
    await outer.fileSystem.writeTextAtomic('/projects/headless/nested/project.json', '{ bad');
    const malformed = await runNovelTeaCli(
      ['--json', 'validate'],
      options(outer, `${root}/nested/child`),
    );
    expect(malformed.exitCode).toBe(3);
    expect(JSON.parse(malformed.stdout).diagnostics[0].code).toBe('WORKSPACE_MANIFEST_INVALID');

    await outer.fileSystem.writeTextAtomic(
      '/projects/headless/nested/project.json',
      JSON.stringify({ schema: 'noveltea.project.workspace', schemaVersion: 99 }),
    );
    const unsupported = await runNovelTeaCli(
      ['--json', 'validate'],
      options(outer, `${root}/nested/child`),
    );
    expect(unsupported.exitCode).toBe(3);
    expect(JSON.parse(unsupported.stdout).diagnostics[0].code).toBe(
      'WORKSPACE_VERSION_UNSUPPORTED',
    );
  });

  it('emits exactly one compact JSON object plus LF and empty stderr for expected failures', async () => {
    const value = fixture();
    const result = await runNovelTeaCli(
      ['--json', 'entity', 'create', 'assets', 'new-asset'],
      options(value),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('');
    expect(result.stdout.endsWith('\n')).toBe(true);
    expect(result.stdout.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      exitCode: 2,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'CLI_USAGE' })]),
    });
  });

  it('uses the shared authoring pipeline and exact shader variants through the native service abstraction', async () => {
    const project = validProject();
    project.shaders.basic = createDefaultAuthoringRecord(
      'shaders',
      'basic',
    ) as typeof project.shaders.basic;
    const value = fixture(project);
    let receivedOptions: unknown;
    const nativeTools: NovelTeaCliNativeToolService = {
      async compileShaders(_shaderProject, compileOptions) {
        receivedOptions = compileOptions;
        return { ok: true, success: true, diagnostics: [], outputs: [] };
      },
      async runHeadlessTest() {
        return {};
      },
      async runUiTest() {
        return {};
      },
      async exportPackage() {
        return {};
      },
      shaderc() {
        return 0;
      },
    };
    const result = await runNovelTeaCli(['--json', 'validate'], options(value, root, nativeTools));
    expect(result.exitCode).toBe(0);
    expect(receivedOptions).toMatchObject({
      projectRoot: root,
      outputRoot: `${root}/.noveltea/build`,
      cacheRoot: `${root}/.noveltea/cache`,
      shaderVariants: ['glsl-120', 'essl-100', 'essl-300'],
    });

    const failed = await runNovelTeaCli(
      ['--json', 'validate'],
      options(value, root, {
        async compileShaders() {
          return {
            ok: true,
            success: false,
            diagnostics: [
              {
                severity: 'error',
                code: 'TOOL_NOT_FOUND',
                message: 'Native shader tool is unavailable.',
              },
            ],
            outputs: [],
          };
        },
        async runHeadlessTest() {
          return {};
        },
        async runUiTest() {
          return {};
        },
        async exportPackage() {
          return {};
        },
        shaderc() {
          return 0;
        },
      }),
    );
    expect(failed.exitCode).toBe(6);
    expect(JSON.parse(failed.stdout).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'native.shader.TOOL_NOT_FOUND' })]),
    );
  });

  it('dry-runs create without tracked or local writes and projects Layout/Script companion files', async () => {
    const value = fixture();
    const layout = await runNovelTeaCli(
      ['--json', 'entity', 'create', 'layouts', 'overlay', '--dry-run'],
      options(value),
    );
    expect(layout.exitCode).toBe(0);
    const layoutEnvelope = JSON.parse(layout.stdout);
    expect(layoutEnvelope.plan.writes).toEqual(
      expect.arrayContaining([
        'records/layouts/overlay/layout.json',
        'records/layouts/overlay/layout.rml',
        'records/layouts/overlay/layout.rcss',
        'records/layouts/overlay/layout.lua',
      ]),
    );
    expect(await value.fileSystem.inspect(`${root}/records/layouts/overlay/layout.json`)).toBe(
      'missing',
    );
    expect(await value.fileSystem.inspect(`${root}/.noveltea/editor/state.json`)).toBe('missing');

    const script = await runNovelTeaCli(
      ['--json', 'entity', 'create', 'scripts', 'bootstrap', '--dry-run'],
      options(value),
    );
    expect(script.exitCode).toBe(0);
    expect(JSON.parse(script.stdout).plan.writes).toEqual(
      expect.arrayContaining(['records/scripts/bootstrap.json', 'scripts/bootstrap.lua']),
    );
    expect(await value.fileSystem.inspect(`${root}/scripts/bootstrap.lua`)).toBe('missing');
  });

  it('executes create through the shared workspace transaction writer', async () => {
    const value = fixture();
    const result = await runNovelTeaCli(
      ['--json', 'entity', 'create', 'rooms', 'hallway'],
      options(value),
    );
    expect(result.exitCode).toBe(0);
    expect(await value.fileSystem.inspect(`${root}/records/rooms/hallway.json`)).toBe('file');
    const opened = await value.workspace.open(root);
    expect(opened.ok && opened.snapshot.project.rooms.hallway?.id).toBe('hallway');
  });

  it('executes rename/delete through the same segmented workspace transaction writer', async () => {
    const project = validProject();
    project.rooms.spare = createDefaultAuthoringRecord(
      'rooms',
      'spare',
    ) as typeof project.rooms.spare;
    const value = fixture(project);

    const renamed = await runNovelTeaCli(
      ['--json', 'entity', 'rename', 'rooms', 'start', 'opening'],
      options(value),
    );
    expect(renamed.exitCode).toBe(0);
    expect(await value.fileSystem.inspect(`${root}/records/rooms/start.json`)).toBe('missing');
    expect(await value.fileSystem.inspect(`${root}/records/rooms/opening.json`)).toBe('file');
    const afterRename = await value.workspace.open(root);
    expect(afterRename.ok && afterRename.snapshot.project.entrypoint).toEqual({
      kind: 'room',
      id: 'opening',
    });

    const deleted = await runNovelTeaCli(
      ['--json', 'entity', 'delete', 'rooms', 'spare'],
      options(value),
    );
    expect(deleted.exitCode).toBe(0);
    expect(await value.fileSystem.inspect(`${root}/records/rooms/spare.json`)).toBe('missing');
  });

  it('reports external-source usages with project URL and location and gates possible rename/delete evidence', async () => {
    const value = fixture(projectWithSourceReference());
    const usages = await runNovelTeaCli(['--json', 'usages', 'rooms', 'foyer'], options(value));
    expect(usages.exitCode).toBe(0);
    const sourceUsage = JSON.parse(usages.stdout).usages.find(
      (usage: { classification?: string }) => usage.classification === 'possible-lexical',
    );
    expect(sourceUsage).toMatchObject({
      sourceUrl: 'project:/scripts/logic.lua',
      classification: 'possible-lexical',
      location: { line: 1 },
    });

    const blockedRename = await runNovelTeaCli(
      ['--json', 'entity', 'rename', 'rooms', 'foyer', 'lobby', '--dry-run'],
      options(value),
    );
    expect(blockedRename.exitCode).toBe(4);
    expect(
      JSON.parse(blockedRename.stdout).diagnostics.some(
        (diagnostic: { code: string }) => diagnostic.code === 'authoring.source_reference.possible',
      ),
    ).toBe(true);

    const allowedRename = await runNovelTeaCli(
      [
        '--json',
        'entity',
        'rename',
        'rooms',
        'foyer',
        'lobby',
        '--dry-run',
        '--allow-possible-source-references',
      ],
      options(value),
    );
    expect(allowedRename.exitCode).toBe(0);
    expect(await value.fileSystem.readText(`${root}/scripts/logic.lua`)).toContain('"foyer"');

    const blockedDelete = await runNovelTeaCli(
      ['--json', 'entity', 'delete', 'rooms', 'foyer', '--dry-run'],
      options(value),
    );
    expect(blockedDelete.exitCode).toBe(4);
    const allowedDelete = await runNovelTeaCli(
      [
        '--json',
        'entity',
        'delete',
        'rooms',
        'foyer',
        '--dry-run',
        '--force',
        '--allow-possible-source-references',
      ],
      options(value),
    );
    expect(allowedDelete.exitCode).toBe(0);
  });

  it('fails dry-run closed rather than recovering pending transaction state', async () => {
    const value = fixture();
    await value.fileSystem.writeTextAtomic(
      `${root}/.noveltea/transactions/pending/manifest.json`,
      '{}\n',
    );
    const result = await runNovelTeaCli(
      ['--json', 'entity', 'create', 'rooms', 'hallway', '--dry-run'],
      options(value),
    );
    expect(result.exitCode).toBe(5);
    expect(JSON.parse(result.stdout).diagnostics[0].code).toBe(
      'WORKSPACE_TRANSACTION_RECOVERY_CONFLICT',
    );
    expect(
      await value.fileSystem.inspect(`${root}/.noveltea/transactions/pending/manifest.json`),
    ).toBe('file');
  });

  it('uses the transaction/conflict exit family when workspace open is blocked by a writer', async () => {
    const value = fixture();
    await value.fileSystem.writeTextAtomic(
      `${root}/.noveltea/transactions/.writer-lock/owner.json`,
      `${JSON.stringify({
        ownerToken: 'other-owner',
        pid: 999,
        operationLabel: 'other writer',
        transactionId: null,
      })}\n`,
    );

    const result = await runNovelTeaCli(['--json', 'validate'], options(value));

    expect(result.exitCode).toBe(5);
    expect(JSON.parse(result.stdout).diagnostics[0].code).toBe('WORKSPACE_BUSY');
  });

  it('classifies unexpected mutation implementation failures as internal errors', async () => {
    const value = fixture();
    value.workspace.write = async () => {
      throw new Error('unexpected writer bug');
    };

    const result = await runNovelTeaCli(
      ['--json', 'entity', 'create', 'rooms', 'hallway'],
      options(value),
    );

    expect(result.exitCode).toBe(70);
    expect(JSON.parse(result.stdout).diagnostics[0]).toMatchObject({
      code: 'CLI_INTERNAL',
      message: 'unexpected writer bug',
    });
  });

  it('exposes one reusable Node-reference runner covering every Phase 6 command path', async () => {
    expect(PHASE_SIX_NODE_REFERENCE_COMMANDS).toEqual([
      'validate',
      'entity create',
      'entity rename',
      'entity delete',
      'usages',
    ]);
    const commands: readonly string[][] = [
      ['--json', 'validate'],
      ['--json', 'entity', 'create', 'rooms', 'new-room', '--dry-run'],
      [
        '--json',
        'entity',
        'rename',
        'rooms',
        'foyer',
        'lobby',
        '--dry-run',
        '--allow-possible-source-references',
      ],
      [
        '--json',
        'entity',
        'delete',
        'rooms',
        'foyer',
        '--dry-run',
        '--allow-possible-source-references',
      ],
      ['--json', 'usages', 'rooms', 'foyer'],
    ];
    for (const argv of commands) {
      const value = fixture(projectWithSourceReference());
      const first = await novelTeaNodeReferenceRunner.run({ argv, options: options(value) });
      const secondValue = fixture(projectWithSourceReference());
      const second = await novelTeaNodeReferenceRunner.run({ argv, options: options(secondValue) });
      expect(second.exitCode).toBe(first.exitCode);
      expect(second.stdout).toBe(first.stdout);
      expect(second.stderr).toBe(first.stderr);
    }
  });
});
