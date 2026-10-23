import { describe, expect, it, vi } from 'vite-plus/test';
import { runNativeOnlyNovelTeaCli } from '../../cli/native-application';

describe('native-only CLI application boundary', () => {
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
});
