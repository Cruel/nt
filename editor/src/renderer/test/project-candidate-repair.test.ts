import { describe, expect, it } from 'vite-plus/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  candidateManifestSyntaxDiagnostics,
  ProjectCandidateRepairService,
} from '../../main/services/project-candidate-repair-service';
import {
  closeRepairCandidateArgumentsSchema,
  createEditorDocumentPolicy,
  createGuardedIpcRegistrar,
  readRepairCandidateArgumentsSchema,
  saveRepairCandidateArgumentsSchema,
  type EditorIpcEvent,
  type EditorIpcMain,
  type EditorWebContents,
  type EditorWindow,
} from '../../main/editor-ipc-trust-boundary';
import { IPC_CHANNELS } from '../../shared/ipc-channels';

async function withCandidate(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'nt-repair-617-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('pre-admission Project Candidate repair', () => {
  it('exposes only main-issued candidate capability through guarded IPC, and revokes it', async () => {
    await withCandidate(async (root) => {
      const initial = 'schema: noveltea.project.workspace\ninvalid: [\n';
      await writeFile(path.join(root, 'project.yaml'), initial);
      const repairs = new ProjectCandidateRepairService();
      const entry = await repairs.registerFailedOpen(root);
      expect(entry).not.toBeNull();
      const handlers = new Map<string, (event: EditorIpcEvent, ...args: unknown[]) => unknown>();
      const ipcMain: EditorIpcMain = {
        handle: (channel, handler) => {
          handlers.set(channel, handler);
        },
      };
      const frame = { detached: false, url: 'noveltea-editor://app/index.html' };
      const contents: EditorWebContents = { mainFrame: frame, isDestroyed: () => false };
      const owner: EditorWindow = { webContents: contents, isDestroyed: () => false };
      const trusted: EditorIpcEvent = { sender: contents, senderFrame: frame };
      const forged: EditorIpcEvent = { sender: { ...contents }, senderFrame: frame };
      const register = createGuardedIpcRegistrar({
        ipcMain,
        getOwner: () => owner,
        documentPolicy: createEditorDocumentPolicy(),
      });
      register.handle(
        IPC_CHANNELS.READ_REPAIR_CANDIDATE,
        (args) => readRepairCandidateArgumentsSchema.parse(args),
        (id) => repairs.read(id),
      );
      register.handle(
        IPC_CHANNELS.SAVE_REPAIR_CANDIDATE,
        (args) => saveRepairCandidateArgumentsSchema.parse(args),
        (id, sourceRevision, text) => repairs.save(id, sourceRevision, text),
      );
      register.handle(
        IPC_CHANNELS.CLOSE_REPAIR_CANDIDATE,
        (args) => closeRepairCandidateArgumentsSchema.parse(args),
        (id) => repairs.close(id),
      );
      const invoke = (channel: string, event: EditorIpcEvent, ...args: unknown[]) =>
        handlers.get(channel)!(event, ...args);
      await expect(invoke(IPC_CHANNELS.READ_REPAIR_CANDIDATE, forged, entry!.id)).rejects.toThrow();
      await expect(invoke(IPC_CHANNELS.READ_REPAIR_CANDIDATE, trusted, root)).rejects.toThrow();
      await expect(
        invoke(IPC_CHANNELS.SAVE_REPAIR_CANDIDATE, trusted, root, 'absent', 'x'),
      ).rejects.toThrow();
      await expect(
        invoke(IPC_CHANNELS.READ_REPAIR_CANDIDATE, trusted, randomUUID()),
      ).rejects.toThrow(/expired/u);
      const source = (await invoke(
        IPC_CHANNELS.READ_REPAIR_CANDIDATE,
        trusted,
        entry!.id,
      )) as Awaited<ReturnType<typeof repairs.read>>;
      expect(source.text).toBe(initial);
      const revised = `${initial}# physical edit\n`;
      expect(
        await invoke(
          IPC_CHANNELS.SAVE_REPAIR_CANDIDATE,
          trusted,
          entry!.id,
          source.revision,
          revised,
        ),
      ).toMatchObject({ text: revised });
      await invoke(IPC_CHANNELS.CLOSE_REPAIR_CANDIDATE, trusted, entry!.id);
      await expect(invoke(IPC_CHANNELS.READ_REPAIR_CANDIDATE, trusted, entry!.id)).rejects.toThrow(
        /expired/u,
      );
      expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).toBe(revised);
    });
  });
  it('preserves malformed manifest bytes and refuses stale physical source writes', async () => {
    await withCandidate(async (root) => {
      const manifest = path.join(root, 'project.yaml');
      const initial = 'schema: noveltea.project.workspace\r\n# original\r\ninvalid: [\r\n';
      const edited = `${initial}# repair in progress\r\n`;
      await writeFile(manifest, initial);
      const repairs = new ProjectCandidateRepairService();
      const candidate = await repairs.registerFailedOpen(root);
      expect(candidate?.recognition).toBe('strong');
      expect((await repairs.registerFailedOpen(root))?.id).toBe(candidate?.id);
      expect(candidateManifestSyntaxDiagnostics(initial)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            sourcePath: 'project.yaml',
            line: 4,
            column: expect.any(Number),
          }),
        ]),
      );
      const opened = await repairs.read(candidate!.id);
      expect(opened).toMatchObject({ text: initial, sourcePath: 'project.yaml' });
      const saved = await repairs.save(candidate!.id, opened.revision, edited);
      expect(saved.text).toBe(edited);
      expect(await readFile(manifest, 'utf8')).toBe(edited);
      await expect(repairs.save(candidate!.id, opened.revision, 'lost update')).rejects.toThrow(
        /changed on disk/u,
      );
      await writeFile(manifest, 'external new version\n');
      await expect(repairs.save(candidate!.id, saved.revision, 'my old text')).rejects.toThrow(
        /changed on disk/u,
      );
      expect(await readFile(manifest, 'utf8')).toBe('external new version\n');
      repairs.close(candidate!.id);
      await expect(repairs.read(candidate!.id)).rejects.toThrow(/expired/u);
    });
  });

  it('creates a missing manifest only with two independently recognized sources', async () => {
    await withCandidate(async (root) => {
      const repairs = new ProjectCandidateRepairService();
      expect(await repairs.registerFailedOpen(root)).toBeNull();
      await writeFile(
        path.join(root, 'editor.yaml'),
        'chapters: {}\ntags: {}\nrecordMetadata: {}\n',
      );
      expect(await repairs.registerFailedOpen(root)).toBeNull();
      await mkdir(path.join(root, 'i18n'));
      await writeFile(
        path.join(root, 'i18n/project.yaml'),
        'sourceLocale: en-US\ndefaultLocale: en-US\nlocales: {}\n',
      );
      const candidate = await repairs.registerFailedOpen(root);
      expect(candidate?.recognition).toBe('strong');
      const opened = await repairs.read(candidate!.id);
      expect(opened).toMatchObject({ revision: 'absent', text: '' });
      const manual = 'schema: noveltea.project.workspace\nschemaVersion: 1\n';
      expect((await repairs.save(candidate!.id, 'absent', manual)).text).toBe(manual);
      expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).toBe(manual);
      await expect(repairs.save(candidate!.id, 'absent', 'overwrite')).rejects.toThrow(
        /changed on disk/u,
      );
      expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).toBe(manual);
    });
  });

  it('does not grant a missing-manifest capability from symlinked source collections', async () => {
    await withCandidate(async (root) => {
      const outside = await mkdtemp(path.join(tmpdir(), 'nt-symlink-evidence-'));
      try {
        await mkdir(path.join(outside, 'rooms'), { recursive: true });
        for (const name of ['hall', 'library']) {
          await writeFile(
            path.join(outside, 'rooms', `${name}.yaml`),
            `id: ${name}\nlabel: ${name}\ndata:\n  presentationSpace: {}\n`,
          );
        }
        await symlink(outside, path.join(root, 'records'), 'dir');
        const repairs = new ProjectCandidateRepairService();
        expect(await repairs.registerFailedOpen(root)).toBeNull();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('permits manual inspection of a weak candidate but does not invent a Project', async () => {
    await withCandidate(async (root) => {
      const manifest = path.join(root, 'project.yaml');
      await writeFile(manifest, 'unknown: content\n');
      const repairs = new ProjectCandidateRepairService();
      const candidate = await repairs.registerFailedOpen(root);
      expect(candidate?.recognition).toBe('weak');
      expect((await repairs.read(candidate!.id)).text).toBe('unknown: content\n');
      expect((await repairs.read(candidate!.id)).recognition).toBe('weak');
      // Only explicit source text is writable; no normal Project session exists.
    });
  });

  it('rejects symlink target changes without touching sources outside the candidate', async () => {
    await withCandidate(async (root) => {
      const outside = await mkdtemp(path.join(tmpdir(), 'nt-repair-outside-'));
      try {
        const manifest = path.join(root, 'project.yaml');
        const outsideSource = path.join(outside, 'outside.yaml');
        await writeFile(manifest, 'schema: noveltea.project.workspace\nbroken: [\n');
        await writeFile(outsideSource, 'outside protected\n');
        const repairs = new ProjectCandidateRepairService();
        const candidate = await repairs.registerFailedOpen(root);
        const source = await repairs.read(candidate!.id);
        await unlink(manifest);
        await symlink(outsideSource, manifest);
        await expect(repairs.read(candidate!.id)).rejects.toThrow(/ordinary source file/u);
        await expect(repairs.save(candidate!.id, source.revision, 'attack')).rejects.toThrow(
          /ordinary source file/u,
        );
        expect(await readFile(outsideSource, 'utf8')).toBe('outside protected\n');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('validates opaque candidate tokens, exact revision envelopes and source size before IPC handlers', () => {
    expect(() => readRepairCandidateArgumentsSchema.parse(['../../../etc/passwd'])).toThrow();
    expect(() =>
      saveRepairCandidateArgumentsSchema.parse(['../../../etc/passwd', 'absent', 'x']),
    ).toThrow();
    expect(() =>
      saveRepairCandidateArgumentsSchema.parse([randomUUID(), 'arbitrary', 'x']),
    ).toThrow();
  });
});
