import { createHash, randomUUID } from 'node:crypto';
import { constants, watch, type FSWatcher } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LineCounter, parse, parseDocument } from 'yaml';
import type { ToolDiagnostic } from '../../shared/editor-tooling';
import type {
  CandidateRepairSource,
  CandidateRepairStatus,
} from '../../shared/project-candidate-repair';
import { runNativeValidation } from './native-working-stage-validation';

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

function ordinaryObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function yamlObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = parse(text, { uniqueKeys: true });
    return ordinaryObject(value) ? value : null;
  } catch {
    return null;
  }
}

async function safeText(file: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return null;
    const handle = await fs.open(file, readFlags);
    try {
      if (!(await handle.stat()).isFile()) return null;
      return new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile());
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function ordinaryDirectory(directory: string): Promise<boolean> {
  try {
    return (await fs.lstat(directory)).isDirectory();
  } catch {
    return false;
  }
}

const signatures: Record<string, string> = {
  animations: 'motions',
  archetypes: 'instanceKind',
  assets: 'source',
  characters: 'profiles',
  dialogues: 'blocks',
  interactables: 'presentation',
  interactions: 'rules',
  layouts: 'source',
  materials: 'base',
  rooms: 'presentationSpace',
  scenes: 'events',
  scripts: 'source',
  tests: 'steps',
  variables: 'type',
  verbs: 'slots',
};

/** Read-only counterpart to the native repair project's evidence rules. This
 * only establishes whether a missing manifest is safe to offer for manual
 * creation; it does not admit, parse or normalize a Project. */
async function candidateRecognition(
  root: string,
  manifest: string | null,
): Promise<'strong' | 'weak' | 'none'> {
  if (manifest !== null) {
    const parsed = yamlObject(manifest);
    if (parsed?.schema === 'noveltea.project.workspace') return 'strong';
    const discriminators = manifest
      .replace(/^\uFEFF/u, '')
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('schema:'));
    if (
      discriminators.length === 1 &&
      /^schema: ['"]?noveltea\.project\.workspace['"]?(?:\s+#.*)?\s*$/u.test(discriminators[0]!)
    )
      return 'strong';
  }

  const agents = await safeText(path.join(root, 'AGENTS.md'));
  if (agents) {
    const start = '<!-- noveltea:managed-agent-bootstrap:start -->';
    const end = '<!-- noveltea:managed-agent-bootstrap:end -->';
    if (
      agents.split(start).length === 2 &&
      agents.split(end).length === 2 &&
      agents.indexOf(start) < agents.indexOf(end) &&
      /noveltea agent sync|\.noveltea\/agent\/GUIDE\.md/u.test(
        agents.slice(agents.indexOf(start), agents.indexOf(end)),
      )
    )
      return 'strong';
  }

  let evidence = 0;
  for (const [file, kind] of [
    ['i18n/project.yaml', 'i18n'],
    ['editor.yaml', 'editor'],
    ['traits.yaml', 'traits'],
  ] as const) {
    // Match native inspect_repair_candidate: symlinked context directories
    // cannot establish evidence for the selected Project root.
    if (kind === 'i18n' && !(await ordinaryDirectory(path.join(root, 'i18n')))) continue;
    const text = await safeText(path.join(root, file));
    const value = text !== null ? yamlObject(text) : null;
    if (!value) continue;
    if (
      kind === 'i18n' &&
      typeof value.sourceLocale === 'string' &&
      typeof value.defaultLocale === 'string' &&
      ordinaryObject(value.locales)
    )
      evidence++;
    if (
      kind === 'editor' &&
      ordinaryObject(value.chapters) &&
      ordinaryObject(value.tags) &&
      ordinaryObject(value.recordMetadata)
    )
      evidence++;
    if (
      kind === 'traits' &&
      Object.entries(value).some(
        ([id, trait]) =>
          ordinaryObject(trait) &&
          trait.id === id &&
          Array.isArray(trait.ownerKinds) &&
          Array.isArray(trait.properties),
      )
    )
      evidence++;
    if (evidence >= 2) return 'strong';
  }
  if (!(await ordinaryDirectory(path.join(root, 'records'))))
    return manifest !== null ? 'weak' : 'none';
  for (const [collection, signature] of Object.entries(signatures)) {
    const folder = path.join(root, 'records', collection);
    if (!(await ordinaryDirectory(folder))) continue;
    let entries: string[];
    try {
      entries = await fs.readdir(folder);
    } catch {
      continue;
    }
    for (const filename of entries.sort()) {
      if (!/^[a-z0-9-]+\.yaml$/u.test(filename)) continue;
      const text = await safeText(path.join(folder, filename));
      const record = text !== null ? yamlObject(text) : null;
      if (
        !record ||
        record.id !== filename.slice(0, -5) ||
        typeof record.label !== 'string' ||
        !ordinaryObject(record.data) ||
        !(signature in record.data)
      )
        continue;
      if (++evidence >= 2) return 'strong';
    }
  }
  return manifest !== null ? 'weak' : 'none';
}

function revision(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

interface CandidateSession {
  id: string;
  root: string;
  manifestPath: string;
  recognition: 'strong' | 'weak';
  rootDev: number;
  rootIno: number;
  generation: number;
  openingCount: number;
  observationError?: string;
  watcher?: FSWatcher;
  timer?: ReturnType<typeof setTimeout>;
  checking?: Promise<CandidateRepairStatus | null>;
  status?: CandidateRepairStatus;
  checkedFingerprint?: string;
  lastValidated?: CandidateRepairStatus;
  saves: Set<Promise<unknown>>;
}

type NativeCheck = (root: string) => Promise<{
  success: boolean;
  diagnostics: ToolDiagnostic[];
}>;

// Only Project-owned source paths are admission inputs; generated Agent Kit,
// VCS, and unrelated files must not cause native validation loops.
const trackedDirectories = new Set([
  'records',
  'i18n',
  'assets',
  'scripts',
  'shaders',
  'layouts',
  'workflows',
  'support',
  'supporting',
]);
const trackedRootFiles = new Set(['project.yaml', 'editor.yaml', 'traits.yaml']);

function trackedCandidatePath(relative: string): boolean {
  const parts = relative.replaceAll('\\', '/').split('/');
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..')) return false;
  return parts.length === 1 ? trackedRootFiles.has(parts[0]!) : trackedDirectories.has(parts[0]!);
}

async function candidateSourceFingerprint(root: string): Promise<string> {
  const digest = createHash('sha256');
  const visit = async (directory: string, relative = ''): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (!trackedCandidatePath(child) && !trackedDirectories.has(child)) continue;
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      digest.update(child).update('\0');
      if (stat.isDirectory()) {
        digest.update('dir\0');
        await visit(absolute, child);
      } else if (stat.isFile()) {
        digest.update('file\0');
        // No-follow on the opened descriptor protects this read-only proof
        // from a concurrent path replacement by an external symlink.
        const handle = await fs.open(absolute, readFlags);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
            throw new Error('Candidate source changed during revision inspection.');
          for await (const bytes of handle.createReadStream({ autoClose: false }))
            digest.update(bytes);
        } finally {
          await handle.close();
        }
      } else {
        // Do not follow Project symlinks to fingerprint data outside the root.
        digest.update('other\0');
      }
      digest.update('\0');
    }
  };
  await visit(root);
  return `sha256:${digest.digest('hex')}`;
}

