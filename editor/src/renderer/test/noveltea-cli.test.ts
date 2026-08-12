import { describe, expect, it } from 'vite-plus/test';
import { runNovelTeaCli } from '../../cli/application';
import { createNovelTeaAgentKitPayload } from '../../cli/agent-kit';
import { syncNovelTeaAgentKit } from '../../cli/agent-sync';
import { NOVELTEA_CLI_HELP, NOVELTEA_CLI_WORKSPACE_DIAGNOSTIC_CODES } from '../../cli/contracts';
import {
  PHASE_SIX_NODE_REFERENCE_COMMANDS,
  novelTeaNodeReferenceRunner,
} from '../../cli/node-reference-runner';
import type { NovelTeaCliNativeToolService } from '../../cli/native-tool-service';
import type { NovelTeaCliPlatformToolService } from '../../cli/platform-tool-service';
import { defaultPlatformExportProfile } from '../../shared/project-schema/platform-export-contracts';
import { createDefaultAuthoringRecord } from '../project/entity-operations';
import {
  createAuthoringProject,
  type AuthoringProject,
} from '../../shared/project-schema/authoring-project';
import {
  InMemoryProjectWorkspaceFileSystem,
  NOVELTEA_AGENT_BOOTSTRAP_END,
  NOVELTEA_AGENT_BOOTSTRAP_START,
  NOVELTEA_PROJECT_AGENTS_BOOTSTRAP,
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
  platformTools?: NovelTeaCliPlatformToolService,
) {
  return {
    cwd,
    fileSystem: value.fileSystem,
    workspace: value.workspace,
    ...(nativeTools ? { nativeTools } : {}),
    ...(platformTools ? { platformTools } : {}),
  };
}

