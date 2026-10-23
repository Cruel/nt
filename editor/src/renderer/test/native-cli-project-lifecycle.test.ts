import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { parseNovelTeaCliGlobals } from '../../cli/bootstrap';
import {
  runNativeProjectLifecycleCli,
  type NativeProjectCommandCall,
} from '../../cli/native-project-lifecycle-cli';
import { runNativeProjectReadsCli } from '../../cli/native-project-reads-cli';
import { runNativeProjectMutationsCli } from '../../cli/native-project-mutations-cli';
import { runNativeProjectFmtCli } from '../../cli/native-project-fmt-cli';
import { runNativeProjectLocalizationCli } from '../../cli/native-project-localization-cli';
import { runNativeProjectReconcileCli } from '../../cli/native-project-reconcile-cli';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

function globals(...argv: string[]) {
  return parseNovelTeaCliGlobals(['--json', ...argv]);
}

describe('native CLI Project lifecycle boundary', () => {
  it('leaves non-lifecycle command families to their established owners', async () => {
    const call: NativeProjectCommandCall = () => {
      throw new Error('should not be invoked');
    };
    expect(await runNativeProjectLifecycleCli(globals('validate'), '/tmp', call)).toBeNull();
  });

  it('parses project create without invoking the TypeScript Project writer', async () => {
    const requests: Record<string, unknown>[] = [];
    const call: NativeProjectCommandCall = (request) => {
      requests.push({ ...request });
      return {
        ok: true,
        projectRoot: '/tmp/native-project',
        projectFilePath: '/tmp/native-project/project.yaml',
        projectId: 'native-project',
      };
    };
    const result = await runNativeProjectLifecycleCli(
      globals('project', 'create', 'native-project', '--name', 'Native Project'),
      '/tmp',
      call,
    );
    expect(requests).toEqual([
      { action: 'project-create', projectRoot: '/tmp/native-project', name: 'Native Project' },
    ]);
    expect(result?.exitCode).toBe(0);
    expect(result?.envelope.projectId).toBe('native-project');
    expect(result?.envelope.projectFilePath).toBe('/tmp/native-project/project.yaml');
  });

  it('maps native conflict and invalid-bundle errors to existing CLI exit codes', async () => {
    const conflict = await runNativeProjectLifecycleCli(
      globals('project', 'create', 'existing', '--name', 'Existing'),
      '/tmp',
      () => ({ ok: false, kind: 'conflict', error: 'Destination exists.' }),
    );
    expect(conflict?.exitCode).toBe(5);
    expect(conflict?.envelope.diagnostics[0]?.code).toBe('PROJECT_CREATE_DESTINATION_CONFLICT');

    const invalid = await runNativeProjectLifecycleCli(
      globals('project', 'import', 'broken.ntproject', 'destination'),
      '/tmp',
      () => ({ ok: false, kind: 'invalid-bundle', error: 'Malformed archive.' }),
    );
    expect(invalid?.exitCode).toBe(4);
    expect(invalid?.envelope.diagnostics[0]?.code).toBe('PROJECT_BUNDLE_INVALID');
  });

  it('does not parse YAML during physical discovery of an export Project', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-lifecycle-'));
    temporary.push(root);
    await writeFile(path.join(root, 'project.yaml'), 'invalid: [yaml\n');
    const calls: Record<string, unknown>[] = [];
    const result = await runNativeProjectLifecycleCli(
      globals('project', 'export', '--output', 'bundle.ntproject'),
      root,
      (request) => {
        calls.push({ ...request });
        return { ok: false, kind: 'invalid-project', error: 'Native admission rejected YAML.' };
      },
    );
    expect(calls).toEqual([
      {
        action: 'project-export',
        projectRoot: root,
        outputPath: path.join(root, 'bundle.ntproject'),
      },
    ]);
    expect(result?.exitCode).toBe(4);
    expect(result?.envelope.diagnostics[0]?.code).toBe('PROJECT_BUNDLE_PROJECT_INVALID');
  });

  it('never retries a native operation after a transport failure', async () => {
    let attempts = 0;
    const result = await runNativeProjectLifecycleCli(
      globals('project', 'import', 'archive.ntproject', 'target'),
      '/tmp',
      () => {
        attempts += 1;
        throw new Error('Transport lost its response.');
      },
    );
    expect(attempts).toBe(1);
    expect(result?.exitCode).toBe(5);
  });

  it('rejects unsupported global options before native source mutation', async () => {
    let called = false;
    const result = await runNativeProjectLifecycleCli(
      parseNovelTeaCliGlobals([
        '--json',
        '--project',
        '/tmp/other',
        'project',
        'import',
        'bundle.ntproject',
        'target',
      ]),
      '/tmp',
      () => {
        called = true;
        return { ok: true };
      },
    );
    expect(called).toBe(false);
    expect(result?.exitCode).toBe(2);
    expect(result?.envelope.diagnostics[0]?.code).toBe('CLI_USAGE');
  });

  it('routes native inspect and usages without loading TypeScript Project state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-reads-'));
    temporary.push(root);
    await writeFile(path.join(root, 'project.yaml'), 'invalid: [yaml\n');
    const requests: Record<string, unknown>[] = [];
    const native: NativeProjectCommandCall = (request) => {
      requests.push({ ...request });
      if (request.action === 'entity-inspect')
        return {
          ok: true,
          fields: {
            collection: 'rooms',
            id: 'intro',
            record: { id: 'intro' },
            provenance: { id: 'explicit' },
          },
        };
      return { ok: true, collection: 'rooms', id: 'intro', usages: [] };
    };
    const inspected = await runNativeProjectReadsCli(
      globals('entity', 'inspect', 'rooms', 'intro', '--provenance'),
      root,
      native,
    );
    const usages = await runNativeProjectReadsCli(
      globals('usages', 'rooms', 'intro'),
      root,
      native,
    );
    expect(inspected?.exitCode).toBe(0);
    expect(inspected?.envelope.provenance).toEqual({ id: 'explicit' });
    expect(usages?.exitCode).toBe(0);
    expect(usages?.envelope.usages).toEqual([]);
    expect(requests).toEqual([
      {
        action: 'entity-inspect',
        projectRoot: root,
        collection: 'rooms',
        id: 'intro',
        provenance: true,
      },
      { action: 'entity-usages', projectRoot: root, collection: 'rooms', id: 'intro' },
    ]);
  });

  it('routes native localization view and Asset audit and validates status grammar', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-reads-'));
    temporary.push(root);
    await writeFile(path.join(root, 'project.yaml'), 'project: example\n');
    const requests: Record<string, unknown>[] = [];
    const native: NativeProjectCommandCall = (request) => {
      requests.push({ ...request });
      if (request.action === 'localization-view')
        return { ok: true, locale: 'fr', statusFilter: 'missing', messages: [] };
      return {
        ok: true,
        fields: { untrackedFiles: [] },
        humanSuccess: 'No untracked Asset files.',
      };
    };
    const view = await runNativeProjectReadsCli(
      globals('localization', 'view', 'fr', '--status', 'missing'),
      root,
      native,
    );
    expect(view?.envelope.statusFilter).toBe('missing');
    const audit = await runNativeProjectReadsCli(globals('asset', 'audit'), root, native);
    expect(audit?.envelope.untrackedFiles).toEqual([]);
    expect(requests).toHaveLength(2);
    const invalid = await runNativeProjectReadsCli(
      globals('localization', 'view', 'fr', '--status', 'unknown-value'),
      root,
      native,
    );
    expect(invalid?.exitCode).toBe(2);
    expect(requests).toHaveLength(2);
  });

  it('routes native entity creation and uses the physical native plan in JSON', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-writes-'));
    temporary.push(root);
    await writeFile(path.join(root, 'project.yaml'), 'invalid: [yaml\n');
    const requests: Record<string, unknown>[] = [];
    const result = await runNativeProjectMutationsCli(
      globals('entity', 'create', 'rooms', 'new-room', '--dry-run'),
      root,
      (request) => {
        requests.push({ ...request });
        return {
          ok: true,
          plan: {
            writes: ['records/rooms/new-room.yaml'],
            deletes: [],
            moves: [],
            referenceRepairs: ['/rooms/new-room'],
          },
        };
      },
    );
    expect(result?.exitCode).toBe(0);
    expect(result?.envelope.plan).toEqual({
      writes: ['records/rooms/new-room.yaml'],
      deletes: [],
      moves: [],
      referenceRepairs: ['/rooms/new-room'],
    });
    expect(requests).toEqual([
      {
        action: 'entity-create',
        projectRoot: root,
        collection: 'rooms',
        id: 'new-room',
        dryRun: true,
      },
    ]);
  });

  it('uses the native dry-run source revision for a rename commit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-writes-'));
    temporary.push(root);
    await writeFile(path.join(root, 'project.yaml'), 'project: old\n');
    const requests: Record<string, unknown>[] = [];
    const result = await runNativeProjectMutationsCli(
      globals('entity', 'rename', 'rooms', 'old-room', 'new-room'),
      root,
      (request) => {
        requests.push({ ...request });
        return {
          ok: true,
          sourceRevision: 'sha256:old-source',
          plan: {
            writes: ['records/rooms/new-room.yaml'],
            deletes: ['records/rooms/old-room.yaml'],
            moves: [],
            referenceRepairs: [],
          },
        };
      },
    );
    expect(result?.exitCode).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.dryRun).toBe(true);
    expect(requests[1]).toMatchObject({
      action: 'entity-rename',
      dryRun: false,
      sourceRevision: 'sha256:old-source',
    });
  });

  it('never executes a second mutation when the native preflight fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-writes-'));
    temporary.push(root);
    await writeFile(path.join(root, 'project.yaml'), 'project: old\n');
    let calls = 0;
    const result = await runNativeProjectMutationsCli(
      globals('entity', 'delete', 'rooms', 'old-room'),
      root,
      () => {
        calls += 1;
        return { ok: false, error: 'Native entity source does not exist.' };
      },
    );
    expect(calls).toBe(1);
    expect(result?.exitCode).toBe(4);
  });

  it('resolves native Asset sources relative to the caller, not the Project root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-assets-'));
    temporary.push(root);
    await writeFile(path.join(root, 'project.yaml'), 'project: old\n');
    const call: NativeProjectCommandCall = (request) => {
      expect(request.paths).toEqual([path.join(root, 'source.png')]);
      expect(request.dryRun).toBe(true);
      return { ok: true, fields: { dryRun: true, assets: [] } };
    };
    const result = await runNativeProjectMutationsCli(
      globals('asset', 'import', 'source.png', '--dry-run'),
      root,
      call,
    );
    expect(result?.exitCode).toBe(0);
    expect(result?.envelope.assets).toEqual([]);
  });

  it('uses the native formatting plan for a single exact-revision commit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-fmt-'));
    temporary.push(root);
    await writeFile(path.join(root, 'project.yaml'), 'project: old\n');
    const requests: Record<string, unknown>[] = [];
    const result = await runNativeProjectFmtCli(
      globals('fmt', '--strip-defaults'),
      root,
      (request) => {
        requests.push({ ...request });
        return {
          ok: true,
          changed: true,
          checked: 8,
          files: ['records/rooms/demo.yaml'],
          diskPreconditions: { 'records/rooms/demo.yaml': 'sha256:old-source' },
        };
      },
    );
    expect(result?.exitCode).toBe(0);
    expect(result?.envelope.changed).toBe(1);
    expect(result?.envelope.checked).toBe(8);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ action: 'fmt', check: true, stripDefaults: true });
    expect(requests[1]).toMatchObject({
      action: 'fmt',
      check: false,
      diskPreconditions: { 'records/rooms/demo.yaml': 'sha256:old-source' },
    });
  });

  it('format --check reports source changes as warnings with semantic exit code', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-fmt-'));
    temporary.push(root);
    await writeFile(path.join(root, 'project.yaml'), 'project: old\n');
    let called = 0;
    const result = await runNativeProjectFmtCli(globals('fmt', '--check'), root, () => {
      called += 1;
      return { ok: true, changed: true, checked: 3, files: ['project.yaml'] };
    });
    expect(result?.exitCode).toBe(4);
    expect(result?.envelope.changed).toBe(1);
    expect(result?.envelope.diagnostics[0]?.code).toBe('FMT_CHANGE');
    expect(called).toBe(1);
  });

  it('syncs localization with an exact native source generation and revision', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-sync-'));
    temporary.push(root);
    await writeFile(path.join(root, 'project.yaml'), 'project: example\n');
    const requests: Record<string, unknown>[] = [];
    const response = {
      ok: true,
      changed: true,
      sourceRevision: 'sha256:source',
      sourceGeneration: 'sha256:generation',
      materializedMessageIds: ['first'],
      preservedMessageIds: [],
      unresolved: [],
      structuredMessageCount: 1,
      writes: ['i18n/tracking.yaml'],
    };
    const result = await runNativeProjectLocalizationCli(
      globals('localization', 'sync'),
      root,
      (request) => {
        requests.push({ ...request });
        return response;
      },
    );
    expect(result?.exitCode).toBe(0);
    expect(result?.envelope.materializedMessageIds).toEqual(['first']);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.dryRun).toBe(true);
    expect(requests[1]).toMatchObject({
      action: 'localization-sync',
      dryRun: false,
      sourceRevision: 'sha256:source',
      expectedSourceGeneration: 'sha256:generation',
    });
  });

  it('does not commit localization sync if its native dry-run returns an error', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-sync-'));
    temporary.push(root);
    await writeFile(path.join(root, 'project.yaml'), 'project: example\n');
    let calls = 0;
    const result = await runNativeProjectLocalizationCli(
      globals('localization', 'sync'),
      root,
      () => {
        calls += 1;
        return { ok: false, error: 'Changed source authority.' };
      },
    );
    expect(result?.exitCode).toBe(5);
    expect(calls).toBe(1);
  });

  it('preserves pre-mutation native authoring warnings in the CLI envelope', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-warnings-'));
    temporary.push(root);
    await writeFile(path.join(root, 'project.yaml'), 'project: example\n');
    const result = await runNativeProjectReadsCli(
      globals('usages', 'rooms', 'intro'),
      root,
      () => ({
        ok: true,
        collection: 'rooms',
        id: 'intro',
        usages: [],
        cliDiagnostics: [
          {
            code: 'authoring.entrypoint.missing',
            path: '/entrypoint',
            severity: 'warning',
            message: 'No project entrypoint is configured yet.',
          },
        ],
      }),
    );
    expect(result?.envelope.diagnostics).toEqual([
      {
        code: 'authoring.entrypoint.missing',
        path: '/entrypoint',
        severity: 'warning',
        message: 'No project entrypoint is configured yet.',
      },
    ]);
  });

  it('preserves a missing-record semantic error and native admission warnings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-missing-'));
    temporary.push(root);
    await writeFile(path.join(root, 'project.yaml'), 'project: example\n');
    const result = await runNativeProjectReadsCli(
      globals('entity', 'inspect', 'rooms', 'absent'),
      root,
      () => ({
        ok: false,
        error: 'Native entity source does not exist.',
        cliDiagnostics: [
          {
            code: 'authoring.entrypoint.missing',
            path: '/entrypoint',
            severity: 'warning',
            message: 'No project entrypoint is configured yet.',
          },
        ],
      }),
    );
    expect(result?.exitCode).toBe(4);
    expect(result?.envelope.diagnostics.map((item) => item.code)).toEqual([
      'authoring.entity.not_found',
      'authoring.entrypoint.missing',
    ]);
  });

  it('attributes malformed native Room reads to their actual tracked YAML owner', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-malformed-room-'));
    temporary.push(root);
    await writeFile(path.join(root, 'project.yaml'), 'project: example\n');
    const result = await runNativeProjectReadsCli(
      globals('entity', 'inspect', 'rooms', 'sample'),
      root,
      () => ({ ok: false, error: 'Invalid Room YAML: Invalid YAML document.' }),
    );
    expect(result?.exitCode).toBe(3);
    expect(result?.envelope.diagnostics).toEqual([
      {
        code: 'WORKSPACE_SOURCE_READ',
        path: '/records/rooms/sample.yaml',
        severity: 'error',
        message: 'Record is malformed.',
      },
    ]);
  });

  it('accepts named localization messages through revision-proven native commit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-target-'));
    temporary.push(root);
    await writeFile(path.join(root, 'project.yaml'), 'project: example\n');
    const requests: Record<string, unknown>[] = [];
    const result = await runNativeProjectLocalizationCli(
      globals('localization', 'accept', 'fr', 'welcome'),
      root,
      (request) => {
        requests.push({ ...request });
        return {
          ok: true,
          sourceGeneration: 'sha256:inputs',
          sourceRevision: 'sha256:translation',
          writes: ['i18n/locales/fr.yaml'],
        };
      },
    );
    expect(result?.exitCode).toBe(0);
    expect(result?.envelope.messageIds).toEqual(['welcome']);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      action: 'localization-targets',
      operation: 'accept',
      locale: 'fr',
      messageIds: ['welcome'],
      dryRun: true,
    });
    expect(requests[1]).toMatchObject({
      operation: 'accept',
      dryRun: false,
      sourceRevision: 'sha256:translation',
      expectedSourceGeneration: 'sha256:inputs',
    });
  });

  it('returns an opaque native revision in the reconciliation plan', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-reconcile-'));
    temporary.push(root);
    await writeFile(path.join(root, 'project.yaml'), 'project: example\n');
    const result = await runNativeProjectReconcileCli(
      globals('localization', 'reconcile'),
      root,
      () => ({
        ok: true,
        plan: {
          expectedWorkspaceRevision: 'sha256:native',
          expectedFingerprint: 'hash',
          groups: [],
        },
        sourceGeneration: 'sha256:native',
        diskPreconditions: {},
        writes: [],
      }),
      () => {
        throw new Error('Dry runs must not read stdin.');
      },
    );
    expect(result?.exitCode).toBe(0);
    expect(
      (result?.envelope?.plan as Record<string, unknown> | undefined)?.expectedWorkspaceRevision,
    ).toBe('sha256:native');
  });

  it('rejects stale reconciliation plans before invoking a native writer', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-reconcile-'));
    temporary.push(root);
    await writeFile(path.join(root, 'project.yaml'), 'project: example\n');
    let calls = 0;
    const result = await runNativeProjectReconcileCli(
      globals('localization', 'reconcile', '--apply'),
      root,
      () => {
        calls += 1;
        return {
          ok: true,
          plan: { expectedWorkspaceRevision: 'sha256:new', expectedFingerprint: 'new', groups: [] },
          sourceGeneration: 'sha256:new',
          diskPreconditions: {},
          writes: [],
        };
      },
      () =>
        JSON.stringify({
          expectedWorkspaceRevision: 'sha256:old',
          expectedFingerprint: 'old',
          resolutions: {},
        }),
    );
    expect(calls).toBe(1);
    expect(result?.exitCode).toBe(4);
    expect(result?.envelope.diagnostics[0]?.code).toBe('localization.reconcile.stale-plan');
  });

  it('commits reconciliation only with verified generation and disk preconditions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-reconcile-'));
    temporary.push(root);
    await writeFile(path.join(root, 'project.yaml'), 'project: example\n');
    const requests: Record<string, unknown>[] = [];
    const result = await runNativeProjectReconcileCli(
      globals('localization', 'reconcile', '--apply'),
      root,
      (request) => {
        requests.push({ ...request });
        if (request.dryRun)
          return {
            ok: true,
            plan: {
              expectedWorkspaceRevision: 'sha256:inputs',
              expectedFingerprint: 'fingerprint',
              groups: [],
            },
            sourceGeneration: 'sha256:inputs',
            diskPreconditions: { 'i18n/tracking.yaml': 'sha256:tracking' },
            writes: [],
          };
        return {
          ok: true,
          status: 'applied',
          relinkedMessageIds: [],
          materializedMessageIds: [],
          orphanedMessageIds: [],
          garbageCollectedMessageIds: [],
          writes: ['i18n/tracking.yaml'],
        };
      },
      () =>
        JSON.stringify({
          expectedWorkspaceRevision: 'sha256:inputs',
          expectedFingerprint: 'fingerprint',
          resolutions: {},
        }),
    );
    expect(result?.exitCode).toBe(0);
    expect(result?.envelope.writes).toEqual(['i18n/tracking.yaml']);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      action: 'localization-reconcile',
      dryRun: false,
      expectedSourceGeneration: 'sha256:inputs',
      expectedWorkspaceRevision: 'sha256:inputs',
      expectedFingerprint: 'fingerprint',
      diskPreconditions: { 'i18n/tracking.yaml': 'sha256:tracking' },
    });
  });
});
