import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { runNovelTeaCli } from '../../cli/application';
import {
  createNovelTeaAgentKitPayload,
  createNovelTeaRawSchemaFiles,
  createNovelTeaWebsiteSchemaReference,
} from '../../cli/agent-kit';
import {
  loadAgentKitSourceFiles,
  loadAgentKitSystemLayoutSourceFiles,
} from '../../cli/agent-kit/source';
import { syncNovelTeaAgentKit } from '../../cli/agent-sync';
import {
  configureImageInspectionService,
  resetImageInspectionService,
} from '../../main/services/image-inspection-service';
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
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultVerbData } from '../../shared/project-schema/authoring-verbs';
import { defaultTestData, defaultTestStep } from '../../shared/project-schema/authoring-tests';
import {
  createLocalizationTranslation,
  localizationMessageWorkflowView,
} from '../../shared/authoring-localization-workflow';
import { synchronizeLocalizationMessageTracking } from '../../shared/authoring-localization-sync';
import { namedMessageUsages } from '../../shared/authoring-named-message-usages';
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
  ResidentProjectWorkspaceService,
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

function fixture(project: AuthoringProject = validProject(), pathMetadata = false) {
  const files = Object.fromEntries(
    Object.entries(projectWorkspaceFiles(project, project.editor)).map(([file, text]) => [
      `${root}/${file}`,
      text,
    ]),
  );
  const fileSystem = new InMemoryProjectWorkspaceFileSystem(files, { pathMetadata });
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
  it('joins localization work queues and keeps accept independent from human review', async () => {
    const project = validProject();
    const messageId = '018f4f8c-9b5d-7ae2-9b36-4c8af613f099';
    project.localization.locales.fr = { supported: false, parentLocale: null, fontStack: null };
    project.localization.messages[messageId] = {
      kind: 'named',
      key: 'ui.greeting',
      source: 'Hello',
      context: 'Greeting',
    };
    const initialView = localizationMessageWorkflowView(project, messageId)!;
    project.localization.translations.fr = {
      [messageId]: createLocalizationTranslation(initialView, 'Bonjour', 'ai', {
        provider: 'OpenAI',
        model: 'test-model',
      }),
    };
    project.localization.messages[messageId]!.source = 'Hello there';
    const value = fixture(project);

    const outdated = await runNovelTeaCli(
      ['--json', 'localization', 'view', 'fr', '--status', 'outdated'],
      options(value),
    );
    expect(outdated.exitCode).toBe(0);
    expect(JSON.parse(outdated.stdout)).toMatchObject({
      locale: 'fr',
      statusFilter: 'outdated',
      messages: [
        {
          id: messageId,
          status: 'outdated',
          context: 'Greeting',
          target: {
            text: 'Bonjour',
            origin: 'ai',
            review: 'needs-review',
            provider: 'OpenAI',
            model: 'test-model',
          },
        },
      ],
    });

    const blockedReview = await runNovelTeaCli(
      ['--json', 'localization', 'review', 'fr', messageId],
      options(value),
    );
    expect(blockedReview.exitCode).toBe(4);
    expect(JSON.parse(blockedReview.stdout).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'localization.review.outdated' }),
    );

    const accepted = await runNovelTeaCli(
      ['--json', 'localization', 'accept', 'fr', messageId],
      options(value),
    );
    expect(accepted.exitCode).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({ writes: ['i18n/locales/fr.json'] });

    const reviewed = await runNovelTeaCli(
      ['--json', 'localization', 'review', 'fr', messageId],
      options(value),
    );
    expect(reviewed.exitCode).toBe(0);
    const current = await runNovelTeaCli(
      ['--json', 'localization', 'view', 'fr', '--status', 'reviewed'],
      options(value),
    );
    expect(JSON.parse(current.stdout)).toMatchObject({
      messages: [
        {
          id: messageId,
          status: 'current',
          target: { text: 'Bonjour', origin: 'ai', review: 'reviewed' },
        },
      ],
    });
  });

  it('reports occurrence-specific Usage notes for named Messages', async () => {
    const project = validProject();
    const messageId = '018f4f8c-9b5d-7ae2-9b36-4c8af613f096';
    project.localization.locales.fr = { supported: false, parentLocale: null, fontStack: null };
    project.localization.messages[messageId] = {
      kind: 'named',
      key: 'ui.shared',
      source: 'Shared',
    };
    project.rooms.second = createDefaultAuthoringRecord(
      'rooms',
      'second',
    ) as typeof project.rooms.second;
    project.rooms.start!.data.description = {
      markup: 'plain',
      source: { kind: 'localized', key: 'ui.shared' },
    };
    project.rooms.second!.data.description = {
      markup: 'plain',
      source: { kind: 'localized', key: 'ui.shared' },
    };
    const usages = namedMessageUsages(project, messageId);
    expect(usages).toHaveLength(2);
    project.localization.usageNotes[usages[0]!.id] = 'First usage note';
    project.localization.usageNotes[usages[1]!.id] = 'Second usage note';
    const value = fixture(project);

    const result = await runNovelTeaCli(['--json', 'localization', 'view', 'fr'], options(value));
    expect(result.exitCode).toBe(0);
    const message = JSON.parse(result.stdout).messages.find(
      (candidate: { id: string }) => candidate.id === messageId,
    );
    expect(message.usageNotes).toEqual([
      { usageId: usages[0]!.id, path: usages[0]!.path, note: 'First usage note' },
      { usageId: usages[1]!.id, path: usages[1]!.path, note: 'Second usage note' },
    ]);
  });

  it('rejects a mixed bulk review atomically when any selected target is Missing', async () => {
    const project = validProject();
    project.localization.locales.fr = { supported: false, parentLocale: null, fontStack: null };
    const currentId = '018f4f8c-9b5d-7ae2-9b36-4c8af613f097';
    const missingId = '018f4f8c-9b5d-7ae2-9b36-4c8af613f098';
    project.localization.messages[currentId] = {
      kind: 'named',
      key: 'ui.current',
      source: 'Current',
    };
    project.localization.messages[missingId] = {
      kind: 'named',
      key: 'ui.missing',
      source: 'Missing',
    };
    const currentView = localizationMessageWorkflowView(project, currentId)!;
    project.localization.translations.fr = {
      [currentId]: createLocalizationTranslation(currentView, 'Actuel'),
    };
    const value = fixture(project);
    const before = await value.fileSystem.readText(`${root}/i18n/locales/fr.json`);

    const result = await runNovelTeaCli(
      ['--json', 'localization', 'review', 'fr', currentId, missingId],
      options(value),
    );

    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stdout).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'localization.workflow.missing' }),
    );
    expect(await value.fileSystem.readText(`${root}/i18n/locales/fr.json`)).toBe(before);
  });

  it('refuses human review for structurally invalid target content', async () => {
    const project = validProject();
    project.localization.locales.fr = { supported: false, parentLocale: null, fontStack: null };
    const messageId = '018f4f8c-9b5d-7ae2-9b36-4c8af613f096';
    project.localization.messages[messageId] = {
      kind: 'named',
      key: 'verb.use.command',
      source: 'Use {target}',
      arguments: { target: 'printable' },
    };
    const verb = defaultVerbData('Use');
    verb.slots = [
      {
        id: 'target',
        label: { source: { kind: 'inline', text: 'Target' }, markup: 'plain' },
        prompt: { source: { kind: 'inline', text: 'Choose target' }, markup: 'plain' },
        selectors: [{ kind: 'any-subject' }],
      },
    ];
    verb.bindingOrder = ['target'];
    verb.completedCommandText = {
      source: { kind: 'localized', key: 'verb.use.command' },
      markup: 'plain',
    };
    project.verbs.use = { id: 'use', label: 'Use', data: verb };
    const view = localizationMessageWorkflowView(project, messageId)!;
    project.localization.translations.fr = {
      [messageId]: createLocalizationTranslation(view, 'Utiliser {missing}'),
    };
    const value = fixture(project);

    const result = await runNovelTeaCli(
      ['--json', 'localization', 'review', 'fr', messageId],
      options(value),
    );

    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stdout).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'localization.review.invalid' }),
    );
  });

  it('uses resident Project generations across standalone read commands', async () => {
    const value = fixture(validProject(), true);
    const residentWorkspace = new ResidentProjectWorkspaceService(value.fileSystem);
    const instrumentation: Array<{
      sourceWork: { parsedJsonSources: number; wholeProjectSchemaParses: number };
    }> = [];
    const first = await runNovelTeaCli(['--json', 'validate'], {
      ...options(value),
      residentWorkspace,
      onAuthoringValidationInstrumentation: (entry) => instrumentation.push(entry),
    });
    expect(first.exitCode).toBe(0);

    const changed = structuredClone(value.project);
    changed.rooms.start.label = 'Changed Start';
    const changedFiles = projectWorkspaceFiles(changed, changed.editor);
    await value.fileSystem.writeTextAtomic(
      `${root}/records/rooms/start.json`,
      changedFiles['records/rooms/start.json']!,
    );
    const second = await runNovelTeaCli(['--json', 'validate'], {
      ...options(value),
      residentWorkspace,
      onAuthoringValidationInstrumentation: (entry) => instrumentation.push(entry),
    });
    expect(second.exitCode).toBe(0);
    expect(instrumentation.at(-1)?.sourceWork.parsedJsonSources).toBe(1);
    expect(instrumentation.at(-1)?.sourceWork.wholeProjectSchemaParses).toBe(0);
  });

  it('keeps localization discovery read-only until deterministic sync is requested', async () => {
    const project = validProject();
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: 'local greeting = Text.tr("Hello")\nreturn greeting\n',
    };
    const layout = defaultLayoutData('Localized HUD', 'document');
    layout.rml.sourceText = '<rml><body><nt-tr>Welcome</nt-tr></body></rml>';
    project.layouts.hud = { id: 'hud', label: 'Localized HUD', data: layout };
    const value = fixture(project);
    const localizationBefore = await value.fileSystem.readText(`${root}/i18n/tracking.json`);
    const scriptBefore = await value.fileSystem.readText(`${root}/scripts/bootstrap.lua`);
    const rmlBefore = await value.fileSystem.readText(`${root}/records/layouts/hud/layout.rml`);

    const validation = await runNovelTeaCli(['--json', 'validate'], options(value));
    expect(validation.exitCode).toBe(0);
    expect(await value.fileSystem.readText(`${root}/i18n/tracking.json`)).toBe(localizationBefore);

    const dryRun = await runNovelTeaCli(
      ['--json', 'localization', 'sync', '--dry-run'],
      options(value),
    );
    expect(dryRun.exitCode).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({ changed: true, writes: [] });
    expect(await value.fileSystem.readText(`${root}/i18n/tracking.json`)).toBe(localizationBefore);

    const synchronized = await runNovelTeaCli(['--json', 'localization', 'sync'], options(value));
    expect(synchronized.exitCode).toBe(0);
    expect(JSON.parse(synchronized.stdout)).toMatchObject({
      changed: true,
      materializedMessageIds: expect.any(Array),
      unresolved: [],
      writes: ['i18n/tracking.json'],
    });
    const tracking = JSON.parse(
      await value.fileSystem.readText(`${root}/i18n/tracking.json`),
    ) as Record<string, { family: string }>;
    expect(
      Object.values(tracking)
        .map((entry) => entry.family)
        .sort(),
    ).toEqual(['lua', 'rml']);
    expect(await value.fileSystem.readText(`${root}/scripts/bootstrap.lua`)).toBe(scriptBefore);
    expect(await value.fileSystem.readText(`${root}/records/layouts/hud/layout.rml`)).toBe(
      rmlBefore,
    );

    const repeated = await runNovelTeaCli(['--json', 'localization', 'sync'], options(value));
    expect(JSON.parse(repeated.stdout)).toMatchObject({ changed: false, writes: [] });
  });

  it('plans and applies ambiguous localization reconciliation through deterministic JSON', async () => {
    const project = validProject();
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: 'return Text.tr("Original", nil, { note = "Keep this" })\n',
    };
    const tracked = synchronizeLocalizationMessageTracking(project).project;
    const messageId = Object.values(tracked.localization.sourceMessageTracking)[0]!.occurrences[0]!
      .messageId;
    tracked.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
    const workflow = localizationMessageWorkflowView(tracked, messageId)!;
    tracked.localization.translations.fr = {
      [messageId]: createLocalizationTranslation(workflow, 'Original traduit', 'human', {
        review: 'reviewed',
      }),
    };
    tracked.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: [
        'local first = Text.tr("Original", nil, { note = "Keep this" })',
        'local second = Text.tr("Original", nil, { note = "Keep this" })',
        'return first .. second',
        '',
      ].join('\n'),
    };
    const value = fixture(tracked);

    const planned = await runNovelTeaCli(['--json', 'localization', 'reconcile'], options(value));
    expect(planned.exitCode).toBe(0);
    const envelope = JSON.parse(planned.stdout) as {
      plan: {
        expectedWorkspaceRevision: string;
        expectedFingerprint: string;
        groups: Array<{
          requiresDecision: boolean;
          currentOccurrences: Array<{ id: string }>;
        }>;
      };
    };
    expect(envelope.plan.groups).toHaveLength(1);
    expect(envelope.plan.groups[0]!.requiresDecision).toBe(true);
    const resolutions = Object.fromEntries(
      envelope.plan.groups[0]!.currentOccurrences.map((occurrence) => [occurrence.id, 'new']),
    );

    const applied = await runNovelTeaCli(['--json', 'localization', 'reconcile', '--apply'], {
      ...options(value),
      stdinText: JSON.stringify({
        expectedWorkspaceRevision: envelope.plan.expectedWorkspaceRevision,
        expectedFingerprint: envelope.plan.expectedFingerprint,
        resolutions,
      }),
    });
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      orphanedMessageIds: [messageId],
      materializedMessageIds: expect.any(Array),
      writes: ['i18n/locales/fr.json', 'i18n/orphans.json', 'i18n/tracking.json'],
    });
    await expect(value.fileSystem.readText(`${root}/i18n/locales/fr.json`)).rejects.toThrow(
      'ENOENT',
    );
    const orphans = JSON.parse(
      await value.fileSystem.readText(`${root}/i18n/orphans.json`),
    ) as Record<string, { translations: Record<string, unknown> }>;
    expect(orphans[messageId]?.translations).toHaveProperty('fr');
  });

  it('rejects a stale localization reconciliation plan before writing', async () => {
    const project = validProject();
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: 'return Text.tr("One")\n',
    };
    const tracked = synchronizeLocalizationMessageTracking(project).project;
    tracked.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: 'return Text.tr("Two") .. Text.tr("Three")\n',
    };
    const value = fixture(tracked);
    const planned = await runNovelTeaCli(['--json', 'localization', 'reconcile'], options(value));
    const envelope = JSON.parse(planned.stdout) as {
      plan: { expectedWorkspaceRevision: string; expectedFingerprint: string };
    };

    const stale = await runNovelTeaCli(['--json', 'localization', 'reconcile', '--apply'], {
      ...options(value),
      stdinText: JSON.stringify({
        expectedWorkspaceRevision: 'sha256:stale',
        expectedFingerprint: envelope.plan.expectedFingerprint,
        resolutions: {},
      }),
    });

    expect(stale.exitCode).not.toBe(0);
    expect(JSON.parse(stale.stdout).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'localization.reconcile.stale-plan' }),
    );
  });

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

  it('lists platform profiles without parsing unrelated authoring domains', async () => {
    const project = validProject();
    project.export.profiles = [defaultPlatformExportProfile('linux')];
    const value = fixture(project);
    const manifest = JSON.parse(await value.fileSystem.readText(`${root}/project.json`)) as Record<
      string,
      unknown
    >;
    manifest.settings = null;
    await value.fileSystem.writeTextAtomic(`${root}/project.json`, JSON.stringify(manifest));
    await value.fileSystem.writeTextAtomic(`${root}/records/dialogues/broken.json`, '{"id":');
    await value.fileSystem.writeTextAtomic(`${root}/traits.json`, '{"broken":');
    await value.fileSystem.writeTextAtomic(`${root}/i18n/project.json`, '{"sourceLocale":');

    const result = await runNovelTeaCli(
      ['--json', 'platform', 'profiles'],
      options(value, root, undefined, platformTools()),
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      profiles: [{ id: 'linux-release', target: 'linux', architecture: 'x64' }],
    });
  });

  it('preserves Project identity diagnostics during scoped platform profile preparation', async () => {
    const value = fixture();
    const manifest = JSON.parse(await value.fileSystem.readText(`${root}/project.json`)) as Record<
      string,
      unknown
    >;
    manifest.project = { ...(manifest.project as Record<string, unknown>), id: '' };
    await value.fileSystem.writeTextAtomic(`${root}/project.json`, JSON.stringify(manifest));

    const result = await runNovelTeaCli(
      ['--json', 'platform', 'profiles'],
      options(value, root, undefined, platformTools()),
    );

    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      exitCode: 3,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'WORKSPACE_SOURCE_READ',
          path: '/project/id',
          severity: 'error',
        }),
      ]),
    });
  });

  it('preserves export-profile semantic diagnostics during scoped platform profile preparation', async () => {
    const project = validProject();
    const profile = defaultPlatformExportProfile('linux');
    profile.assetMemory = { kind: 'policy', policyId: 'missing-policy' };
    project.export.profiles = [profile];
    const value = fixture(project);

    const result = await runNovelTeaCli(
      ['--json', 'platform', 'profiles'],
      options(value, root, undefined, platformTools()),
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      exitCode: 0,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'authoring.asset-memory-policy.reference.missing',
          path: '/export/profiles/0/assetMemory/policyId',
          severity: 'error',
        }),
      ]),
      profiles: [{ id: 'linux-release' }],
    });
  });

  it('preserves export-profile schema diagnostics during scoped platform profile preparation', async () => {
    const project = validProject();
    project.export.profiles = [defaultPlatformExportProfile('linux')];
    const value = fixture(project);
    const manifest = JSON.parse(await value.fileSystem.readText(`${root}/project.json`)) as Record<
      string,
      unknown
    >;
    const exportSettings = manifest.export as Record<string, unknown>;
    const runtime = exportSettings.runtime as Record<string, unknown>;
    runtime.id = '';
    const profiles = exportSettings.profiles as Array<Record<string, unknown>>;
    profiles[0] = { ...profiles[0], target: 'not-a-platform' };
    await value.fileSystem.writeTextAtomic(`${root}/project.json`, JSON.stringify(manifest));

    const result = await runNovelTeaCli(
      ['--json', 'platform', 'profiles'],
      options(value, root, undefined, platformTools()),
    );

    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      exitCode: 3,
      diagnostics: [
        expect.objectContaining({
          code: 'WORKSPACE_SOURCE_READ',
          path: '/export/profiles/0/target',
          severity: 'error',
        }),
        expect.objectContaining({
          code: 'WORKSPACE_SOURCE_READ',
          path: '/export/runtime/id',
          severity: 'error',
        }),
      ],
    });
  });

  it('preserves canonical ordering for multiple export semantic diagnostics', async () => {
    const project = validProject();
    project.export.assetMemoryPolicies = [
      {
        id: 'too-warm',
        label: 'Too warm',
        basePreset: 'low',
        overrides: { warmPreparedCpuBytes: 40 * 1024 * 1024 },
      },
    ];
    const profile = defaultPlatformExportProfile('linux');
    profile.assetMemory = { kind: 'policy', policyId: 'missing-policy' };
    project.export.profiles = [profile];
    const value = fixture(project);

    const result = await runNovelTeaCli(
      ['--json', 'platform', 'profiles'],
      options(value, root, undefined, platformTools()),
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).diagnostics).toEqual([
      expect.objectContaining({
        code: 'authoring.asset-memory-policy.reference.missing',
        path: '/export/profiles/0/assetMemory/policyId',
      }),
      expect.objectContaining({
        code: 'authoring.asset-memory-policy.warm.exceeds-total',
        path: '/export/assetMemoryPolicies/0/overrides/warmPreparedCpuBytes',
      }),
    ]);
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
    expect(help.stdout).toContain('--allow-localization-warnings');
    expect(help.stdout).toContain('--no-daemon');

    const noDaemonHelp = await runNovelTeaCli(['--no-daemon', '--help'], { cwd: '/missing' });
    expect(noDaemonHelp.exitCode).toBe(0);
    expect(noDaemonHelp.stdout).toBe(help.stdout);

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

  it('imports an external image into the project Asset directory', async () => {
    const value = fixture();
    const source = '/imports/Forest Hero.PNG';
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await value.fileSystem.writeBytesAtomic(source, bytes);
    configureImageInspectionService(async () => ({
      width: 640,
      height: 360,
      hasAlpha: true,
      orientation: 6,
    }));
    try {
      const result = await runNovelTeaCli(['--json', 'asset', 'import', source], options(value));

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        assets: [
          {
            assetId: 'forest-hero',
            projectRelativePath: 'assets/images/forest-hero.png',
            kind: 'image',
            width: 640,
            height: 360,
            hasAlpha: true,
            orientation: 6,
            alreadyImported: false,
          },
        ],
      });
      expect(await value.fileSystem.readBytes(`${root}/assets/images/forest-hero.png`)).toEqual(
        bytes,
      );
      const opened = await value.workspace.open(root);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(opened.snapshot.project.assets['forest-hero']?.data).toMatchObject({
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/forest-hero.png' },
        imageMetadata: { width: 640, height: 360, hasAlpha: true, orientation: 6 },
      });
    } finally {
      resetImageInspectionService();
    }
  });

  it('registers an existing Asset-directory image in place and is idempotent', async () => {
    const value = fixture();
    const source = `${root}/assets/backgrounds/moon.png`;
    await value.fileSystem.writeBytesAtomic(source, new Uint8Array([9, 8, 7]));
    configureImageInspectionService(async () => ({ width: 320, height: 200, hasAlpha: false }));
    try {
      const first = await runNovelTeaCli(
        ['--json', 'asset', 'import', 'assets/backgrounds/moon.png'],
        options(value),
      );
      expect(first.exitCode).toBe(0);
      expect(JSON.parse(first.stdout)).toMatchObject({
        assets: [
          {
            assetId: 'moon',
            projectRelativePath: 'assets/backgrounds/moon.png',
            alreadyImported: false,
          },
        ],
      });

      const second = await runNovelTeaCli(
        ['--json', 'asset', 'import', 'assets/backgrounds/moon.png'],
        options(value),
      );
      expect(second.exitCode).toBe(0);
      expect(JSON.parse(second.stdout)).toMatchObject({
        assets: [
          {
            assetId: 'moon',
            projectRelativePath: 'assets/backgrounds/moon.png',
            alreadyImported: true,
          },
        ],
      });
      const opened = await value.workspace.open(root);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(Object.keys(opened.snapshot.project.assets)).toEqual(['moon']);
    } finally {
      resetImageInspectionService();
    }
  });

  it('audits unregistered files under the Asset directory', async () => {
    const value = fixture();
    await value.fileSystem.writeTextAtomic(`${root}/assets/text/tracked.txt`, 'tracked');
    await value.fileSystem.writeTextAtomic(`${root}/assets/text/untracked.txt`, 'untracked');
    const imported = await runNovelTeaCli(
      ['--json', 'asset', 'import', 'assets/text/tracked.txt'],
      options(value),
    );
    expect(imported.exitCode).toBe(0);

    const audit = await runNovelTeaCli(['--json', 'asset', 'audit'], options(value));
    expect(audit.exitCode).toBe(0);
    expect(JSON.parse(audit.stdout)).toMatchObject({
      untrackedFiles: [{ projectRelativePath: 'assets/text/untracked.txt', kind: 'text' }],
    });
  });

  it('audits Assets without requiring unrelated authoring domains to parse', async () => {
    const value = fixture();
    await value.fileSystem.writeTextAtomic(`${root}/records/dialogues/broken.json`, '{"id":');
    await value.fileSystem.writeTextAtomic(`${root}/records/scenes/broken.json`, '{"id":');
    await value.fileSystem.writeTextAtomic(`${root}/records/layouts/broken/layout.json`, '{"id":');
    await value.fileSystem.writeTextAtomic(`${root}/i18n/project.json`, '{"sourceLocale":');
    await value.fileSystem.writeTextAtomic(`${root}/traits.json`, '{"broken":');
    await value.fileSystem.writeTextAtomic(`${root}/assets/text/untracked.txt`, 'untracked');

    const audit = await runNovelTeaCli(['--json', 'asset', 'audit'], options(value));

    expect(audit.exitCode).toBe(0);
    expect(JSON.parse(audit.stdout)).toMatchObject({
      untrackedFiles: [{ projectRelativePath: 'assets/text/untracked.txt', kind: 'text' }],
    });
  });

  it('keeps malformed Asset records inside the asset-audit validation boundary', async () => {
    const value = fixture();
    await value.fileSystem.writeTextAtomic(`${root}/records/assets/broken.json`, '{}');

    const audit = await runNovelTeaCli(['--json', 'asset', 'audit'], options(value));

    expect(audit.exitCode).not.toBe(0);
    expect(JSON.parse(audit.stdout)).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'WORKSPACE_RECORD_ID_PATH_MISMATCH',
          path: '/records/assets/broken.json',
          severity: 'error',
        }),
      ]),
    });
  });

  it('preserves field-specific Asset schema diagnostics during scoped audit preparation', async () => {
    const value = fixture();
    await value.fileSystem.writeTextAtomic(
      `${root}/records/assets/broken.json`,
      JSON.stringify({
        id: 'broken',
        label: 'Broken',
        data: {
          kind: 'not-an-asset-kind',
          source: { type: 'project-file', path: 'assets/text/broken.txt' },
          aliases: [],
          imageMetadata: null,
        },
      }),
    );

    const audit = await runNovelTeaCli(['--json', 'asset', 'audit'], options(value));

    expect(audit.exitCode).toBe(3);
    expect(JSON.parse(audit.stdout)).toMatchObject({
      exitCode: 3,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'WORKSPACE_SOURCE_READ',
          path: '/assets/broken/data/kind',
          severity: 'error',
        }),
      ]),
    });
  });

  it('rejects invalid declared Asset source routing inside the scoped boundary', async () => {
    const value = fixture();
    await value.fileSystem.writeTextAtomic(
      `${root}/records/assets/broken.json`,
      JSON.stringify({
        id: 'broken',
        label: 'Broken',
        data: {
          kind: 'text',
          source: { type: 'project-file', path: '../outside.txt' },
          aliases: [],
          imageMetadata: null,
        },
      }),
    );

    const audit = await runNovelTeaCli(['--json', 'asset', 'audit'], options(value));

    expect(audit.exitCode).not.toBe(0);
    expect(JSON.parse(audit.stdout)).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'WORKSPACE_PATH_INVALID',
          path: '/',
          severity: 'error',
        }),
      ]),
    });
  });

  it('preserves workspace containment diagnostics for the scoped Asset boundary', async () => {
    const value = fixture();
    const recordsRoot = `${root}/records`;
    const realpath = value.fileSystem.realpath.bind(value.fileSystem);
    const relativePath = value.fileSystem.relativePath.bind(value.fileSystem);
    value.fileSystem.realpath = async (pathValue: string) =>
      pathValue === recordsRoot ? '/outside/records' : realpath(pathValue);
    value.fileSystem.relativePath = (from: string, to: string) =>
      from === root && to === '/outside/records' ? '../outside/records' : relativePath(from, to);

    const audit = await runNovelTeaCli(['--json', 'asset', 'audit'], options(value));

    expect(audit.exitCode).toBe(3);
    expect(JSON.parse(audit.stdout)).toMatchObject({
      exitCode: 3,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'WORKSPACE_PATH_INVALID',
          path: '/records',
          severity: 'error',
        }),
      ]),
    });
  });

  it('rejects an assets root that resolves outside the Project', async () => {
    const value = fixture();
    value.fileSystem.relativePath = posix.relative;
    await value.fileSystem.writeTextAtomic(`${root}/assets/text/example.txt`, 'outside');
    const realpath = value.fileSystem.realpath.bind(value.fileSystem);
    value.fileSystem.realpath = async (pathValue: string) =>
      pathValue.startsWith(`${root}/assets`)
        ? pathValue.replace(root, '/outside')
        : realpath(pathValue);

    const audit = await runNovelTeaCli(['--json', 'asset', 'audit'], options(value));

    expect(audit.exitCode).toBe(4);
    expect(audit.envelope.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'asset.audit.path_escape', path: 'assets' }),
    );
  });

  it('checks declared Asset source containment outside the conventional assets tree', async () => {
    const value = fixture();
    value.fileSystem.relativePath = posix.relative;
    const source = `${root}/resources/example.txt`;
    await value.fileSystem.writeTextAtomic(source, 'text');
    await value.fileSystem.writeTextAtomic(
      `${root}/records/assets/example.json`,
      JSON.stringify({
        id: 'example',
        label: 'Example',
        data: {
          kind: 'text',
          source: { type: 'project-file', path: 'resources/example.txt' },
          aliases: [],
          imageMetadata: null,
        },
      }),
    );
    const contained = await runNovelTeaCli(['--json', 'asset', 'audit'], options(value));
    expect(contained.exitCode).toBe(0);

    const realpath = value.fileSystem.realpath.bind(value.fileSystem);
    value.fileSystem.realpath = async (pathValue: string) =>
      pathValue === source ? '/outside/example.txt' : realpath(pathValue);
    const escaped = await runNovelTeaCli(['--json', 'asset', 'audit'], options(value));

    expect(escaped.exitCode).toBe(4);
    expect(escaped.envelope.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'asset.audit.path_escape',
        path: 'resources/example.txt',
      }),
    );
  });

  it('rejects directory cycles during Asset inventory traversal', async () => {
    const value = fixture();
    value.fileSystem.relativePath = posix.relative;
    await value.fileSystem.writeTextAtomic(`${root}/assets/loop/example.txt`, 'text');
    const realpath = value.fileSystem.realpath.bind(value.fileSystem);
    value.fileSystem.realpath = async (pathValue: string) =>
      pathValue === `${root}/assets/loop` ? `${root}/assets` : realpath(pathValue);

    const audit = await runNovelTeaCli(['--json', 'asset', 'audit'], options(value));

    expect(audit.exitCode).toBe(4);
    expect(audit.envelope.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'asset.audit.path_cycle', path: 'assets/loop' }),
    );
  });

  it('reports an Asset-directory symlink escape as a semantic audit failure', async () => {
    const value = fixture();
    const escapedPath = `${root}/assets/text/escape.txt`;
    await value.fileSystem.writeTextAtomic(escapedPath, 'outside');
    const realpath = value.fileSystem.realpath.bind(value.fileSystem);
    value.fileSystem.realpath = async (pathValue: string) =>
      pathValue === escapedPath ? '/outside/escape.txt' : realpath(pathValue);

    const audit = await runNovelTeaCli(['--json', 'asset', 'audit'], options(value));
    expect(audit.exitCode).toBe(4);
    expect(JSON.parse(audit.stdout)).toMatchObject({
      exitCode: 4,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'asset.audit.path_escape',
          path: 'assets/text/escape.txt',
          severity: 'error',
        }),
      ]),
    });
  });

  it('reports a registered Asset symlink escape as the same semantic audit failure', async () => {
    const value = fixture();
    const escapedPath = `${root}/assets/text/escape.txt`;
    await value.fileSystem.writeTextAtomic(escapedPath, 'outside');
    await value.fileSystem.writeTextAtomic(
      `${root}/records/assets/escape.json`,
      JSON.stringify({
        id: 'escape',
        label: 'Escape',
        data: {
          kind: 'text',
          source: { type: 'project-file', path: 'assets/text/escape.txt' },
          aliases: [],
          imageMetadata: null,
        },
      }),
    );
    const realpath = value.fileSystem.realpath.bind(value.fileSystem);
    value.fileSystem.realpath = async (pathValue: string) =>
      pathValue === escapedPath ? '/outside/escape.txt' : realpath(pathValue);

    const audit = await runNovelTeaCli(['--json', 'asset', 'audit'], options(value));

    expect(audit.exitCode).toBe(4);
    expect(JSON.parse(audit.stdout)).toMatchObject({
      exitCode: 4,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'asset.audit.path_escape',
          path: 'assets/text/escape.txt',
          severity: 'error',
        }),
      ]),
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
      async validateFontCoverage() {
        return { ok: true, success: true, diagnostics: [] };
      },
      shaderc() {
        return 0;
      },
      texturec() {
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

  it('requires an explicit localization warning override for unattended Runtime Package export', async () => {
    const project = validProject();
    project.localization.locales.fr = {
      supported: true,
      parentLocale: null,
      fontStack: null,
    };
    project.export.runtime.localization = {
      locales: ['fr'],
      defaultLocale: 'fr',
      quality: 'release',
    };
    const value = fixture(project);
    let exports = 0;
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
        exports += 1;
        return { ok: true, success: true };
      },
      async validateFontCoverage() {
        return { ok: true, success: true, diagnostics: [] };
      },
      shaderc() {
        return 0;
      },
      texturec() {
        return 0;
      },
    };

    const blocked = await runNovelTeaCli(
      ['--json', 'package', 'export', '--output', 'dist/game.ntpkg'],
      options(value, root, nativeTools),
    );
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.stdout).toContain('localization.export.warning_override_required');
    expect(exports).toBe(0);

    const allowed = await runNovelTeaCli(
      [
        '--json',
        'package',
        'export',
        '--output',
        'dist/game.ntpkg',
        '--allow-localization-warnings',
      ],
      options(value, root, nativeTools),
    );
    expect(allowed.exitCode).toBe(0);
    expect(exports).toBe(1);
  });

  it('reads stdin only for exact test spec command paths and forwards UI project authority', async () => {
    const value = fixture();
    let reads = 0;
    let uiRequest: unknown;
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
      async runUiTest(request) {
        uiRequest = request;
        return { ok: true, success: true };
      },
      async exportPackage() {
        return { ok: true, success: true };
      },
      async validateFontCoverage() {
        return { ok: true, success: true, diagnostics: [] };
      },
      shaderc() {
        return 0;
      },
      texturec() {
        return 0;
      },
    };
    const runSpec = await runNovelTeaCli(['--json', 'test', 'run-spec'], {
      ...options(value, root, nativeTools),
      readStdinText() {
        reads += 1;
        return JSON.stringify({
          schema: 'noveltea.editor.playback',
          version: 1,
          id: 'stdin-test',
          steps: [],
          finalExpectations: [],
        });
      },
    });
    expect(runSpec.exitCode).toBe(0);
    expect(reads).toBe(1);

    const runUiSpec = await runNovelTeaCli(['--json', 'test', 'run-ui-spec'], {
      ...options(value, root, nativeTools),
      readStdinText() {
        reads += 1;
        return JSON.stringify({
          schema: 'noveltea.editor.playback',
          version: 1,
          id: 'stdin-ui-test',
          steps: [],
          finalExpectations: [],
        });
      },
    });
    expect(runUiSpec.exitCode).toBe(0);
    expect(reads).toBe(2);
    expect(uiRequest).toMatchObject({
      projectRoot: root,
      spec: { id: 'stdin-ui-test' },
    });
  });

  it('routes bare test run through the native suite operation with lowered catalog', async () => {
    const project = validProject();
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data: defaultTestData('Smoke') };
    const value = fixture(project);
    let suiteRequest: unknown;
    const nativeTools: NovelTeaCliNativeToolService = {
      async compileShaders() {
        return { ok: true, success: true, diagnostics: [], outputs: [] };
      },
      async runHeadlessTest() {
        throw new Error('single-test runner should not be used');
      },
      async runTestSuite(request) {
        suiteRequest = request;
        return {
          ok: true,
          success: true,
          report: {
            schema: 'noveltea.test-suite-report',
            counts: { total: 1, passed: 1, failed: 0, blocked: 0, error: 0 },
            entries: [
              {
                id: 'smoke',
                runner: 'runtime',
                status: 'passed',
                report: { schema: 'noveltea.editor.playback-report', passed: true },
              },
            ],
          },
        };
      },
      async runUiTest() {
        throw new Error('single UI runner should not be used');
      },
      async exportPackage() {
        return { ok: true, success: true };
      },
      async validateFontCoverage() {
        return { ok: true, success: true, diagnostics: [] };
      },
      shaderc() {
        return 0;
      },
      texturec() {
        return 0;
      },
    };

    const result = await runNovelTeaCli(
      ['--json', 'test', 'run'],
      options(value, root, nativeTools),
    );

    expect(result.exitCode).toBe(0);
    expect(result.envelope.native).toMatchObject({
      report: { counts: { total: 1, passed: 1, failed: 0, blocked: 0, error: 0 } },
    });
    expect(suiteRequest).toMatchObject({
      projectRoot: root,
      catalog: {
        schema: 'noveltea.runtime-test-catalog',
        entries: [{ id: 'smoke', status: 'runnable', runner: 'runtime' }],
      },
    });

    const human = await runNovelTeaCli(['test', 'run'], options(value, root, nativeTools));
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toBe('Test suite: 1 passed, 0 failed, 0 blocked, 0 errors.\n');
  });

  it('fails bare test run for failed/error entries but not blocked-only suites', async () => {
    const project = validProject();
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data: defaultTestData('Smoke') };
    const value = fixture(project);
    const baseTools: NovelTeaCliNativeToolService = {
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
      async validateFontCoverage() {
        return { ok: true, success: true, diagnostics: [] };
      },
      shaderc() {
        return 0;
      },
      texturec() {
        return 0;
      },
    };
    const report = (status: 'blocked' | 'failed' | 'error') => ({
      ok: true,
      success: status === 'blocked',
      report: {
        schema: 'noveltea.test-suite-report',
        counts: {
          total: 1,
          passed: 0,
          failed: status === 'failed' ? 1 : 0,
          blocked: status === 'blocked' ? 1 : 0,
          error: status === 'error' ? 1 : 0,
        },
        entries: [
          {
            id: 'smoke',
            runner: status === 'blocked' ? null : 'runtime',
            status,
            ...(status === 'blocked' || status === 'error'
              ? { diagnostics: [{ severity: 'error', path: '/tests/smoke', message: 'detail' }] }
              : { report: { passed: false } }),
          },
        ],
      },
    });

    const blocked = await runNovelTeaCli(
      ['--json', 'test', 'run'],
      options(value, root, {
        ...baseTools,
        async runTestSuite() {
          return report('blocked');
        },
      }),
    );
    expect(blocked.exitCode).toBe(0);
    expect(blocked.envelope.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'native.test.blocked', severity: 'warning' }),
    );

    for (const status of ['failed', 'error'] as const) {
      const result = await runNovelTeaCli(
        ['--json', 'test', 'run'],
        options(value, root, {
          ...baseTools,
          async runTestSuite() {
            return report(status);
          },
        }),
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.envelope.native).toMatchObject({ report: { entries: [{ status }] } });
      if (status === 'failed') {
        const human = await runNovelTeaCli(
          ['test', 'run'],
          options(value, root, {
            ...baseTools,
            async runTestSuite() {
              return report(status);
            },
          }),
        );
        expect(human.stderr).toContain('Test suite: 0 passed, 1 failed, 0 blocked, 0 errors.');
        expect(human.stderr).toContain("Test 'smoke' failed.");
      }
    }
  });

  it('routes authored selector-click tests through the UI runner with project authority', async () => {
    const project = validProject();
    const data = defaultTestData('UI smoke');
    data.steps = [
      {
        ...defaultTestStep('ui-click'),
        id: 'click-confirm',
        label: 'Click confirm',
        uiClick: { documentId: 'runtime_game', selector: '#confirm' },
      },
    ];
    project.tests.ui = { id: 'ui', label: 'UI smoke', data };
    const value = fixture(project);
    let semanticRuns = 0;
    let uiRequest: unknown;
    const nativeTools: NovelTeaCliNativeToolService = {
      async compileShaders() {
        return { ok: true, success: true, diagnostics: [], outputs: [] };
      },
      async runHeadlessTest() {
        semanticRuns += 1;
        return { ok: true, success: true };
      },
      async runUiTest(request) {
        uiRequest = request;
        return { ok: true, success: true };
      },
      async exportPackage() {
        return { ok: true, success: true };
      },
      async validateFontCoverage() {
        return { ok: true, success: true, diagnostics: [] };
      },
      shaderc() {
        return 0;
      },
      texturec() {
        return 0;
      },
    };

    const result = await runNovelTeaCli(
      ['--json', 'test', 'run', 'ui'],
      options(value, root, nativeTools),
    );

    expect(result.exitCode).toBe(0);
    expect(semanticRuns).toBe(0);
    expect(uiRequest).toMatchObject({
      projectRoot: root,
      spec: {
        id: 'ui',
        steps: [
          {
            input: { type: 'ui-click', documentId: 'runtime_game', selector: '#confirm' },
          },
        ],
      },
    });
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
    let receivedFontCoverage: unknown;
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
      async validateFontCoverage(request) {
        receivedFontCoverage = request;
        return { ok: true, success: true, diagnostics: [] };
      },
      shaderc() {
        return 0;
      },
      texturec() {
        return 0;
      },
    };
    const result = await runNovelTeaCli(['--json', 'validate'], options(value, root, nativeTools));
    expect(result.exitCode).toBe(0);
    expect(receivedFontCoverage).toMatchObject({
      projectRoot: root,
      locales: expect.arrayContaining([expect.objectContaining({ locale: 'en' })]),
    });
    expect(receivedOptions).toMatchObject({
      projectRoot: root,
      outputRoot: `${root}/.noveltea/build`,
      cacheRoot: `${root}/.noveltea/cache`,
      shaderVariants: ['glsl-330', 'essl-300', 'metal'],
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
        async validateFontCoverage() {
          return { ok: true, success: true, diagnostics: [] };
        },
        shaderc() {
          return 0;
        },
        texturec() {
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
      ['--json', 'entity', 'create', 'scripts', 'helper-module', '--dry-run'],
      options(value),
    );
    expect(script.exitCode).toBe(0);
    expect(JSON.parse(script.stdout).plan.writes).toEqual(
      expect.arrayContaining(['records/scripts/helper-module.json', 'scripts/helper-module.lua']),
    );
    expect(await value.fileSystem.inspect(`${root}/scripts/helper-module.lua`)).toBe('missing');
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

  it('exposes one reusable Node-reference runner covering every supported command path', async () => {
    expect(PHASE_SIX_NODE_REFERENCE_COMMANDS).toEqual([
      'validate',
      'localization sync',
      'localization reconcile',
      'localization view',
      'localization accept',
      'localization review',
      'entity create',
      'entity rename',
      'entity delete',
      'usages',
    ]);
    const commands: readonly string[][] = [
      ['--json', 'validate'],
      ['--json', 'localization', 'sync', '--dry-run'],
      ['--json', 'localization', 'reconcile'],
      ['--json', 'localization', 'view', 'fr'],
      [
        '--json',
        'localization',
        'accept',
        'fr',
        '11111111-1111-4111-8111-111111111111',
        '--dry-run',
      ],
      [
        '--json',
        'localization',
        'review',
        'fr',
        '11111111-1111-4111-8111-111111111111',
        '--dry-run',
      ],
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

  it('generates website reference metadata and raw schemas from the canonical agent-kit codecs', () => {
    const reference = createNovelTeaWebsiteSchemaReference();
    const rawSchemas = createNovelTeaRawSchemaFiles();

    expect(reference).toMatchObject({
      schema: 'noveltea.website.schema-reference',
      channel: 'dev',
      unreleased: true,
      projectWorkspaceVersion: 1,
    });
    expect(reference.documents.map((document) => document.id)).toEqual(
      expect.arrayContaining(['project', 'records/rooms', 'records/interactions']),
    );
    const project = reference.documents.find((document) => document.id === 'project');
    expect(project?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'schema', required: true }),
        expect.objectContaining({ name: 'schemaVersion', required: true }),
        expect.objectContaining({ name: 'project', required: true }),
      ]),
    );
    expect(JSON.parse(rawSchemas['project.schema.json'] ?? '{}')).toHaveProperty(
      'properties.project',
    );
    expect(rawSchemas['records/rooms.schema.json']).toBeTruthy();
  });

  it('generates the complete deterministic agent-kit payload from current codecs', () => {
    const first = createNovelTeaAgentKitPayload();
    const second = createNovelTeaAgentKitPayload();
    expect(second).toEqual(first);
    expect(Object.keys(first.files)).toEqual(
      expect.arrayContaining([
        'GUIDE.md',
        'CLI.md',
        'PROJECT_FORMAT.md',
        'docs/AUTHORING.md',
        'docs/ARCHETYPES_TRAITS.md',
        'docs/CHARACTERS.md',
        'docs/DIALOGUES.md',
        'docs/INTERACTIONS.md',
        'docs/ITEMS_INVENTORIES.md',
        'docs/ROOMS.md',
        'docs/SCENES.md',
        'docs/TESTS.md',
        'docs/RMLUI.md',
        'docs/RCSS_REFERENCE.md',
        'docs/RMLUI_DATA_BINDING.md',
        'docs/RMLUI_CUSTOM_COMPONENTS.md',
        'docs/RMLUI_LUA.md',
        'schemas/project.schema.json',
        'schemas/traits.schema.json',
        'schemas/localization.schema.json',
        'schemas/editor.schema.json',
        'schemas/records/layouts.schema.json',
        'schemas/records/archetypes.schema.json',
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
        revision: '10357105438f9d72cc6766be04827f3ea7bea8af',
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
        'command-builder': {
          builtinFallback: true,
          document: 'ui/runtime/command-builder.rml',
          authoringUrl: 'system|/ui/runtime/command-builder.rml',
          supportingFiles: ['ui/runtime/command-builder.rcss'],
        },
        'scene-text': {
          builtinFallback: true,
          document: 'ui/runtime/scene-text.rml',
          authoringUrl: 'system|/ui/runtime/scene-text.rml',
          supportingFiles: ['ui/runtime/scene-presentation.rcss'],
        },
        'scene-choice': {
          builtinFallback: true,
          document: 'ui/runtime/scene-choice.rml',
          authoringUrl: 'system|/ui/runtime/scene-choice.rml',
          supportingFiles: ['ui/runtime/scene-presentation.rcss'],
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
    expect(first.files['docs/INTERACTIONS.md']).toContain('Room Hotspots may target');
    expect(first.files['docs/INTERACTIONS.md']).toContain(
      'its reference is always owner-qualified',
    );
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
    expect(first.files['docs/RMLUI_DATA_BINDING.md']).toContain(
      'Game.ui.navigate_map_connection(map_id, connection_id)',
    );
    expect(first.files['docs/RMLUI_CUSTOM_COMPONENTS.md']).toContain('nt-active-text');
    expect(first.files['docs/RMLUI_CUSTOM_COMPONENTS.md']).toContain('nt-map-view\n');
    expect(first.files['docs/RMLUI_CUSTOM_COMPONENTS.md']).not.toContain(
      'nt-map-view   (provisional)',
    );
    expect(first.files['docs/RMLUI_CUSTOM_COMPONENTS.md']).toContain(
      'When the project contains exactly one authored Map, `map` may be omitted',
    );
    expect(first.files['docs/RMLUI_CUSTOM_COMPONENTS.md']).toContain(
      'mounted gameplay Layout documents',
    );
    expect(first.files['docs/RMLUI_CUSTOM_COMPONENTS.md']).toContain(
      'Multiple occurrences are independent',
    );
    expect(first.files['docs/RMLUI_CUSTOM_COMPONENTS.md']).toContain('Layout State Shape/Slot');
    expect(first.files['docs/RMLUI_CUSTOM_COMPONENTS.md']).toContain(
      'Game.ui.navigate_map_location(map_id, location_id)',
    );
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
    expect(first.files['docs/LUA.md']).toContain(
      'Layout.clamp_to_viewport(element, x, y, padding?)',
    );
    expect(first.files['docs/LUA.md']).toContain('mount:position_hint()');
    expect(first.files['docs/LUA.md']).toContain('offsetX?, offsetY?');
    expect(first.files['docs/LUA.md']).toContain(
      'Project-bootstrap globals are not visible to Layout scripts',
    );
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
      'ui/runtime/command-builder.rcss',
      'ui/runtime/command-builder.rml',
      'ui/runtime/inventory.lua',
      'ui/runtime/inventory.rcss',
      'ui/runtime/inventory.rml',
      'ui/runtime/runtime_game.rcss',
      'ui/runtime/runtime_game.rml',
      'ui/runtime/scene-choice.rml',
      'ui/runtime/scene-presentation.rcss',
      'ui/runtime/scene-text.rml',
      'ui/runtime/verb-menu.lua',
      'ui/runtime/verb-menu.rcss',
      'ui/runtime/verb-menu.rml',
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
      'ui_primary_activate',
      'ui_open_verb_menu',
      'ui_context_activate',
      'ui_present_player_inventory',
      'ui_clear_selection',
      'ui_invoke_interaction',
      'ui_command_builder_submit',
      'ui_command_builder_rebind',
      'ui_command_builder_cancel',
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
      'shell_set_locale',
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
      ChoiceProjection: ['id', 'label', 'enabled'],
      ActorProjection: [
        'character_id',
        'instance_id',
        'pose_id',
        'expression_id',
        'presentation_complete',
      ],
      ExitProjection: ['id', 'target_id', 'direction', 'label', 'enabled', 'glyph'],
      ObjectProjection: ['subject_kind', 'subject_id', 'label', 'enabled', 'selected'],
      InventoryItemProjection: [
        'id',
        'definition_id',
        'inventory_key',
        'display_name',
        'quantity',
        'stackable',
        'has_stack_limit',
        'stack_limit',
        'has_sprite',
        'sprite_id',
        'has_material',
        'material_id',
        'enabled',
        'visible',
        'selected',
      ],
      ActionProjection: [
        'verb_id',
        'slot_id',
        'label',
        'binding_order',
        'rank',
        'primary',
        'enabled',
      ],
      TextLogEntryProjection: ['sequence', 'kind', 'has_speaker', 'speaker_id', 'text', 'body_rml'],
      DialogueStageSlotProjection: [
        'id',
        'populated',
        'character_id',
        'profile_id',
        'pose_id',
        'expression_id',
        'appearance_id',
        'position',
        'offset_x',
        'offset_y',
        'scale',
        'visible',
        'speaker_sync',
        'speaking',
      ],
      DialogueMediaSlotProjection: [
        'id',
        'populated',
        'visible',
        'kind',
        'asset_id',
        'character_id',
        'profile_id',
        'pose_id',
        'expression_id',
        'appearance_id',
      ],
      DialogueProjection: ['available', 'id', 'choices', 'stage_slots', 'media_slots'],
      SceneProjection: ['choices'],
      RoomProjection: ['available', 'has_enabled_exits', 'exits', 'objects'],
      InventoryProjection: ['items', 'presented_key', 'player_available'],
      InteractionProjection: [
        'has_selection',
        'selected_subject_kind',
        'selected_subject_id',
        'verb_menu_open',
        'actions',
      ],
      CommandBuilderWatchedProjection: [
        'subject_kind',
        'subject_id',
        'live',
        'available',
        'enabled',
        'visible',
        'room_id',
        'traits',
        'offers',
      ],
      CommandBuilderProjection: [
        'active',
        'occurrence',
        'capture_revision',
        'captured_subject_kind',
        'captured_subject_id',
        'verb_id',
        'label',
        'binding_order',
        'bound_slots',
        'focused_slot',
        'complete',
        'watched',
      ],
      TextLogProjection: ['entries'],
      GameplayProjection: [
        'available',
        'mode',
        'title',
        'notification',
        'can_continue',
        'active_text_available',
        'scene_text_available',
        'actors',
        'scene',
        'dialogue',
        'room',
        'inventory',
        'interaction',
        'command_builder',
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
      LocaleOptionProjection: [
        'locale',
        'native_name',
        'display_name',
        'right_to_left',
        'direction',
        'font_family',
        'active',
      ],
      LocaleChangeResultProjection: [
        'available',
        'succeeded',
        'requested_locale',
        'diagnostic_code',
        'message',
      ],
      ConfirmationProjection: ['active', 'prompt'],
      ShellProjection: [
        'available',
        'screen',
        'game_active',
        'status',
        'settings',
        'active_locale',
        'locales',
        'locale_change_pending',
        'locale_change_result',
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
    expect(customTags).toEqual(['nt-tr', 'nt-active-text', 'nt-map-view']);

    const payload = createNovelTeaAgentKitPayload();
    const bindingGuide = payload.files['docs/RMLUI_DATA_BINDING.md']!;
    for (const variable of topLevelVariables) expect(bindingGuide).toContain(`### \`${variable}\``);
    for (const callback of callbackNames) expect(bindingGuide).toContain(`${callback}(`);

    const componentGuide = payload.files['docs/RMLUI_CUSTOM_COMPONENTS.md']!;
    for (const tag of customTags) expect(componentGuide).toContain(`\`${tag}\``);
    expect(componentGuide).toContain('There is no current `nt-text-log` element');
    expect(componentGuide).not.toContain('`nt-map-view` is provisional');
    expect(componentGuide).not.toContain('updates only the first `nt-map-view`');
    expect(componentGuide).toContain(
      'The `map` attribute selects the authored Map by stable Map ID',
    );
    expect(componentGuide).toContain('RuntimeUI refreshes every matching `nt-map-view`');
    expect(componentGuide).toContain('Each occurrence owns its own `open`, `mode`, `focus`');
    expect(componentGuide).toContain('Game.mount_context():commit_state(...)');
    expect(componentGuide).toContain('semantic Location and Connection targets');
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
    expect(excludedGlobals).toEqual(['io', 'debug', 'package', 'require', 'dofile', 'loadfile']);

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
      [typedBindings, 'properties', 'noveltea.properties', 6],
      [typedBindings, 'interactables', 'noveltea.interactables', 12],
      [typedBindings, 'characters', 'noveltea.characters', 2],
      [typedBindings, 'navigation', 'noveltea.navigation', 1],
      [typedBindings, 'flow', 'noveltea.flow', 9],
      [typedBindings, 'game', 'Game', 11],
      [capabilityBindings, 'room_presentation', 'noveltea.room_presentation', 2],
      [capabilityBindings, 'random', 'noveltea.random', 3],
      [capabilityBindings, 'map', 'noveltea.map', 1],
      [capabilityBindings, 'layouts', 'noveltea.layouts', 6],
      [capabilityBindings, 'presentation', 'noveltea.presentation', 20],
      [capabilityBindings, 'text_log', 'noveltea.text_log', 2],
      [capabilityBindings, 'game', 'Game', 4],
      [gameplayUiBindings, 'ui', 'Game.ui', 18],
      [shellUiBindings, 'shell', 'Game.shell', 24],
      [shellUiBindings, 'game', 'Game', 4],
    ] as const;
    for (const [source, object, prefix, expectedCount] of groups) {
      const functions = setFunctions(source, object);
      expect(functions).toHaveLength(expectedCount);
      for (const name of functions) expect(guide).toContain(`${prefix}.${name}`);
    }

    const projectDefinitionReaders = [
      ...typedBindings.matchAll(/bind_definition_reader\(project,\s*"([^"]+)"/g),
    ].map((match) => match[1]);
    expect(projectDefinitionReaders).toEqual(['scene', 'dialogue', 'verb', 'interaction', 'map']);
    const projectIdentityReaders = [
      ...typedBindings.matchAll(/bind_identity_reader<[^>]+>\s*\(\s*project,\s*"([^"]+)"/g),
    ].map((match) => match[1]);
    expect(projectIdentityReaders).toEqual(['room', 'character', 'interactable']);
    for (const name of [...projectDefinitionReaders, ...projectIdentityReaders])
      expect(guide).toContain(`noveltea.project.${name}`);
    expect(guide).toContain('noveltea.project.feature');
    for (const member of [
      'kind',
      'id',
      'prop',
      'set_prop',
      'unset_prop',
      'location',
      'set_location',
    ])
      expect(guide).toContain(member);

    const audioFunctions = setFunctions(capabilityBindings, 'audio');
    expect(audioFunctions).toEqual([
      '_play',
      'play_ui',
      '_stop',
      'set_loop',
      'set_music',
      'clear_loop',
      'clear_purpose',
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
      /case RuntimeCapabilityProfile::OnGameReady:\s*return \{profile, all_gameplay_queries, 0, false, false\};/,
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
      /case RuntimeCapabilityProfile::ShellLayoutEvent:\s*return \{profile, capability_bit\(G::Save\) \| capability_bit\(G::Game\),\s*capability_bit\(G::Save\) \| capability_bit\(G::Game\) \| capability_bit\(G::Cursor\),\s*false, false\};/,
    );
    for (const profile of [
      'Gameplay Script',
      'On Game Ready',
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
      reviewed: '2026-08-30',
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

  it('regenerates an invalid agent-kit manifest without changing tracked project source', async () => {
    const value = fixture();
    await syncNovelTeaAgentKit(value.fileSystem, root);
    const trackedRoomBefore = await value.fileSystem.readText(`${root}/records/rooms/start.json`);
    const manifestPath = `${root}/.noveltea/agent/manifest.json`;
    const staleManifest = JSON.parse(await value.fileSystem.readText(manifestPath));
    staleManifest.schema = 'noveltea.agent-kit.retired-manifest';
    await value.fileSystem.writeTextAtomic(
      manifestPath,
      `${JSON.stringify(staleManifest, null, 2)}\n`,
    );

    const result = await runNovelTeaCli(['--json', 'agent', 'sync'], options(value));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).agentKitChanged).toBe(true);
    expect(JSON.parse(await value.fileSystem.readText(manifestPath)).schema).toBe(
      'noveltea.agent-kit.manifest',
    );
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
