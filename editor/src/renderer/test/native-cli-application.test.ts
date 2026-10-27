import { describe, expect, it, vi } from 'vite-plus/test';
import { runNativeOnlyNovelTeaCli } from '../../cli/native-application';

describe('native-only CLI application boundary', () => {
  it('classifies missing standalone platform templates as semantic errors, not native failures', async () => {
    const native = vi.fn();
    const result = await runNativeOnlyNovelTeaCli(
      ['--json', 'platform', 'template', 'inspect', 'missing@v1'],
      {
        nativeProjectCommands: native,
        platformTools: { inspectTemplate: async () => null } as never,
      },
    );
    expect(result.exitCode).toBe(4);
    expect(result.envelope.diagnostics[0]?.code).toBe('platform.template_missing');
    expect(native).not.toHaveBeenCalled();
  });

  it('dispatches Project creation through C++ authority without legacy Workspace options', async () => {
    const native = vi.fn(async () => ({
      ok: true,
      projectRoot: '/scratch/native',
      projectFilePath: '/scratch/native/project.yaml',
      projectId: 'native',
    }));
    const result = await runNativeOnlyNovelTeaCli(
      ['--json', 'project', 'create', '/scratch/native', '--name', 'Native'],
      { cwd: '/', nativeProjectCommands: native },
    );
    expect(result.exitCode).toBe(0);
    expect(native).toHaveBeenCalledExactlyOnceWith({
      action: 'project-create',
      projectRoot: '/scratch/native',
      name: 'Native',
    });
  });

  it('rejects unsupported commands before reaching old TS preparation', async () => {
    const native = vi.fn(async () => {
      throw new Error('Native should not be invoked by an unclaimed command');
    });
    const result = await runNativeOnlyNovelTeaCli(['--json', 'daemon', 'status'], {
      nativeProjectCommands: native,
    });
    expect(result.exitCode).not.toBe(0);
    expect(native).not.toHaveBeenCalled();
    expect(result.envelope.diagnostics[0]?.code).toBe('CLI_USAGE');
  });

  it('fails closed on native create transport rejection with no legacy fallback', async () => {
    const native = vi.fn(async () => ({
      ok: false,
      kind: 'conflict',
      error: 'Destination exists',
    }));
    const result = await runNativeOnlyNovelTeaCli(
      ['--json', 'project', 'create', 'x', '--name', 'X'],
      {
        cwd: '/scratch',
        nativeProjectCommands: native,
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.envelope.diagnostics[0]?.code).toBe('PROJECT_CREATE_DESTINATION_CONFLICT');
    expect(native).toHaveBeenCalledOnce();
  });

  it('rejects missing native host even for valid Project commands', async () => {
    const result = await runNativeOnlyNovelTeaCli(
      ['--json', 'project', 'create', 'x', '--name', 'X'],
      {
        nativeProjectCommands: undefined as never,
      },
    );
    expect(result.envelope.diagnostics[0]?.code).toBe('CLI_NATIVE_OWNER_MISSING');
  });

  it('admits and proves a resident generation before disposable commands, without executing them', async () => {
    const native = vi.fn(async () => {
      throw new Error('Heavy native command must not execute during preparation.');
    });
    const snapshot = { projectRoot: '/scratch/project' };
    const open = vi.fn(async () => ({ ok: true, snapshot, diagnostics: [] }));
    const verifyReadAuthority = vi.fn(async () => true);
    const result = await runNativeOnlyNovelTeaCli(
      ['--json', '--project', '/scratch/project', 'package', 'export'],
      {
        cwd: '/scratch',
        nativeProjectCommands: native,
        prepareResidentSnapshotOnly: true,
        residentWorkspace: { open, verifyReadAuthority } as never,
        fileSystem: { inspect: async () => 'file' } as never,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.envelope.projectRoot).toBe('/scratch/project');
    expect(open).toHaveBeenCalledExactlyOnceWith('/scratch/project');
    expect(verifyReadAuthority).toHaveBeenCalledExactlyOnceWith(snapshot);
    expect(native).not.toHaveBeenCalled();
  });

  it('fails closed on a resident source-proof race without running the command', async () => {
    const native = vi.fn();
    const result = await runNativeOnlyNovelTeaCli(
      ['--json', '--project', '/scratch/project', 'project', 'export', 'out.ntproject'],
      {
        nativeProjectCommands: native,
        prepareResidentSnapshotOnly: true,
        fileSystem: { inspect: async () => 'file' } as never,
        residentWorkspace: {
          open: async () => ({
            ok: true,
            snapshot: { projectRoot: '/scratch/project' },
            diagnostics: [],
          }),
          verifyReadAuthority: async () => false,
        } as never,
      },
    );
    expect(result.envelope.diagnostics[0]?.code).toBe('WORKSPACE_REVISION_CONFLICT');
    expect(native).not.toHaveBeenCalled();
  });

  it('fails closed when native resident ownership is missing during preparation', async () => {
    const native = vi.fn();
    const result = await runNativeOnlyNovelTeaCli(
      ['--json', 'project', 'export', 'out.ntproject'],
      { nativeProjectCommands: native, prepareResidentSnapshotOnly: true },
    );
    expect(result.envelope.diagnostics[0]?.code).toBe('CLI_NATIVE_OWNER_MISSING');
    expect(native).not.toHaveBeenCalled();
  });

  it('prepares Project-less ComfyUI without requiring a resident owner or executing the command', async () => {
    const native = vi.fn();
    const result = await runNativeOnlyNovelTeaCli(['--json', 'comfyui', 'run', 'fixture'], {
      cwd: '/no-project',
      nativeProjectCommands: native,
      prepareResidentSnapshotOnly: true,
      fileSystem: { inspect: async () => 'missing' } as never,
    });
    expect(result.exitCode).toBe(0);
    expect(native).not.toHaveBeenCalled();
  });
});
