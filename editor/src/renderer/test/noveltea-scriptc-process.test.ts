import os from 'node:os';
import { describe, expect, it } from 'vite-plus/test';
import { runNovelTeaScriptcProcess } from '../../../scripts/noveltea-scriptc-process';

describe('NovelTea scriptc process host', () => {
  it('preserves stdout and stderr from successful child processes', () => {
    const response = JSON.parse(
      runNovelTeaScriptcProcess(
        JSON.stringify({
          command: process.execPath,
          args: [
            '-e',
            "process.stdout.write(`${process.cwd()}:${process.env.NOVELTEA_PROCESS_TEST}`); process.stderr.write('err')",
          ],
          cwd: os.tmpdir(),
          env: { ...process.env, NOVELTEA_PROCESS_TEST: 'configured' },
        }),
      ),
    );

    expect(response).toEqual({
      ok: true,
      stdout: `${os.tmpdir()}:configured`,
      stderr: 'err',
    });
  });
});
