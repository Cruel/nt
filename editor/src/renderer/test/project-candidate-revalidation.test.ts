import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import { ProjectCandidateRepairService } from '../../main/services/project-candidate-repair-service';
import { runNativeValidation } from '../../main/services/native-working-stage-validation';
import type { CandidateRepairStatus } from '../../shared/project-candidate-repair';

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'nt-repair-observe-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const original = 'schema: noveltea.project.workspace\nbroken: [\n';
const corrected = 'schema: noveltea.project.workspace\nschemaVersion: 1\n';

function validator() {
  return vi.fn(async (root: string) => {
    const text = await readFile(path.join(root, 'project.yaml'), 'utf8');
    return {
      success: text === corrected,
      diagnostics:
        text === corrected
          ? []
          : [
              {
                severity: 'error' as const,
                path: '/project.yaml',
                sourcePath: 'project.yaml',
                line: 2,
                column: 1,
                message: 'Invalid manifest',
              },
            ],
    };
  });
}

describe('settled Project Candidate revalidation', () => {
  it('refreshes malformed-source diagnostics after manual Save and never opens a Project automatically', async () => {
    await withRoot(async (root) => {
      await writeFile(path.join(root, 'project.yaml'), original);
      const validate = validator();
      const publish = vi.fn();
      const repairs = new ProjectCandidateRepairService(validate, publish, 40);
      try {
        const { id } = (await repairs.registerFailedOpen(root))!;
        expect((await repairs.observe(id))?.ready).toBe(false);
        const source = await repairs.read(id);
        expect((await repairs.save(id, source.revision, corrected)).text).toBe(corrected);
        await vi.waitFor(
          () => expect(publish.mock.lastCall?.[0]).toMatchObject({ id, ready: true }),
          {
            timeout: 3000,
          },
        );
        const ready = publish.mock.lastCall![0] as CandidateRepairStatus;
        expect(ready.revision).toMatch(/^sha256:/u);
        expect(await repairs.authorizeOpen(id, ready.revision!)).toBe(root);
        expect(validate).toHaveBeenCalledTimes(2);
        // There is no automatic active-Project handoff in the repair observer.
        expect(ready.diagnostics).toEqual([]);
      } finally {
        await repairs.revokeAll();
      }
    });
  });

  it('observes external source repair, settles bursts, and ignores unrelated or generated files', async () => {
    await withRoot(async (root) => {
      await writeFile(path.join(root, 'project.yaml'), original);
      await mkdir(path.join(root, '.noveltea'));
      const validate = validator();
      const publish = vi.fn();
      const repairs = new ProjectCandidateRepairService(validate, publish, 65);
      try {
        const { id } = (await repairs.registerFailedOpen(root))!;
        expect((await repairs.observe(id))?.ready).toBe(false);
        await writeFile(path.join(root, '.noveltea', 'agent-kit.yaml'), 'generated\n');
        await writeFile(path.join(root, 'NOTES.txt'), 'unrelated\n');
        await new Promise((resolve) => setTimeout(resolve, 160));
        expect(validate).toHaveBeenCalledTimes(1);
        for (const text of [original + '# a\n', original + '# b\n', corrected]) {
          await writeFile(path.join(root, 'project.yaml'), text);
        }
        await vi.waitFor(
          () => expect(publish.mock.lastCall?.[0]).toMatchObject({ id, ready: true }),
          { timeout: 3000 },
        );
        expect(validate).toHaveBeenCalledTimes(2);
        await new Promise((resolve) => setTimeout(resolve, 160));
        expect(validate).toHaveBeenCalledTimes(2);
      } finally {
        await repairs.revokeAll();
      }
    });
  });

  it('requires fresh physical proof after readiness, and revokes stale candidate generations', async () => {
    await withRoot(async (root) => {
      await writeFile(path.join(root, 'project.yaml'), corrected);
      const publish = vi.fn();
      const repairs = new ProjectCandidateRepairService(validator(), publish, 50);
      const { id } = (await repairs.registerFailedOpen(root))!;
      const status = (await repairs.observe(id))!;
      expect(status.ready).toBe(true);
      await writeFile(path.join(root, 'project.yaml'), original);
      await expect(repairs.authorizeOpen(id, status.revision!)).rejects.toThrow(
        /changed|not ready/u,
      );
      await vi.waitFor(() => expect(publish.mock.lastCall?.[0].ready).toBe(false), {
        timeout: 3000,
      });
      repairs.close(id);
      await writeFile(path.join(root, 'project.yaml'), corrected);
      await new Promise((resolve) => setTimeout(resolve, 130));
      await expect(repairs.authorizeOpen(id, status.revision!)).rejects.toThrow(/expired/u);
      expect(publish.mock.lastCall![0].ready).toBe(false);
    });
  });

  it('does not publish a late validation from an obsolete candidate tab', async () => {
    await withRoot(async (root) => {
      await writeFile(path.join(root, 'project.yaml'), corrected);
      let release!: (value: { success: boolean; diagnostics: [] }) => void;
      const validate = vi.fn(
        () =>
          new Promise<{ success: boolean; diagnostics: [] }>((resolve) => {
            release = resolve;
          }),
      );
      const publish = vi.fn();
      const repairs = new ProjectCandidateRepairService(validate, publish);
      const { id } = (await repairs.registerFailedOpen(root))!;
      const pending = repairs.observe(id);
      await vi.waitFor(() => expect(validate).toHaveBeenCalledTimes(1));
      repairs.close(id);
      release({ success: true, diagnostics: [] });
      expect(await pending).toBeNull();
      expect(publish).not.toHaveBeenCalled();
    });
  });

  it('freezes candidate writes across overlapping opens and restores the repair session after failure', async () => {
    await withRoot(async (root) => {
      await writeFile(path.join(root, 'project.yaml'), corrected);
      const publish = vi.fn();
      const repairs = new ProjectCandidateRepairService(validator(), publish, 45);
      try {
        const { id } = (await repairs.registerFailedOpen(root))!;
        const ready = (await repairs.observe(id))!;
        expect(ready.ready).toBe(true);
        await repairs.freezeRoot(root);
        await repairs.freezeRoot(root);
        await expect(repairs.authorizeOpen(id, ready.revision!)).rejects.toThrow(
          /already in progress/u,
        );
        await expect(repairs.save(id, (await repairs.read(id)).revision, original)).rejects.toThrow(
          /opening/u,
        );
        await repairs.thawRoot(root);
        await expect(repairs.authorizeOpen(id, ready.revision!)).rejects.toThrow(
          /already in progress/u,
        );
        await repairs.thawRoot(root);
        await vi.waitFor(() => expect(publish.mock.lastCall?.[0]?.ready).toBe(true));
        expect(await repairs.authorizeOpen(id, ready.revision!)).toBe(root);
      } finally {
        await repairs.revokeAll();
      }
    });
  });

  it.skipIf(!process.env.NOVELTEA_CLI)(
    'uses real native read-only diagnostics until the corrected source is admissible',
    async () => {
      await withRoot(async (root) => {
        await cp(path.resolve(process.cwd(), '../tests/projects/feature-lab'), root, {
          recursive: true,
          filter: (source) => !source.split(path.sep).includes('.noveltea'),
        });
        const manifest = path.join(root, 'project.yaml');
        const valid = await readFile(manifest, 'utf8');
        await writeFile(
          manifest,
          valid.replace(
            'schema: noveltea.project.workspace',
            'schema: noveltea.project.workspace\nbroken: [',
          ),
        );
        const statusEvents: CandidateRepairStatus[] = [];
        const repairs = new ProjectCandidateRepairService(
          runNativeValidation,
          (status) => {
            statusEvents.push(status);
          },
          60,
        );
        try {
          const { id } = (await repairs.registerFailedOpen(root))!;
          const bad = (await repairs.observe(id))!;
          expect(bad.ready).toBe(false);
          expect(bad.diagnostics.some((d) => d.sourcePath === 'project.yaml')).toBe(true);
          const source = await repairs.read(id);
          await repairs.save(id, source.revision, valid);
          await vi.waitFor(() => expect(statusEvents.at(-1)?.ready).toBe(true), {
            timeout: 45000,
            interval: 100,
          });
          expect(await repairs.authorizeOpen(id, statusEvents.at(-1)!.revision!)).toBe(root);
        } finally {
          await repairs.revokeAll();
        }
      });
    },
    90_000,
  );
});