function platformTools(
  patch: Partial<NovelTeaCliPlatformToolService> = {},
): NovelTeaCliPlatformToolService {
  return {
    async listTemplates() {
      return [];
    },
    async inspectTemplate() {
      return null;
    },
    async installTemplate() {
      return { success: false, diagnostics: [] };
    },
    async removeTemplate() {
      return { removed: false };
    },
    async exportProject(request) {
      return {
        ok: true,
        success: true,
        cancelled: false,
        operationId: 'test-export',
        templateToken: 'linux@build-1',
        outputDirectory: request.outputDirectory,
        artifacts: [],
        diagnostics: [],
      };
    },
    async initializeConfig() {
      return {
        format: 'noveltea.editor-export-local-state',
        formatVersion: 1,
        templateRoots: [],
        toolchains: {},
        signing: {},
      };
    },
    ...patch,
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

describe('NovelTea headless CLI', () => {
  it('lists platform profiles with the copyable export id and selected marker', async () => {
    const value = fixture();
    const profile = defaultPlatformExportProfile('linux');
    value.project.settings.platformExport = {
      selectedProfileId: profile.id,
      profiles: [profile],
    };
    const refreshed = fixture(value.project);
    const result = await runNovelTeaCli(
      ['--json', 'platform', 'profiles'],
      options(refreshed, root, undefined, platformTools()),
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      profiles: [
        {
          id: 'linux-release',
          selected: true,
          target: 'linux',
          architecture: 'x64',
        },
      ],
    });
  });

  it('exports the selected platform profile and forwards strict publication flags', async () => {
    const project = validProject();
    const profile = defaultPlatformExportProfile('linux');
    project.settings.platformExport = { selectedProfileId: profile.id, profiles: [profile] };
    const value = fixture(project);
    let request: Parameters<NovelTeaCliPlatformToolService['exportProject']>[0] | undefined;
    const result = await runNovelTeaCli(
      [
        '--json',
        'platform',
        'export',
        '--output',
        'dist/game',
        '--check',
        '--force',
        '--sign',
        '--allow-untrusted-template',
      ],
      options(
        value,
        root,
        undefined,
        platformTools({
          async exportProject(value) {
            request = value;
            return {
              ok: true,
              success: true,
              cancelled: false,
              operationId: 'checked',
              templateToken: 'linux@build-1',
              outputDirectory: value.outputDirectory,
              diagnostics: [],
            };
          },
        }),
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(request).toMatchObject({
      profileId: 'linux-release',
      outputDirectory: '/projects/headless/dist/game',
      checkOnly: true,
      force: true,
      sign: true,
      allowUntrustedTemplate: true,
    });
  });

  it('rejects the removed platform completion option', async () => {
    const project = validProject();
    const profile = defaultPlatformExportProfile('linux');
    project.settings.platformExport = { selectedProfileId: profile.id, profiles: [profile] };
    const result = await runNovelTeaCli(
      ['--json', 'platform', 'export', '--output', 'dist/game', '--completion', 'published'],
      options(fixture(project), root, undefined, platformTools()),
    );
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).diagnostics[0].message).toContain("'--completion'");
  });

  it('does not silently choose the first platform profile when no selection is configured', async () => {
    const project = validProject();
    const profile = defaultPlatformExportProfile('linux');
    project.settings.platformExport = { selectedProfileId: null, profiles: [profile] };
    const result = await runNovelTeaCli(
      ['--json', 'platform', 'export', '--output', 'dist/game'],
      options(fixture(project), root, undefined, platformTools()),
    );

    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stdout).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'platform.profile_missing' })]),
    );
  });

  it('keeps template commands project-independent and rejects --project', async () => {
    const tools = platformTools();
    const listed = await runNovelTeaCli(['--json', 'platform', 'template', 'list'], {
      cwd: '/missing',
      platformTools: tools,
    });
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({ templates: [] });

    const rejected = await runNovelTeaCli(['--project', root, 'platform', 'template', 'list'], {
      cwd: '/missing',
      platformTools: tools,
    });
    expect(rejected.exitCode).toBe(2);
  });

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

  it('reports a usage failure when invoked without a command', async () => {
    const result = await runNovelTeaCli([], { cwd: '/missing' });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('[error] CLI_USAGE /: A command is required.');
    expect(result.stderr).toContain(NOVELTEA_CLI_HELP.trimEnd());
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
      'AGENT_BOOTSTRAP_MISSING',
      'AGENT_BOOTSTRAP_OUTDATED',
      'AGENT_BOOTSTRAP_MANUAL_REPAIR_REQUIRED',
      'AGENT_LOCAL_STATE_NOT_IGNORED',
      'AGENT_SYNC_MUTATION_FAILED',
      'PROJECT_CREATE_DESTINATION_CONFLICT',
      'PROJECT_CREATE_MUTATION_FAILED',
      'PROJECT_CREATE_INTERNAL',
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

  it('generates the complete deterministic Phase 8 agent-kit payload from current codecs', () => {
    const first = createNovelTeaAgentKitPayload();
    const second = createNovelTeaAgentKitPayload();
    expect(second).toEqual(first);
    expect(Object.keys(first.files)).toEqual(
      expect.arrayContaining([
        'GUIDE.md',
        'CLI.md',
        'PROJECT_FORMAT.md',
        'skill/SKILL.md',
        'schemas/project.schema.json',
        'schemas/properties.schema.json',
        'schemas/localization.schema.json',
        'schemas/editor.schema.json',
        'schemas/records/layouts.schema.json',
        'schemas/records/scripts.schema.json',
        'schemas/records/tests.schema.json',
      ]),
    );
    const manifest = JSON.parse(first.manifestText);
    expect(manifest).toMatchObject({
      schema: 'noveltea.agent-kit.manifest',
      schemaVersion: 1,
      agentKitVersion: 1,
      cliVersion: '1.0.0',
      projectWorkspaceVersion: 1,
    });
    expect(Object.keys(manifest.files)).toEqual(Object.keys(first.files));
    expect(first.files['schemas/records/layouts.schema.json']).toContain('sourceMode');
    expect(first.files['schemas/records/layouts.schema.json']).toContain('file');
    const scriptSchema = JSON.parse(first.files['schemas/records/scripts.schema.json']!);
    expect(scriptSchema.properties.data.properties.source.oneOf[0].properties.path.pattern).toBe(
      '^scripts\\/(?:[^/]+\\/)*[^/]+\\.lua$',
    );
  });

  it('repairs, validates, and then leaves an unchanged agent kit untouched', async () => {
    const value = fixture();
    const first = await runNovelTeaCli(['--json', 'agent', 'sync'], options(value));
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout).agentKitChanged).toBe(true);
    expect(JSON.parse(first.stdout)).toMatchObject({
      agentBootstrapStatus: 'missing',
      agentBootstrapChanged: false,
      agentGitignoreStatus: 'created',
      agentGitignoreCreated: true,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'AGENT_BOOTSTRAP_MISSING', severity: 'warning' }),
      ]),
    });
    expect(await value.fileSystem.readText(`${root}/.gitignore`)).toBe('/.noveltea/\n');
    const manifestBefore = await value.fileSystem.readText(`${root}/.noveltea/agent/manifest.json`);
    const second = await runNovelTeaCli(['--json', 'agent', 'sync'], options(value));
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout).agentKitChanged).toBe(false);
    expect(await value.fileSystem.readText(`${root}/.noveltea/agent/manifest.json`)).toBe(
      manifestBefore,
    );
  });

  it('creates, updates, and refuses malformed managed AGENTS.md blocks through --fix', async () => {
    const value = fixture();
    const created = await runNovelTeaCli(['--json', 'agent', 'sync', '--fix'], options(value));
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({
      agentBootstrapStatus: 'current',
      agentBootstrapChanged: true,
      diagnostics: [],
    });
    expect(await value.fileSystem.readText(`${root}/AGENTS.md`)).toBe(
      NOVELTEA_PROJECT_AGENTS_BOOTSTRAP,
    );

    await value.fileSystem.writeTextAtomic(
      `${root}/AGENTS.md`,
      `# Team Project\r\n\r\n${NOVELTEA_AGENT_BOOTSTRAP_START}\r\nold\r\n${NOVELTEA_AGENT_BOOTSTRAP_END}\r\n\r\nTeam rule.\r\n`,
    );
    const updated = await runNovelTeaCli(['--json', 'agent', 'sync', '--fix'], options(value));
    expect(updated.exitCode).toBe(0);
    const updatedText = await value.fileSystem.readText(`${root}/AGENTS.md`);
    expect(updatedText).toContain('# Team Project\r\n');
    expect(updatedText).toContain('DO NOT EDIT THIS BLOCK.');
    expect(updatedText).toContain('\r\n\r\nTeam rule.\r\n');

    await value.fileSystem.writeTextAtomic(
      `${root}/AGENTS.md`,
      `${NOVELTEA_AGENT_BOOTSTRAP_START}\nmissing end\n`,
    );
    const malformed = await runNovelTeaCli(['--json', 'agent', 'sync', '--fix'], options(value));
    expect(malformed.exitCode).toBe(5);
    expect(JSON.parse(malformed.stdout).diagnostics[0].code).toBe(
      'AGENT_BOOTSTRAP_MANUAL_REPAIR_REQUIRED',
    );
  });

  it('preserves an existing gitignore and warns only when it does not mention .noveltea', async () => {
    const value = fixture();
    await value.fileSystem.writeTextAtomic(`${root}/.gitignore`, 'dist/\n');
    const missing = await runNovelTeaCli(['--json', 'agent', 'sync', '--fix'], options(value));
    expect(missing.exitCode).toBe(0);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      agentGitignoreStatus: 'missing-rule',
      agentGitignoreCreated: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'AGENT_LOCAL_STATE_NOT_IGNORED' }),
      ]),
    });
    expect(await value.fileSystem.readText(`${root}/.gitignore`)).toBe('dist/\n');

    await value.fileSystem.writeTextAtomic(`${root}/.gitignore`, '# custom .noveltea handling\n');
    const accepted = await runNovelTeaCli(['--json', 'agent', 'sync'], options(value));
    expect(JSON.parse(accepted.stdout).agentGitignoreStatus).toBe('present');
    expect(JSON.parse(accepted.stdout).diagnostics).toEqual([]);
  });

  it('creates projects transactionally without discovery and rejects occupied destinations', async () => {
    const fileSystem = new InMemoryProjectWorkspaceFileSystem();
    const workspace = new ProjectWorkspaceService(fileSystem);
    const created = await runNovelTeaCli(
      ['--json', 'project', 'create', '/projects/My Story', '--name', 'My Story'],
      { cwd: '/', fileSystem, workspace },
    );
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({
      projectRoot: '/projects/My Story',
      projectFilePath: '/projects/My Story/project.json',
      projectId: 'my-story',
    });
    expect(await fileSystem.readText('/projects/My Story/AGENTS.md')).toBe(
      NOVELTEA_PROJECT_AGENTS_BOOTSTRAP,
    );

    const conflict = await runNovelTeaCli(
      ['--json', 'project', 'create', '/projects/My Story', '--name', 'Again'],
      { cwd: '/', fileSystem, workspace },
    );
    expect(conflict.exitCode).toBe(5);
    expect(JSON.parse(conflict.stdout).diagnostics[0].code).toBe(
      'PROJECT_CREATE_DESTINATION_CONFLICT',
    );
    const explicit = await runNovelTeaCli(
      ['--project', '/elsewhere', '--json', 'project', 'create', '/new', '--name', 'New'],
      { cwd: '/', fileSystem, workspace },
    );
    expect(explicit.exitCode).toBe(2);
  });

  it('regenerates an unsupported agent-kit manifest without changing tracked project source', async () => {
    const value = fixture();
    await syncNovelTeaAgentKit(value.fileSystem, root);
    const trackedRoomBefore = await value.fileSystem.readText(`${root}/records/rooms/start.json`);
    const manifestPath = `${root}/.noveltea/agent/manifest.json`;
    const staleManifest = JSON.parse(await value.fileSystem.readText(manifestPath));
    staleManifest.schemaVersion = 999;
    await value.fileSystem.writeTextAtomic(
      manifestPath,
      `${JSON.stringify(staleManifest, null, 2)}\n`,
    );

    const result = await runNovelTeaCli(['--json', 'agent', 'sync'], options(value));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).agentKitChanged).toBe(true);
    expect(JSON.parse(await value.fileSystem.readText(manifestPath)).schemaVersion).toBe(1);
    expect(await value.fileSystem.readText(`${root}/records/rooms/start.json`)).toBe(
      trackedRoomBefore,
    );
  });

  it('preserves the previous complete kit when refresh activation fails', async () => {
    const value = fixture();
    await syncNovelTeaAgentKit(value.fileSystem, root);
    const originalGuide = await value.fileSystem.readText(`${root}/.noveltea/agent/GUIDE.md`);
    await value.fileSystem.writeTextAtomic(
      `${root}/.noveltea/agent/GUIDE.md`,
      `${originalGuide}\nold`,
    );
    await expect(
      syncNovelTeaAgentKit(value.fileSystem, root, {
        beforeActivate() {
          throw new Error('injected refresh failure');
        },
      }),
    ).rejects.toThrow('injected refresh failure');
    expect(await value.fileSystem.readText(`${root}/.noveltea/agent/GUIDE.md`)).toBe(
      `${originalGuide}\nold`,
    );
    expect(await value.fileSystem.inspect(`${root}/.noveltea/agent/manifest.json`)).toBe('file');
  });

  it('supports the agent workflow with direct edits, semantic rename, and no generated-state dependency', async () => {
    const value = fixture();
    expect((await runNovelTeaCli(['--json', 'agent', 'sync'], options(value))).exitCode).toBe(0);

    const roomPath = `${root}/records/rooms/start.json`;
    const room = JSON.parse(await value.fileSystem.readText(roomPath));
    room.description = 'Edited directly by an agent-like workflow.';
    await value.fileSystem.writeTextAtomic(roomPath, `${JSON.stringify(room, null, 2)}\n`);
    expect((await runNovelTeaCli(['--json', 'validate'], options(value))).exitCode).toBe(0);

    const dryRun = await runNovelTeaCli(
      ['--json', 'entity', 'rename', 'rooms', 'start', 'foyer', '--dry-run'],
      options(value),
    );
    expect(dryRun.exitCode).toBe(0);
    expect(await value.fileSystem.inspect(`${root}/records/rooms/start.json`)).toBe('file');

    const rename = await runNovelTeaCli(
      ['--json', 'entity', 'rename', 'rooms', 'start', 'foyer'],
      options(value),
    );
    expect(rename.exitCode).toBe(0);
    expect((await runNovelTeaCli(['--json', 'validate'], options(value))).exitCode).toBe(0);

    const opened = await value.workspace.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(
      opened.snapshot.canonicalSourceFiles.every((file) => !file.startsWith('.noveltea/')),
    ).toBe(true);
    await value.fileSystem.removeDirectory(`${root}/.noveltea`);
    expect((await runNovelTeaCli(['--json', 'validate'], options(value))).exitCode).toBe(0);
  });
});