/** The native Open error remains authoritative; the original YAML parser
 * positions are supplemental, source-local diagnostics for manual repair. */
export function candidateManifestSyntaxDiagnostics(text: string): ToolDiagnostic[] {
  const lines = new LineCounter();
  const parsed = parseDocument(text, { lineCounter: lines, uniqueKeys: true });
  return parsed.errors.map((error) => {
    const position = lines.linePos(error.pos[0]);
    return {
      severity: 'error' as const,
      path: '/project.yaml',
      sourcePath: 'project.yaml',
      line: position.line,
      column: position.col,
      category: 'Project source syntax',
      message: error.message,
    };
  });
}

export class ProjectCandidateRepairService {
  private readonly sessions = new Map<string, CandidateSession>();

  constructor(
    private readonly validate: NativeCheck = runNativeValidation,
    private readonly publish: (status: CandidateRepairStatus) => void = () => undefined,
    private readonly settleMs = 250,
  ) {}

  private async forRoot(root: string): Promise<CandidateSession[]> {
    const canonical = await fs.realpath(root).catch(() => path.resolve(root));
    return [...this.sessions.values()].filter((session) => session.root === canonical);
  }

  async freezeRoot(root: string): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const session of await this.forRoot(root)) {
      session.openingCount++;
      this.schedule(session);
      pending.push(...session.saves);
    }
    // Candidate writes must settle before the native handoff may admit
    // physical sources; failed admission will unfreeze the original buffers.
    await Promise.allSettled(pending);
  }

  async thawRoot(root: string): Promise<void> {
    for (const session of await this.forRoot(root)) {
      if (session.openingCount > 0) {
        session.openingCount--;
        if (session.openingCount === 0) this.schedule(session);
      }
    }
  }

  async revokeRoot(root: string): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const session of await this.forRoot(root)) {
      this.close(session.id);
      pending.push(...session.saves);
    }
    await Promise.allSettled(pending);
  }

  async revokeAll(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const [id, session] of this.sessions) {
      this.close(id);
      pending.push(...session.saves);
    }
    await Promise.allSettled(pending);
  }

  async registerFailedOpen(
    requestedRoot: string,
  ): Promise<{ id: string; recognition: 'strong' | 'weak' } | null> {
    const selected = path.resolve(requestedRoot);
    const selectedStat = await fs.stat(selected);
    const root = await fs.realpath(selectedStat.isDirectory() ? selected : path.dirname(selected));
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory()) return null;
    const manifestPath = path.join(root, 'project.yaml');
    const manifest = await safeText(manifestPath);
    // A symlink or non-regular file is never a writable source candidate.
    const kind = await fs.lstat(manifestPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (kind && !kind.isFile()) return null;
    const recognition = await candidateRecognition(root, manifest);
    if (recognition === 'none') return null;
    for (const [id, existing] of this.sessions) {
      if (existing.root === root) {
        existing.recognition = recognition;
        return { id, recognition };
      }
    }
    const id = randomUUID();
    this.sessions.set(id, {
      id,
      root,
      manifestPath,
      recognition,
      rootDev: rootStat.dev,
      rootIno: rootStat.ino,
      generation: 0,
      openingCount: 0,
      saves: new Set(),
    });
    return { id, recognition };
  }

  close(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.generation++;
    if (session.timer) clearTimeout(session.timer);
    session.watcher?.close();
    this.sessions.delete(id);
  }

  private schedule(session: CandidateSession): void {
    if (this.sessions.get(session.id) !== session) return;
    session.generation++;
    // A previously verified ready state is no longer a valid Open permission.
    if (session.status?.ready) {
      session.status = {
        ...session.status,
        generation: session.generation,
        ready: false,
        revision: null,
      };
      this.publish(session.status);
    }
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      session.timer = undefined;
      void this.revalidate(session.id).catch(() => undefined);
    }, this.settleMs);
  }

  async observe(id: string): Promise<CandidateRepairStatus | null> {
    const session = this.require(id);
    await this.assertRoot(session);
    if (!session.watcher) {
      session.watcher = watch(session.root, { recursive: true }, (_event, filename) => {
        if (filename && !trackedCandidatePath(filename.toString())) return;
        this.schedule(session);
      });
      session.watcher.on('error', () => {
        session.watcher?.close();
        session.watcher = undefined;
        session.observationError =
          'The Project Candidate watcher stopped. Restart observation before opening.';
        this.schedule(session);
      });
      session.observationError = undefined;
    }
    return this.revalidate(id);
  }

  async revalidate(id: string): Promise<CandidateRepairStatus | null> {
    const session = this.require(id);
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = undefined;
    }
    if (session.checking) {
      await session.checking;
      if (this.sessions.get(id) !== session) return null;
      return this.revalidate(id);
    }
    if (session.openingCount > 0) return null;
    const generation = session.generation;
    const run = async (): Promise<CandidateRepairStatus | null> => {
      let fingerprint: string | undefined;
      let diagnostics: ToolDiagnostic[];
      let ready = false;
      let verified = false;
      try {
        if (session.observationError) throw new Error(session.observationError);
        await this.assertRoot(session);
        fingerprint = await candidateSourceFingerprint(session.root);
        if (fingerprint === session.checkedFingerprint && session.lastValidated) {
          const status = { ...session.lastValidated, generation };
          if (this.sessions.get(id) === session && session.generation === generation) {
            session.status = status;
            this.publish(status);
          }
          return status;
        }
        const outcome = await this.validate(session.root);
        const source = await this.read(id);
        diagnostics = [...candidateManifestSyntaxDiagnostics(source.text), ...outcome.diagnostics];
        ready = outcome.success && diagnostics.every((item) => item.severity !== 'error');
        // Do not publish readiness for an intermediate write or a replaced root.
        await this.assertRoot(session);
        const after = await candidateSourceFingerprint(session.root);
        if (after !== fingerprint) {
          this.schedule(session);
          return null;
        }
        verified = true;
      } catch (error) {
        diagnostics = [
          {
            severity: 'error',
            path: '/project.yaml',
            sourcePath: 'project.yaml',
            message: error instanceof Error ? error.message : String(error),
          },
        ];
      }
      if (
        this.sessions.get(id) !== session ||
        session.generation !== generation ||
        session.openingCount > 0
      )
        return null;
      const status: CandidateRepairStatus = {
        id,
        generation,
        ready,
        revision: ready ? (fingerprint ?? null) : null,
        diagnostics,
      };
      session.checkedFingerprint = verified ? fingerprint : undefined;
      session.lastValidated = verified ? status : undefined;
      session.status = status;
      this.publish(status);
      return status;
    };
    const promise = run();
    session.checking = promise;
    try {
      return await promise;
    } finally {
      if (session.checking === promise) session.checking = undefined;
    }
  }

  async authorizeOpen(id: string, expectedRevision: string): Promise<string> {
    const session = this.require(id);
    if (session.openingCount > 0)
      throw new Error('Project Candidate admission is already in progress.');
    const status = session.status;
    if (!status?.ready || status.revision !== expectedRevision)
      throw new Error('The repaired Project is not ready. Review the current diagnostics.');
    const generation = session.generation;
    await this.assertRoot(session);
    if (
      this.sessions.get(id) !== session ||
      generation !== session.generation ||
      (await candidateSourceFingerprint(session.root)) !== expectedRevision
    ) {
      this.schedule(session);
      throw new Error('The candidate sources changed since admission. Revalidate before opening.');
    }
    return session.root;
  }

  async authorizeRun(id: string): Promise<{ root: string; recognition: 'strong' | 'weak' }> {
    const session = this.require(id);
    if (session.openingCount > 0)
      throw new Error('Project Candidate admission is in progress. Try again after it finishes.');
    await this.assertRoot(session);
    if (this.sessions.get(id) !== session)
      throw new Error('Project Candidate repair permission expired. Reopen the candidate.');
    return { root: session.root, recognition: session.recognition };
  }

  private require(id: string): CandidateSession {
    const session = this.sessions.get(id);
    if (!session)
      throw new Error('Repair session expired. Reopen the Project Candidate to repair it.');
    return session;
  }

  private async assertRoot(session: CandidateSession): Promise<void> {
    const current = await fs.lstat(session.root);
    if (
      !current.isDirectory() ||
      current.dev !== session.rootDev ||
      current.ino !== session.rootIno ||
      (await fs.realpath(session.root)) !== session.root
    )
      throw new Error('Project Candidate root changed. Reopen the Project before editing source.');
  }

  async read(id: string): Promise<CandidateRepairSource> {
    const session = this.require(id);
    await this.assertRoot(session);
    const kind = await fs.lstat(session.manifestPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (kind && (!kind.isFile() || kind.size > MAX_SOURCE_BYTES))
      throw new Error(
        'The manifest is not an ordinary source file or exceeds the repair size limit.',
      );
    if (!kind) {
      if (session.recognition !== 'strong')
        throw new Error('A missing manifest requires strong NovelTea candidate evidence.');
      return {
        root: session.root,
        sourcePath: 'project.yaml',
        text: '',
        revision: 'absent',
        recognition: session.recognition,
      };
    }
    const handle = await fs.open(session.manifestPath, readFlags);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== kind.dev || opened.ino !== kind.ino)
        throw new Error('Manifest target changed during source inspection. Reload before editing.');
      const bytes = await handle.readFile();
      if (bytes.length > MAX_SOURCE_BYTES)
        throw new Error('Manifest exceeds the repair size limit.');
      return {
        root: session.root,
        sourcePath: 'project.yaml',
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        revision: revision(bytes),
        recognition: session.recognition,
      };
    } finally {
      await handle.close();
    }
  }

  async save(id: string, expectedRevision: string, text: string): Promise<CandidateRepairSource> {
    const session = this.require(id);
    if (session.openingCount > 0)
      throw new Error('Project Candidate is opening. Complete admission before editing.');
    const generation = session.generation;
    const operation = this.saveSource(session, generation, id, expectedRevision, text);
    session.saves.add(operation);
    try {
      return await operation;
    } finally {
      session.saves.delete(operation);
    }
  }

  private async saveSource(
    session: CandidateSession,
    generation: number,
    id: string,
    expectedRevision: string,
    text: string,
  ): Promise<CandidateRepairSource> {
    await this.assertRoot(session);
    if (Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES)
      throw new Error('Manifest exceeds the repair size limit.');
    if (expectedRevision !== 'absent' && !/^sha256:[0-9a-f]{64}$/u.test(expectedRevision))
      throw new Error('Invalid candidate source revision. Reload and try again.');
    const before = await this.read(id);
    if (before.revision !== expectedRevision)
      throw new Error(
        'Manifest changed on disk. Copy your edits and inspect the disk version before saving.',
      );
    const staged = `${session.manifestPath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(staged, text, { flag: 'wx', mode: 0o600 });
      const existing = await fs
        .lstat(session.manifestPath)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
      if (existing?.isFile()) await fs.chmod(staged, existing.mode & 0o777);
      const current = await this.read(id);
      if (current.revision !== expectedRevision)
        throw new Error('Manifest changed during Save. Your repair buffer was not discarded.');
      if (
        this.sessions.get(id) !== session ||
        session.generation !== generation ||
        session.openingCount > 0
      )
        throw new Error('Repair capability expired during Save. No candidate write was committed.');
      if (expectedRevision === 'absent') {
        // Exclusive hard-link creation refuses an intervening manifest without
        // replacing it, even when another process creates it during Save.
        await fs.link(staged, session.manifestPath);
        await fs.unlink(staged);
      } else {
        await fs.rename(staged, session.manifestPath);
      }
      const source = await this.read(id);
      this.schedule(session);
      return source;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error(
          'Manifest was created outside NovelTea. Reload the disk version before saving.',
        );
      throw error;
    } finally {
      await fs.rm(staged, { force: true }).catch(() => undefined);
    }
  }
}
