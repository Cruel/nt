import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { runNovelTeaCli } from '../../cli/application';
import { createNovelTeaAgentKitPayload } from '../../cli/agent-kit';
import {
  loadAgentKitSourceFiles,
  loadAgentKitSystemLayoutSourceFiles,
} from '../../cli/agent-kit/source';
import { syncNovelTeaAgentKit } from '../../cli/agent-sync';
import {
  NOVELTEA_CLI_HELP,
  NOVELTEA_CLI_VERSION,
  NOVELTEA_CLI_WORKSPACE_DIAGNOSTIC_CODES,
} from '../../cli/contracts';
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
    async loadUserConfig() {
      return {
        format: 'noveltea.user-export-config',
        formatVersion: 1,
        toolchains: {},
        signingProfiles: [],
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
  it('lists platform profiles with copyable export ids', async () => {
    const value = fixture();
    const profile = defaultPlatformExportProfile('linux');
    value.project.export.profiles = [profile];
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
          target: 'linux',
          architecture: 'x64',
        },
      ],
    });
  });

  it('exports the sole platform profile and forwards strict publication flags', async () => {
    const project = validProject();
    const profile = defaultPlatformExportProfile('linux');
    project.export.profiles = [profile];
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
      sign: false,
      allowUntrustedTemplate: true,
    });
  });

  it('uses a named shared signing configuration for headless export', async () => {
    const project = validProject();
    const profile = defaultPlatformExportProfile('windows');
    project.export.profiles = [profile];
    const value = fixture(project);
    let request: Parameters<NovelTeaCliPlatformToolService['exportProject']>[0] | undefined;
    const tools = platformTools({
      async loadUserConfig() {
        return {
          format: 'noveltea.user-export-config',
          formatVersion: 1,
          toolchains: {},
          signingProfiles: [
            {
              id: 'windows-release',
              label: 'Windows Release Certificate',
              target: 'windows',
              command: 'signtool',
              args: ['sign', '{executable}'],
              verifyCommand: 'signtool',
              verifyArgs: ['verify', '{executable}'],
            },
          ],
        };
      },
      async exportProject(value) {
        request = value;
        return {
          ok: true,
          success: true,
          cancelled: false,
          operationId: 'signed',
          templateToken: 'windows@build-1',
          outputDirectory: value.outputDirectory,
          diagnostics: [],
        };
      },
    });

    const result = await runNovelTeaCli(
      [
        '--json',
        'platform',
        'export',
        '--output',
        'dist/game',
        '--signing-profile',
        'windows-release',
      ],
      options(value, root, undefined, tools),
    );

    expect(result.exitCode).toBe(0);
    expect(request).toMatchObject({
      sign: true,
      localState: {
        signing: {
          windows: {
            command: 'signtool',
            args: ['sign', '{executable}'],
            verifyCommand: 'signtool',
            verifyArgs: ['verify', '{executable}'],
          },
        },
      },
    });
  });

  it('rejects the removed platform completion option', async () => {
    const project = validProject();
    const profile = defaultPlatformExportProfile('linux');
    project.export.profiles = [profile];
    const result = await runNovelTeaCli(
      ['--json', 'platform', 'export', '--output', 'dist/game', '--completion', 'published'],
      options(fixture(project), root, undefined, platformTools()),
    );
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).diagnostics[0].message).toContain("'--completion'");
  });

  it('uses the sole platform profile when --profile is omitted', async () => {
    const project = validProject();
    const profile = defaultPlatformExportProfile('linux');
    project.export.profiles = [profile];
    let request: Parameters<NovelTeaCliPlatformToolService['exportProject']>[0] | undefined;
    const result = await runNovelTeaCli(
      ['--json', 'platform', 'export', '--output', 'dist/game'],
      options(
        fixture(project),
        root,
        undefined,
        platformTools({
          async exportProject(value) {
            request = value;
            return {
              ok: true,
              success: true,
              cancelled: false,
              operationId: 'single-profile',
              templateToken: 'linux@build-1',
              outputDirectory: value.outputDirectory,
              diagnostics: [],
            };
          },
        }),
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(request?.profileId).toBe(profile.id);
  });

  it('requires --profile when multiple platform profiles are configured', async () => {
    const project = validProject();
    project.export.profiles = [
      defaultPlatformExportProfile('linux'),
      defaultPlatformExportProfile('windows'),
    ];
    const result = await runNovelTeaCli(
      ['--json', 'platform', 'export', '--output', 'dist/game'],
      options(fixture(project), root, undefined, platformTools()),
    );

    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stdout).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'platform.profile_missing', path: '/export/profiles' }),
      ]),
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
      version: NOVELTEA_CLI_VERSION,
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

  it('accepts Runtime Package developer overrides headlessly', async () => {
    const value = fixture(validProject());
    let receivedOptions: unknown;
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
      async exportPackage(request) {
        receivedOptions = (request as { options?: unknown }).options;
        return { ok: true, success: true };
      },
      shaderc() {
        return 0;
      },
    };

    const result = await runNovelTeaCli(
      [
        '--json',
        'package',
        'export',
        '--output',
        'dist/game.ntpkg',
        '--include-unused-assets',
        '--include-shader-sources',
      ],
      options(value, root, nativeTools),
    );

    expect(result.exitCode).toBe(0);
    expect(receivedOptions).toMatchObject({ stripShaderSources: false });
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
      shaderVariants: ['glsl-120', 'essl-100', 'essl-300', 'metal'],
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
        'docs/AUTHORING.md',
        'docs/INTERACTIONS.md',
        'docs/ROOMS.md',
        'docs/RMLUI.md',
        'docs/RCSS_REFERENCE.md',
        'docs/RMLUI_DATA_BINDING.md',
        'docs/RMLUI_CUSTOM_COMPONENTS.md',
        'docs/RMLUI_LUA.md',
        'schemas/project.schema.json',
        'schemas/properties.schema.json',
        'schemas/localization.schema.json',
        'schemas/editor.schema.json',
        'schemas/records/layouts.schema.json',
        'schemas/records/scripts.schema.json',
        'schemas/records/tests.schema.json',
        'system-layouts/manifest.json',
        'system-layouts/ui/title/default-title.rml',
        'system-layouts/ui/runtime/runtime_game.rml',
        'system-layouts/ui/menu/system-menu.rcss',
      ]),
    );
    const manifest = JSON.parse(first.manifestText);
    expect(manifest).toMatchObject({
      schema: 'noveltea.agent-kit.manifest',
      schemaVersion: 2,
      agentKitVersion: 1,
      cliVersion: '1.0.0',
      projectWorkspaceVersion: 1,
    });
    expect(Object.keys(manifest.files)).toEqual(Object.keys(first.files));
    const authoredSourceFiles = loadAgentKitSourceFiles();
    expect(Object.keys(manifest.provenance.documents)).toEqual(Object.keys(authoredSourceFiles));
    expect(manifest.provenance.sources).toMatchObject({
      noveltea: {
        kind: 'repository',
        repository: 'https://github.com/Cruel/nt.git',
        revision: 'd103dc48c6bcde6134271793b40354ec46560692',
      },
      rmlui: {
        kind: 'repository',
        repository: 'https://github.com/Cruel/RmlUi.git',
        revision: 'c6744d15bda5e9df7ad9c1f8eae937157e7ed309',
        version: '6.3-dev',
      },
      'lua-5.5-manual': {
        kind: 'web',
        url: 'https://www.lua.org/manual/5.5/manual.html',
        version: '5.5',
      },
      'rmlui-docs': {
        kind: 'web',
        url: 'https://mikke89.github.io/RmlUiDoc/',
      },
      'rmlui-docs-html4': {
        kind: 'repository',
        repository: 'https://github.com/mikke89/RmlUiDoc.git',
        revision: '23cc335d8c67c12c706dee4b8ddec9416e4c4280',
      },
    });
    expect(manifest.provenance.documents['docs/LAYOUTS.md'].sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'noveltea' }),
        expect.objectContaining({ source: 'rmlui' }),
      ]),
    );
    expect(manifest.provenance.documents['docs/RMLUI.md'].sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'noveltea' }),
        expect.objectContaining({ source: 'rmlui' }),
        expect.objectContaining({ source: 'rmlui-docs' }),
      ]),
    );
    expect(manifest.provenance.documents['docs/RCSS_REFERENCE.md'].sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'noveltea' }),
        expect.objectContaining({ source: 'rmlui' }),
        expect.objectContaining({ source: 'rmlui-docs' }),
      ]),
    );
    expect(manifest.provenance.documents['docs/RMLUI_DATA_BINDING.md'].sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'noveltea' }),
        expect.objectContaining({ source: 'rmlui' }),
        expect.objectContaining({ source: 'rmlui-docs' }),
      ]),
    );
    expect(manifest.provenance.documents['docs/RMLUI_CUSTOM_COMPONENTS.md'].sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'noveltea' }),
        expect.objectContaining({ source: 'rmlui' }),
      ]),
    );
    expect(manifest.provenance.documents['docs/RMLUI_LUA.md'].sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'noveltea' }),
        expect.objectContaining({ source: 'rmlui' }),
        expect.objectContaining({ source: 'lua-5.5-manual' }),
      ]),
    );
    expect(manifest.provenance.documents['docs/LUA.md'].sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'noveltea' }),
        expect.objectContaining({ source: 'lua-5.5-manual' }),
      ]),
    );
    for (const [relativePath, text] of Object.entries(authoredSourceFiles))
      expect(first.files[relativePath]).toBe(text);
    const systemLayoutSourceFiles = loadAgentKitSystemLayoutSourceFiles();
    for (const [relativePath, text] of Object.entries(systemLayoutSourceFiles))
      expect(first.files[`system-layouts/${relativePath}`]).toBe(text);
    expect(JSON.parse(first.files['system-layouts/manifest.json']!)).toEqual({
      schema: 'noveltea.agent-kit.system-layouts',
      schemaVersion: 2,
      baselines: {
        implicit: true,
        appliesTo: [
          'built-in-system-layouts',
          'project-layouts',
          'fragments',
          'focused-previews',
          'runtime-ui-utility-documents',
        ],
        cascade: [
          {
            id: 'rmlui-html4',
            path: 'ui/baseline/rmlui-html4.rcss',
            authoringUrl: 'system|/ui/baseline/rmlui-html4.rcss',
          },
          {
            id: 'noveltea',
            path: 'ui/baseline/noveltea.rcss',
            authoringUrl: 'system|/ui/baseline/noveltea.rcss',
          },
          { id: 'template-rcss' },
          { id: 'document-rcss' },
        ],
      },
      roles: {
        title: {
          builtinFallback: true,
          document: 'ui/title/default-title.rml',
          authoringUrl: 'system|/ui/title/default-title.rml',
          supportingFiles: ['ui/title/default-title.rcss'],
        },
        'game-hud': {
          builtinFallback: true,
          document: 'ui/runtime/runtime_game.rml',
          authoringUrl: 'system|/ui/runtime/runtime_game.rml',
          supportingFiles: ['ui/runtime/runtime_game.rcss'],
        },
        'pause-menu': {
          builtinFallback: true,
          document: 'ui/menu/pause-menu.rml',
          authoringUrl: 'system|/ui/menu/pause-menu.rml',
          supportingFiles: ['ui/menu/pause-menu.rcss'],
        },
        'save-menu': {
          builtinFallback: true,
          document: 'ui/menu/save-menu.rml',
          authoringUrl: 'system|/ui/menu/save-menu.rml',
          supportingFiles: ['ui/menu/system-menu.rcss'],
        },
        'load-menu': {
          builtinFallback: true,
          document: 'ui/menu/load-menu.rml',
          authoringUrl: 'system|/ui/menu/load-menu.rml',
          supportingFiles: ['ui/menu/system-menu.rcss'],
        },
        'settings-menu': {
          builtinFallback: true,
          document: 'ui/menu/settings-menu.rml',
          authoringUrl: 'system|/ui/menu/settings-menu.rml',
          supportingFiles: ['ui/menu/system-menu.rcss'],
        },
        'text-log': {
          builtinFallback: true,
          document: 'ui/menu/text-log.rml',
          authoringUrl: 'system|/ui/menu/text-log.rml',
          supportingFiles: ['ui/menu/system-menu.rcss'],
        },
        modal: {
          builtinFallback: true,
          document: 'ui/menu/modal.rml',
          authoringUrl: 'system|/ui/menu/modal.rml',
          supportingFiles: ['ui/menu/system-menu.rcss'],
        },
        'debug-overlay': {
          builtinFallback: false,
          document: null,
          authoringUrl: null,
          supportingFiles: [],
        },
      },
    });
    expect(first.files['agent-kit-provenance.json']).toBeUndefined();
    expect(first.files['skill/SKILL.md']).toBeUndefined();
    expect(first.files['GUIDE.md']).toContain('.noveltea/agent/docs/ROOMS.md');
    expect(first.files['GUIDE.md']).toContain('.noveltea/agent/docs/RMLUI.md');
    expect(first.files['GUIDE.md']).toContain('.noveltea/agent/docs/RCSS_REFERENCE.md');
    expect(first.files['GUIDE.md']).toContain('.noveltea/agent/docs/RMLUI_DATA_BINDING.md');
    expect(first.files['GUIDE.md']).toContain('.noveltea/agent/docs/RMLUI_CUSTOM_COMPONENTS.md');
    expect(first.files['GUIDE.md']).toContain('.noveltea/agent/docs/RMLUI_LUA.md');
    expect(first.files['GUIDE.md']).toContain('.noveltea/agent/system-layouts/ui/');
    expect(first.files['GUIDE.md']).not.toContain('.noveltea/agent/system-layouts/manifest.json');
    expect(first.files['GUIDE.md']).toContain(
      'NovelTea Lua sandbox, APIs, capabilities, and yielding rules',
    );
    expect(first.files['GUIDE.md']).toContain(
      'do not begin ordinary authoring work by reverse-engineering the schemas',
    );
    expect(first.files['docs/AUTHORING.md']).toContain('Need only an image visible in the Room?');
    expect(first.files['docs/ROOMS.md']).toContain(
      'Template 2: sprite-backed Interactable placed in a Room',
    );
    expect(first.files['docs/ROOMS.md']).toContain(
      'normalized to the complete Room background source image',
    );
    expect(first.files['docs/INTERACTIONS.md']).toContain('Room hotspot');
    expect(first.files['docs/INTERACTIONS.md']).toContain('arity-`1` Verb');
    expect(first.files['docs/LAYOUTS.md']).toContain('.noveltea/agent/docs/RMLUI.md');
    expect(first.files['docs/LAYOUTS.md']).toContain('.noveltea/agent/docs/RMLUI_LUA.md');
    expect(first.files['docs/LAYOUTS.md']).toContain(
      '.noveltea/agent/system-layouts/ui/title/default-title.rml',
    );
    expect(first.files['docs/LAYOUTS.md']).toContain(
      '.noveltea/agent/system-layouts/ui/baseline/rmlui-html4.rcss',
    );
    expect(first.files['docs/LAYOUTS.md']).not.toContain(
      '.noveltea/agent/system-layouts/manifest.json',
    );
    expect(first.files['docs/LAYOUTS.md']).toContain('`debug-overlay` has no built-in fallback');
    expect(first.files['docs/RMLUI.md']).toContain('RML is XML, not browser HTML');
    expect(first.files['docs/RMLUI.md']).toContain(
      "RmlUi's `:hover`, `:active`, `:focus`, and `:focus-visible` state propagates backward",
    );
    expect(first.files['docs/RMLUI.md']).toContain('`calc()`, `min()`, `max()`, and `clamp()`');
    expect(first.files['docs/RMLUI.md']).toContain('Universal RCSS baseline');
    expect(first.files['docs/RMLUI.md']).toContain(
      'RmlUi HTML4 baseline\nNovelTea baseline\ntemplate RCSS\ndocument/Layout RCSS',
    );
    expect(first.files['docs/RMLUI.md']).toContain('.noveltea/agent/docs/RCSS_REFERENCE.md');
    expect(first.files['docs/RCSS_REFERENCE.md']).toContain('registered built-in properties: 99');
    expect(first.files['docs/RCSS_REFERENCE.md']).toContain('registered built-in shorthands: 20');
    expect(first.files['docs/RCSS_REFERENCE.md']).toContain('`ex` is not registered');
    expect(first.files['docs/RCSS_REFERENCE.md']).toContain('There is no `border-style` property');
    expect(first.files['docs/RMLUI_DATA_BINDING.md']).toContain('gameplay.text_log.entries[]');
    expect(first.files['docs/RMLUI_DATA_BINDING.md']).toContain('shell.save_slots[]');
    expect(first.files['docs/RMLUI_DATA_BINDING.md']).toContain('ui_choose(kind, id)');
    expect(first.files['docs/RMLUI_DATA_BINDING.md']).toContain('data-alias-name');
    expect(first.files['docs/RMLUI_DATA_BINDING.md']).toContain('The model is read-only');
    expect(first.files['docs/RMLUI_CUSTOM_COMPONENTS.md']).toContain('nt-active-text');
    expect(first.files['docs/RMLUI_CUSTOM_COMPONENTS.md']).toContain('nt-map-view   (provisional)');
    expect(first.files['docs/RMLUI_CUSTOM_COMPONENTS.md']).toContain(
      'There is no current `nt-text-log` element',
    );
    expect(first.files['docs/RMLUI_LUA.md']).toContain('function(event, element, document)');
    expect(first.files['docs/RMLUI_LUA.md']).toContain(
      'controls **only the dedicated Layout Lua source**',
    );
    expect(first.files['docs/RMLUI_LUA.md']).toContain('rmlui:CreateContext');
    expect(first.files['docs/RMLUI_LUA.md']).toContain('.noveltea/agent/docs/LUA.md');
    expect(first.files['docs/LUA.md']).toContain('Lua 5.5.0 exactly');
    expect(first.files['docs/LUA.md']).toContain(
      'noveltea.properties.get(owner_kind, owner_id, property_id)',
    );
    expect(first.files['docs/LUA.md']).toContain(
      'Game.choose` and `Game.navigate` are deliberately **zero-based**',
    );
    expect(first.files['docs/LUA.md']).toContain('audio.play_and_wait');
    expect(first.files['docs/LUA.md']).toContain('Game.ui.navigate_map_connection');
    expect(first.files['docs/LUA.md']).toContain('Game.shell.state()');
    expect(first.files['schemas/records/layouts.schema.json']).toContain('sourceMode');
    expect(first.files['schemas/records/layouts.schema.json']).toContain('file');
    const scriptSchema = JSON.parse(first.files['schemas/records/scripts.schema.json']!);
    expect(scriptSchema.properties.data.properties.source.oneOf[0].properties.path.pattern).toBe(
      '^scripts\\/(?:[^/]+\\/)*[^/]+\\.lua$',
    );
  });

  it('certifies generated system Layout references against the runtime fallback source', () => {
    const engine = readFileSync('../engine/src/engine.cpp', 'utf8');
    const documentRegistry = readFileSync(
      '../engine/src/ui/rmlui/rmlui_document_registry.cpp',
      'utf8',
    );
    const layoutRealizer = readFileSync('../engine/src/host/layout_realizer.cpp', 'utf8');
    const runtimeSources = `${documentRegistry}\n${layoutRealizer}`;

    const payload = createNovelTeaAgentKitPayload();
    const reference = JSON.parse(payload.files['system-layouts/manifest.json']!);
    const expectedFallbacks = [
      ['Title', 'title'],
      ['GameHud', 'game-hud'],
      ['PauseMenu', 'pause-menu'],
      ['SaveMenu', 'save-menu'],
      ['LoadMenu', 'load-menu'],
      ['SettingsMenu', 'settings-menu'],
      ['TextLog', 'text-log'],
      ['Modal', 'modal'],
    ] as const;
    for (const [enumName, role] of expectedFallbacks) {
      expect(engine).toMatch(
        new RegExp(
          `case core::compiled::SystemLayoutRole::${enumName}:\\s*return RuntimeLayoutBuiltinDocument::${enumName};`,
        ),
      );
      expect(reference.roles[role].builtinFallback).toBe(true);
      const runtimeUrl = reference.roles[role].authoringUrl.replace('system|/', 'system:/');
      expect(runtimeSources).toContain(`"${runtimeUrl}"`);
    }
    expect(engine).toMatch(
      /case core::compiled::SystemLayoutRole::DebugOverlay:\s*return std::nullopt;/,
    );
    expect(reference.roles['debug-overlay']).toEqual({
      builtinFallback: false,
      document: null,
      authoringUrl: null,
      supportingFiles: [],
    });

    expect(documentRegistry).toContain(
      'constexpr char kRmlUiHtml4BaselineAsset[] = "system:/ui/baseline/rmlui-html4.rcss";',
    );
    expect(documentRegistry).toContain(
      'constexpr char kNovelTeaBaselineAsset[] = "system:/ui/baseline/noveltea.rcss";',
    );
    expect(documentRegistry).toMatch(
      /rmlui_html4->CombineStyleSheetContainer\(\*noveltea\)[\s\S]*MergeStyleSheetContainer\(\*document_styles\)/,
    );
    expect(reference.baselines).toEqual({
      implicit: true,
      appliesTo: [
        'built-in-system-layouts',
        'project-layouts',
        'fragments',
        'focused-previews',
        'runtime-ui-utility-documents',
      ],
      cascade: [
        {
          id: 'rmlui-html4',
          path: 'ui/baseline/rmlui-html4.rcss',
          authoringUrl: 'system|/ui/baseline/rmlui-html4.rcss',
        },
        {
          id: 'noveltea',
          path: 'ui/baseline/noveltea.rcss',
          authoringUrl: 'system|/ui/baseline/noveltea.rcss',
        },
        { id: 'template-rcss' },
        { id: 'document-rcss' },
      ],
    });
    expect(payload.files['system-layouts/ui/baseline/rmlui-html4.rcss']).toBe(
      readFileSync('../engine/assets/system/ui/baseline/rmlui-html4.rcss', 'utf8'),
    );
    expect(payload.files['system-layouts/ui/baseline/noveltea.rcss']).toBe(
      readFileSync('../engine/assets/system/ui/baseline/noveltea.rcss', 'utf8'),
    );

    expect(Object.keys(loadAgentKitSystemLayoutSourceFiles())).toEqual([
      'ui/baseline/noveltea.rcss',
      'ui/baseline/rmlui-html4.rcss',
      'ui/menu/load-menu.rml',
      'ui/menu/modal.rml',
      'ui/menu/pause-menu.rcss',
      'ui/menu/pause-menu.rml',
      'ui/menu/save-menu.rml',
      'ui/menu/settings-menu.rml',
      'ui/menu/system-menu.rcss',
      'ui/menu/text-log.rml',
      'ui/runtime/runtime_game.rcss',
      'ui/runtime/runtime_game.rml',
      'ui/title/default-title.rcss',
      'ui/title/default-title.rml',
    ]);
  });

  it('certifies the RCSS reference against the pinned NovelTea RmlUi profile', () => {
    const cmake = readFileSync('../cmake/NovelTeaRmlUi.cmake', 'utf8');
    const readCmakeString = (name: string) => {
      const match = cmake.match(new RegExp(`set\\(${name} "([^"]+)"\\)`));
      expect(match, `Missing ${name} in NovelTeaRmlUi.cmake`).not.toBeNull();
      return match![1];
    };

    const rmluiVersion = readCmakeString('NOVELTEA_RMLUI_VERSION');
    const rmluiCommit = readCmakeString('NOVELTEA_RMLUI_GIT_COMMIT');
    const patchRevision = readCmakeString('NOVELTEA_RMLUI_PATCH_REVISION');
    expect(cmake).toContain('set(RMLUI_MATH_EXPRESSIONS ON CACHE BOOL "" FORCE)');

    const payload = createNovelTeaAgentKitPayload();
    const manifest = JSON.parse(payload.manifestText);
    expect(manifest.provenance.sources.rmlui).toMatchObject({
      version: rmluiVersion,
      revision: rmluiCommit,
    });
    const reference = payload.files['docs/RCSS_REFERENCE.md']!;
    expect(reference).toContain(`RmlUi version label: \`${rmluiVersion}\``);
    expect(reference).toContain(`pinned RmlUi commit: \`${rmluiCommit}\``);
    expect(reference).toContain(`NovelTea RmlUi patch revision: \`${patchRevision}\``);
    expect(reference).toContain('`RMLUI_MATH_EXPRESSIONS`: enabled');
  });

  it('certifies the NovelTea data-binding model, callbacks, and custom-element surface', () => {
    const runtimeModel = readFileSync('../engine/src/ui/rmlui/runtime_ui_data_model.cpp', 'utf8');
    const callbackNames = [...runtimeModel.matchAll(/BindEventCallback\(\s*"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(callbackNames).toEqual([
      'ui_continue',
      'ui_choose',
      'ui_navigate_room',
      'ui_toggle_subject',
      'ui_clear_selection',
      'ui_invoke_interaction',
      'shell_start',
      'shell_pause',
      'shell_resume',
      'shell_open_settings',
      'shell_open_save',
      'shell_open_load',
      'shell_open_text_log',
      'shell_open_debug',
      'shell_close',
      'shell_return_to_title',
      'shell_quit',
      'shell_save_slot',
      'shell_load_slot',
      'shell_set_ui_scale',
      'shell_set_text_scale',
      'shell_confirm',
      'shell_cancel',
    ]);

    const topLevelVariables = [...runtimeModel.matchAll(/constructor\.Bind\("([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(topLevelVariables).toEqual(['project', 'gameplay', 'shell']);

    const registeredMembers: Record<string, string[]> = {};
    for (const match of runtimeModel.matchAll(/NT_MEMBER\(([^,]+),\s*([^)]+)\)/g)) {
      const type = match[1]!.trim();
      const member = match[2]!.trim();
      if (type === 'TYPE' && member === 'NAME') continue;
      const members = (registeredMembers[type] ??= []);
      if (!members.includes(member)) members.push(member);
    }
    expect(registeredMembers).toEqual({
      ChoiceProjection: ['kind', 'id', 'label', 'enabled'],
      ActorProjection: [
        'character_id',
        'instance_id',
        'pose_id',
        'expression_id',
        'presentation_complete',
      ],
      ExitProjection: ['id', 'target_id', 'direction', 'label', 'enabled', 'glyph'],
      ObjectProjection: ['subject_kind', 'subject_id', 'label', 'enabled', 'selected'],
      InventoryItemProjection: ['id', 'display_name', 'enabled', 'selected'],
      ActionProjection: ['verb_id', 'label', 'arity', 'quick_action', 'enabled'],
      TextLogEntryProjection: ['sequence', 'kind', 'has_speaker', 'speaker_id', 'text', 'body_rml'],
      RoomProjection: ['available', 'has_enabled_exits', 'exits', 'objects'],
      InventoryProjection: ['items'],
      InteractionProjection: ['has_selection', 'actions'],
      TextLogProjection: ['entries'],
      GameplayProjection: [
        'available',
        'mode',
        'title',
        'notification',
        'can_continue',
        'active_text_available',
        'choices',
        'actors',
        'room',
        'inventory',
        'interaction',
        'text_log',
      ],
      ProjectProjection: ['title', 'subtitle', 'start_label'],
      ScaleProjection: ['enabled', 'value', 'minimum', 'default_value', 'maximum'],
      SettingsProjection: ['ui_scale', 'text_scale'],
      CheckpointProjection: [
        'available',
        'ready',
        'retained',
        'retained_revision',
        'replay_structural_generations',
        'replay_time_generations',
        'replay_play_time_ms',
        'thumbnail_available',
        'thumbnail_capture_pending',
        'summary',
      ],
      SaveSlotProjection: [
        'kind',
        'number',
        'label',
        'occupied',
        'has_metadata',
        'play_time_ms',
        'project_version',
        'detail',
        'thumbnail_available',
        'thumbnail_url',
      ],
      ConfirmationProjection: ['active', 'prompt'],
      ShellProjection: [
        'available',
        'screen',
        'game_active',
        'status',
        'settings',
        'checkpoint',
        'save_slots',
        'confirmation',
      ],
    });

    const componentSource = readFileSync(
      '../engine/src/ui/rmlui/rmlui_custom_components.cpp',
      'utf8',
    );
    const customTags = [...componentSource.matchAll(/RegisterElementInstancer\("([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(customTags).toEqual(['nt-active-text', 'nt-map-view']);

    const payload = createNovelTeaAgentKitPayload();
    const bindingGuide = payload.files['docs/RMLUI_DATA_BINDING.md']!;
    for (const variable of topLevelVariables) expect(bindingGuide).toContain(`### \`${variable}\``);
    for (const callback of callbackNames) expect(bindingGuide).toContain(`${callback}(`);

    const componentGuide = payload.files['docs/RMLUI_CUSTOM_COMPONENTS.md']!;
    for (const tag of customTags) expect(componentGuide).toContain(`\`${tag}\``);
    expect(componentGuide).toContain('There is no current `nt-text-log` element');
  });

  it('certifies the Lua guide against the exact sandbox and authored binding surface', () => {
    const cmake = readFileSync('../cmake/NovelTeaLua.cmake', 'utf8');
    const archive = cmake.match(/URL https:\/\/www\.lua\.org\/ftp\/lua-([0-9.]+)\.tar\.gz/);
    const archiveHash = cmake.match(/URL_HASH SHA256=([a-f0-9]+)/);
    expect(archive?.[1]).toBe('5.5.0');
    expect(archiveHash?.[1]).toBe(
      '57ccc32bbbd005cab75bcc52444052535af691789dba2b9016d5c50640d68b3d',
    );
    expect(cmake).toContain('if(NOT LUA_VERSION_STRING VERSION_EQUAL "5.5.0")');

    const scriptRuntime = readFileSync('../engine/src/script/lua/script_runtime.cpp', 'utf8');
    const openLibraries = scriptRuntime.match(/open_libraries\(([\s\S]*?)\);/);
    expect(openLibraries).not.toBeNull();
    const libraryNames = [...openLibraries![1].matchAll(/sol::lib::([a-z0-9_]+)/g)].map(
      (match) => match[1],
    );
    expect(libraryNames).toEqual(['base', 'coroutine', 'table', 'string', 'math', 'utf8']);
    const excludedGlobals = [
      ...scriptRuntime.matchAll(/m_impl->lua\["([^"]+)"\] = sol::lua_nil;/g),
    ].map((match) => match[1]);
    expect(excludedGlobals).toEqual([
      'os',
      'io',
      'debug',
      'package',
      'require',
      'dofile',
      'loadfile',
    ]);

    const bindNovelTea = readFileSync('../engine/src/script/lua/bind_noveltea.cpp', 'utf8');
    const typedBindings = readFileSync(
      '../engine/src/script/lua/bind_typed_script_host.cpp',
      'utf8',
    );
    const capabilityBindings = readFileSync(
      '../engine/src/script/lua/bind_runtime_capabilities.cpp',
      'utf8',
    );
    const gameplayUiBindings = readFileSync(
      '../engine/src/ui/rmlui/runtime_ui_action_gateway.cpp',
      'utf8',
    );
    const shellUiBindings = readFileSync('../engine/src/ui/rmlui/runtime_ui.cpp', 'utf8');
    const capabilityProfiles = readFileSync(
      '../engine/include/noveltea/runtime/runtime_capabilities.hpp',
      'utf8',
    );
    const setFunctions = (source: string, object: string) =>
      [
        ...source.matchAll(
          new RegExp(`(?:^|[^A-Za-z0-9_])${object}\\.set_function\\(\\s*"([^"]+)"`, 'g'),
        ),
      ].map((match) => match[1]);

    const payload = createNovelTeaAgentKitPayload();
    const guide = payload.files['docs/LUA.md']!;
    expect(guide).toContain('Lua 5.5.0 exactly');
    for (const library of libraryNames) expect(guide).toContain(`\n${library}\n`);
    for (const excluded of excludedGlobals) expect(guide).toContain(excluded);

    const groups = [
      [bindNovelTea, 'noveltea', 'noveltea', 4],
      [typedBindings, 'noveltea', 'noveltea', 1],
      [typedBindings, 'game_properties', 'Game', 3],
      [typedBindings, 'properties', 'noveltea.properties', 3],
      [typedBindings, 'interactables', 'noveltea.interactables', 4],
      [typedBindings, 'navigation', 'noveltea.navigation', 1],
      [typedBindings, 'flow', 'noveltea.flow', 9],
      [typedBindings, 'game', 'Game', 10],
      [capabilityBindings, 'room_presentation', 'noveltea.room_presentation', 2],
      [capabilityBindings, 'random', 'noveltea.random', 3],
      [capabilityBindings, 'map', 'noveltea.map', 5],
      [capabilityBindings, 'layouts', 'noveltea.layouts', 6],
      [capabilityBindings, 'presentation', 'noveltea.presentation', 13],
      [capabilityBindings, 'text_log', 'noveltea.text_log', 2],
      [capabilityBindings, 'game', 'Game', 3],
      [gameplayUiBindings, 'ui', 'Game.ui', 10],
      [shellUiBindings, 'shell', 'Game.shell', 24],
      [shellUiBindings, 'game', 'Game', 1],
    ] as const;
    for (const [source, object, prefix, expectedCount] of groups) {
      const functions = setFunctions(source, object);
      expect(functions).toHaveLength(expectedCount);
      for (const name of functions) expect(guide).toContain(`${prefix}.${name}`);
    }

    const projectReaders = [
      ...typedBindings.matchAll(/bind_definition_reader\(project,\s*"([^"]+)"/g),
    ].map((match) => match[1]);
    expect(projectReaders).toEqual([
      'room',
      'scene',
      'dialogue',
      'character',
      'interactable',
      'verb',
      'interaction',
      'map',
    ]);
    for (const name of projectReaders) expect(guide).toContain(`noveltea.project.${name}`);

    const audioFunctions = setFunctions(capabilityBindings, 'audio');
    expect(audioFunctions).toEqual([
      '_play',
      'play_ui',
      '_stop',
      'set_loop',
      'set_music',
      'clear_loop',
      'clear_bus',
      'state',
    ]);
    for (const name of audioFunctions.filter((name) => !name.startsWith('_')))
      expect(guide).toContain(`audio.${name}`);
    for (const wrapper of ['play', 'stop', 'play_and_wait', 'stop_and_wait']) {
      expect(capabilityBindings).toContain(`audio.${wrapper} = function`);
      expect(guide).toContain(`audio.${wrapper}`);
    }
    expect(guide).toContain('audio._play');
    expect(guide).toContain('audio._stop');
    expect(guide).toContain('implementation details');

    expect(capabilityProfiles).toMatch(
      /case RuntimeCapabilityProfile::GameplayScript:\s*return \{profile, all_gameplay_queries, gameplay_commands, true, false\};/,
    );
    expect(capabilityProfiles).toMatch(
      /case RuntimeCapabilityProfile::SynchronousExpression:\s*return \{profile, expression_queries, 0, false, false\};/,
    );
    expect(capabilityProfiles).toMatch(
      /case RuntimeCapabilityProfile::RoomComposition:\s*return \{profile, expression_queries, 0, false, true\};/,
    );
    expect(capabilityProfiles).toMatch(
      /case RuntimeCapabilityProfile::GameplayLayoutEvent:\s*return \{profile, all_gameplay_queries, gameplay_commands, false, false\};/,
    );
    expect(capabilityProfiles).toMatch(
      /case RuntimeCapabilityProfile::ShellLayoutEvent:\s*return \{profile, capability_bit\(G::Save\) \| capability_bit\(G::Game\),\s*capability_bit\(G::Save\) \| capability_bit\(G::Game\), false, false\};/,
    );
    for (const profile of [
      'Gameplay Script',
      'Synchronous expression',
      'Room composition',
      'Gameplay Layout event',
      'Shell Layout event',
    ])
      expect(guide).toContain(profile);

    const manifest = JSON.parse(payload.manifestText);
    const provenanceAreas = manifest.provenance.documents['docs/LUA.md'].sources.flatMap(
      (source: { areas: string[] }) => source.areas,
    );
    expect(provenanceAreas).toContain(
      'cmake/NovelTeaLua.cmake (Lua 5.5.0 archive SHA256 57ccc32bbbd005cab75bcc52444052535af691789dba2b9016d5c50640d68b3d)',
    );
  });

  it('certifies the RmlUi Lua guide against Layout script gating and integration ownership', () => {
    const layoutRealizer = readFileSync('../engine/src/host/layout_realizer.cpp', 'utf8');
    expect(layoutRealizer).toContain(
      'definition->script_enabled ? "<script>" + *lua.value_if() + "</script>"',
    );
    expect(layoutRealizer).toContain(
      'if (layout.script_enabled && layout.contains_dedicated_lua_source)',
    );

    const layoutSchema = readFileSync(
      '../editor/src/shared/project-schema/authoring-layouts.ts',
      'utf8',
    );
    expect(layoutSchema).toContain('enabled: z.boolean().default(true)');
    expect(layoutSchema).toContain('Lua namespace must be a dot-separated Lua identifier path.');

    const sourceAnalysis = readFileSync(
      '../editor/src/shared/authoring-source-analysis.ts',
      'utf8',
    );
    expect(sourceAnalysis).toContain("reference.kind === 'script'");
    expect(sourceAnalysis).toContain('does not resolve to exactly one declared dependency.');

    const listenerPatch = readFileSync(
      '../cmake/patches/rmlui-feature-calc-noveltea-lua-listener-lifetime.patch',
      'utf8',
    );
    expect(listenerPatch).toContain('LuaType<Event>::push(L, &event, false);');
    expect(listenerPatch).toContain('LuaType<Element>::push(L, attached, false);');

    const payload = createNovelTeaAgentKitPayload();
    const guide = payload.files['docs/RMLUI_LUA.md']!;
    expect(guide).toContain('function(event, element, document)');
    expect(guide).toContain('controls **only the dedicated Layout Lua source**');
    expect(guide).toContain('It is **not** a document-wide scripting switch');
    expect(guide).toContain(
      'GetElementsByTagName` and `QuerySelectorAll` return ordinary 1-based Lua tables',
    );
    expect(guide).toContain('Gameplay Layout events are non-yielding');
    for (const hostOwned of [
      'rmlui:CreateContext',
      'rmlui:LoadFontFace',
      'rmlui:RegisterTag',
      'Context:LoadDocument',
      'Context:Update',
      'Context:Render',
      'Context:OpenDataModel',
    ])
      expect(guide).toContain(hostOwned);

    const manifest = JSON.parse(payload.manifestText);
    const provenance = manifest.provenance.documents['docs/RMLUI_LUA.md'];
    expect(provenance.sources.map((source: { source: string }) => source.source)).toEqual([
      'noveltea',
      'rmlui',
      'lua-5.5-manual',
    ]);
    const rmluiAreas = provenance.sources.find(
      (source: { source: string }) => source.source === 'rmlui',
    ).areas;
    expect(rmluiAreas).toEqual(
      expect.arrayContaining([
        'Source/Lua/LuaEventListener.cpp',
        'Source/Lua/LuaDocument.cpp',
        'Source/Lua/Element.cpp',
        'Source/Lua/Event.cpp',
        'Source/Lua/Document.cpp',
        'Source/Lua/Context.cpp',
        'Source/Lua/RmlUi.cpp',
      ]),
    );
    const novelTeaAreas = provenance.sources.find(
      (source: { source: string }) => source.source === 'noveltea',
    ).areas;
    expect(novelTeaAreas).toEqual(
      expect.arrayContaining(['cmake/NovelTeaRmlUi.cmake', 'cmake/NovelTeaLua.cmake']),
    );
  });

  it('rejects incomplete or dangling curated agent-kit provenance', () => {
    const sourceFiles = { 'GUIDE.md': '# Guide\n' };
    expect(() =>
      createNovelTeaAgentKitPayload(sourceFiles, {
        sources: {
          noveltea: {
            kind: 'repository',
            repository: 'https://github.com/Cruel/nt.git',
            revision: 'abc123',
          },
        },
        documents: {},
      }),
    ).toThrow('must declare exactly one entry');

    expect(() =>
      createNovelTeaAgentKitPayload(sourceFiles, {
        sources: {},
        documents: {
          'GUIDE.md': {
            reviewed: '2026-08-16',
            strategy: 'Use the public authoring contract.',
            sources: [{ source: 'noveltea', areas: ['docs/editor/AGENT_KIT.md'] }],
          },
        },
      }),
    ).toThrow("references unknown source 'noveltea'");
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
    expect(await value.fileSystem.readText(`${root}/.gitignore`)).toBe('/.noveltea/\n/dist/\n');
    const manifestBefore = await value.fileSystem.readText(`${root}/.noveltea/agent/manifest.json`);
    expect(JSON.parse(manifestBefore).provenance.documents['docs/LAYOUTS.md']).toMatchObject({
      reviewed: '2026-08-16',
    });
    const systemLayoutSources = loadAgentKitSystemLayoutSourceFiles();
    expect(
      await value.fileSystem.readText(
        `${root}/.noveltea/agent/system-layouts/ui/runtime/runtime_game.rml`,
      ),
    ).toBe(systemLayoutSources['ui/runtime/runtime_game.rml']);
    expect(
      await value.fileSystem.readText(
        `${root}/.noveltea/agent/system-layouts/ui/baseline/rmlui-html4.rcss`,
      ),
    ).toBe(systemLayoutSources['ui/baseline/rmlui-html4.rcss']);
    const systemLayoutManifest = JSON.parse(
      await value.fileSystem.readText(`${root}/.noveltea/agent/system-layouts/manifest.json`),
    );
    expect(systemLayoutManifest.roles['game-hud']).toMatchObject({
      builtinFallback: true,
      authoringUrl: 'system|/ui/runtime/runtime_game.rml',
    });
    expect(systemLayoutManifest.baselines).toMatchObject({
      implicit: true,
      cascade: [
        expect.objectContaining({ id: 'rmlui-html4' }),
        expect.objectContaining({ id: 'noveltea' }),
        { id: 'template-rcss' },
        { id: 'document-rcss' },
      ],
    });
    expect(
      await value.fileSystem.inspect(`${root}/.noveltea/agent/agent-kit-provenance.json`),
    ).toBe('missing');
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

  it('preserves an existing gitignore and warns when either required rule is missing', async () => {
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
    const missingDist = await runNovelTeaCli(['--json', 'agent', 'sync'], options(value));
    expect(JSON.parse(missingDist.stdout).agentGitignoreStatus).toBe('missing-rule');
    expect(JSON.parse(missingDist.stdout).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'AGENT_LOCAL_STATE_NOT_IGNORED' })]),
    );

    await value.fileSystem.writeTextAtomic(
      `${root}/.gitignore`,
      '# custom .noveltea handling\ndist/\n',
    );
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
    expect(JSON.parse(await value.fileSystem.readText(manifestPath)).schemaVersion).toBe(2);
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
