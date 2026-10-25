import { vi } from 'vite-plus/test';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { authoringCollectionKeys } from '../../shared/project-schema/authoring-collections';
import { useCommandStore } from '../commands/command-store';
import { applyJsonPatch, type JsonPatchOperation } from '../project/json-patch';
import { getJsonAtPointer, hasJsonAtPointer, parseJsonPointer } from '../project/json-pointer';
import { toJsonValue, type JsonValue } from '../project/json-value';
import { useProjectStore } from '../project/project-store';
import { nativeLocalizationTarget } from '../commands/native-command-execution';

const defaultSession = '11111111-1111-4111-8111-111111111111';
const recordFamilies = new Set([
  'animations',
  'archetypes',
  'assets',
  'characters',
  'dialogues',
  'interactables',
  'interactions',
  'layouts',
  'maps',
  'materials',
  'rooms',
  'scenes',
  'scripts',
  'tests',
  'variables',
  'verbs',
]);

/** This is a controlled fake *native acknowledgment*, not a TS Workspace
 * writer. Tests of view-level asynchronous commands can exercise the actual
 * proposal/acknowledgment boundary, while real worker/CLI certification
 * verifies native mutation semantics and source generation. */
export function admitNativeRendererCommandFixture(
  project: AuthoringProject,
  session = defaultSession,
) {
  let revision = 0;
  let document: JsonValue = toJsonValue(project);
  const admitted = useProjectStore.getState().loadProjectDocument({
    document,
    savedDocument: document,
    nativeSession: true,
    projectPath: '/mock/project',
    projectFilePath: '/mock/project/project.yaml',
    projectSessionId: session,
  });
  if (!admitted) throw new Error('Test Project was not admitted.');
  useCommandStore.getState().enableNativeCommandMode(revision);

  const acknowledgments = (paths: readonly string[]) => {
    const owners = new Set<string>(['project', 'editor', 'traits']);
    const records: Record<string, { source: JsonValue }> = {};
    for (const owner of ['editor', 'traits']) {
      if (hasJsonAtPointer(document, `/${owner}`))
        records[owner] = { source: getJsonAtPointer(document, `/${owner}`) };
    }
    for (const collection of authoringCollectionKeys) {
      const entries = (document as Record<string, unknown>)[collection];
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
      for (const id of Object.keys(entries)) {
        const owner = `${collection}/${id}`;
        owners.add(owner);
        records[owner] = { source: getJsonAtPointer(document, `/${owner}`) };
      }
    }
    for (const path of paths) {
      const segments = parseJsonPointer(path);
      const collection = segments[0];
      const owner =
        collection === 'localization'
          ? (nativeLocalizationTarget(path)?.owner ?? 'project')
          : collection && recordFamilies.has(collection) && segments.length > 1
            ? `${collection}/${segments[1]}`
            : collection === 'traits' || collection === 'editor'
              ? collection
              : 'project';
      owners.add(owner);
      if (owner === 'project') continue;
      const recordPointer = owner.startsWith('i18n/')
        ? (() => {
            const parts = owner.split('/');
            if (parts[1] === 'locales')
              return `/localization/translations/${parts[2]!.slice(0, -5)}`;
            if (parts[1] === 'assets') return `/localization/assets/${parts[2]!.slice(0, -5)}`;
            if (parts[1] === 'tracking.yaml') return '/localization/sourceMessageTracking';
            if (parts[1] === 'orphans.yaml') return '/localization/orphanedMessages';
            if (parts[1] === 'usage-notes.yaml') return '/localization/usageNotes';
            if (parts[1] === 'messages.yaml') return '/localization';
            return '/localization';
          })()
        : `/${owner}`;
      if (hasJsonAtPointer(document, recordPointer))
        records[owner] = { source: getJsonAtPointer(document, recordPointer) };
    }
    return {
      accepted: true,
      error: '',
      snapshot: {
        workingRevision: revision,
        diskSourceRevision: `sha256:${'0'.repeat(64)}`,
        source: document,
        normalized: document,
        dirty: true,
        valid: true,
        diagnostics: [],
        inventory: [],
        recordSnapshots: records,
      },
      affectedRecords: [...owners],
      diagnosticsAdded: [],
      diagnosticsRemoved: [],
    };
  };

  const patch = vi.fn(async (id: string, expected: number, patches: JsonPatchOperation[]) => {
    if (id !== session || expected !== revision)
      throw new Error('Native fixture received a stale Project revision.');
    document = applyJsonPatch(document, patches).document;
    revision++;
    return acknowledgments(patches.map((item) => item.path));
  });
  const save = vi.fn(
    async (
      id: string,
      expected: number,
      _saveUnits?: string | string[],
      options?: { structuralPathsByOwner?: Record<string, string[]> },
    ) => {
      if (id !== session || expected !== revision)
        throw new Error('Native fixture received a stale Save revision.');
      revision++;
      // A scoped Save without an external disk change acknowledges its transaction
      // but has no reconciled owners. The editor constructs the saved projection
      // from the selected logical Save unit; reporting all owners here would
      // falsely claim unrelated dirty units were externally rewritten.
      const acknowledgement = acknowledgments(['/project']);
      return options?.structuralPathsByOwner
        ? acknowledgement
        : { ...acknowledgement, affectedRecords: [] };
    },
  );
  Object.defineProperty(window.noveltea, 'nativeProjectPatch', {
    configurable: true,
    value: patch,
  });
  Object.defineProperty(window.noveltea, 'nativeProjectSaveUnit', {
    configurable: true,
    value: save,
  });
  return { patch, save, workingRevision: () => revision };
}
