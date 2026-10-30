import type { NativeAuthoringPatchResult } from '../../main/services/native-authoring-worker-contract';
import type {
  EditorRecoveryExternalConflict,
  EditorRecoveryState,
} from '../../shared/project-schema/editor-project-state';
import { stripLocalEditorProjectState } from '../../shared/project-schema/editor-project-state';
import { applyJsonPatch, type JsonPatchOperation } from './json-patch';
import { getJsonAtPointer, hasJsonAtPointer, type JsonPointer } from './json-pointer';
import { cloneJsonValue, type JsonValue } from './json-value';
import { diffJsonDocuments } from './project-external-reconciliation';
import { rebaseRecoveryOverlays } from './project-recovery-rebase';
import { isAuthoringCollectionKey } from '../../shared/project-schema/authoring-collections';

type Source = {
  source: unknown;
  baseline?: unknown;
  normalized?: unknown;
  dirty?: boolean;
  diskSourceRevision: string;
  conflictingPaths?: string[];
};

export function nativeExternalOwnerPath(owner: string): string {
  if (owner === 'project') return '';
  if (owner === 'editor' || owner === 'traits') return `/${owner}`;
  const localized = /^i18n\/(locales|assets)\/([^/]+)\.yaml$/.exec(owner);
  if (localized)
    return `/localization/${localized[1] === 'locales' ? 'translations' : 'assets'}/${localized[2]}`;
  const localizedRoots: Record<string, string> = {
    'i18n/project.yaml': '/localization',
    'i18n/messages.yaml': '/localization',
    'i18n/usage-notes.yaml': '/localization/usageNotes',
    'i18n/tracking.yaml': '/localization/sourceMessageTracking',
    'i18n/orphans.yaml': '/localization/orphanedMessages',
  };
  return localizedRoots[owner] ?? `/${owner}`;
}

const localizationFileRoots: Record<string, readonly string[]> = {
  'i18n/project.yaml': ['sourceLocale', 'sourceLocaleLock', 'defaultLocale', 'locales'],
  'i18n/messages.yaml': ['messages', 'structuredMessageIds'],
};

/** The watcher supplies hints, never disk values. The native worker verifies
 * the actual bytes when each owner is reconciled. */
export function nativeOwnersForChangedSources(paths: readonly string[]): string[] {
  const owners = new Set<string>();
  for (const path of paths) {
    if (path === 'project.yaml') owners.add('project');
    else if (path === 'editor.yaml') owners.add('editor');
    else if (path === 'traits.yaml') owners.add('traits');
    else if (/^i18n\/(?:project|messages|usage-notes|tracking|orphans)\.yaml$/.test(path))
      owners.add(path);
    else if (/^i18n\/(?:locales|assets)\/[^/]+\.yaml$/.test(path)) owners.add(path);
    else {
      const layout = /^records\/layouts\/([^/]+)\/layout\.yaml$/.exec(path);
      const record = /^records\/([^/]+)\/([^/]+)\.yaml$/.exec(path);
      if (layout) owners.add(`layouts/${layout[1]}`);
      else if (record) owners.add(`${record[1]}/${record[2]}`);
    }
  }
  return [...owners].sort();
}

function diskPath(owner: string): string {
  if (owner === 'project' || owner === 'editor' || owner === 'traits') return `${owner}.yaml`;
  if (owner.startsWith('i18n/')) return owner;
  if (owner.startsWith('layouts/')) return `records/${owner}/layout.yaml`;
  return `records/${owner}.yaml`;
}

function fieldPath(owner: string, relative: string): JsonPointer {
  const prefix = nativeExternalOwnerPath(owner);
  if (!prefix) return relative as JsonPointer;
  if (relative === '/' || relative === '') return prefix as JsonPointer;
  return `${prefix}${relative}` as JsonPointer;
}

function optional(document: JsonValue, path: JsonPointer) {
  return hasJsonAtPointer(document, path)
    ? ({ exists: true, value: cloneJsonValue(getJsonAtPointer(document, path)) } as const)
    : ({ exists: false } as const);
}

function applySource(document: JsonValue, owner: string, source: unknown): JsonValue {
  if (owner === 'editor' && source && typeof source === 'object' && !Array.isArray(source)) {
    // editor.yaml holds tracked organization, not the local-state schema
    // marker. Retain that marker so editor-state hydration cannot discard
    // externally updated chapters, tags or record metadata.
    const schema = hasJsonAtPointer(document, '/editor/schema')
      ? getJsonAtPointer(document, '/editor/schema')
      : undefined;
    return applyAtPath(document, '/editor', {
      ...(schema === undefined ? {} : { schema }),
      ...source,
    });
  }
  const localizedSingleFiles: Record<string, string> = {
    'i18n/usage-notes.yaml': '/localization/usageNotes',
    'i18n/tracking.yaml': '/localization/sourceMessageTracking',
    'i18n/orphans.yaml': '/localization/orphanedMessages',
  };
  if (localizedSingleFiles[owner])
    return applyAtPath(document, localizedSingleFiles[owner], source);
  const localizationKeys = localizationFileRoots[owner];
  if (localizationKeys) {
    if (
      source !== undefined &&
      source !== null &&
      (typeof source !== 'object' || Array.isArray(source))
    )
      throw new Error(`Native ${owner} is not an object.`);
    let next = document;
    const fields = (source ?? {}) as Record<string, unknown>;
    // One physical i18n fragment only owns the keys in its contract; it must
    // never replace the entire logical localization tree.
    for (const key of localizationKeys) {
      const path = `/localization/${key}`;
      if (Object.hasOwn(fields, key)) next = applyAtPath(next, path, fields[key]);
      else if (hasJsonAtPointer(next, path))
        next = applyJsonPatch(next, [{ op: 'remove', path }]).document;
    }
    return next;
  }
  const root = nativeExternalOwnerPath(owner);
  if (!root) {
    if (!source || typeof source !== 'object' || Array.isArray(source))
      throw new Error('Native manifest projection is not an object.');
    let next = document;
    for (const [key, value] of Object.entries(source)) next = applySource(next, key, value);
    return next;
  }
  return applyAtPath(document, root, source);
}

function applyAtPath(document: JsonValue, root: string, source: unknown): JsonValue {
  if (source === undefined || source === null) {
    if (!hasJsonAtPointer(document, root)) return document;
    return applyJsonPatch(document, [{ op: 'remove', path: root }]).document;
  }
  const operation: JsonPatchOperation = hasJsonAtPointer(document, root)
    ? { op: 'replace', path: root, value: cloneJsonValue(source as JsonValue) }
    : { op: 'add', path: root, value: cloneJsonValue(source as JsonValue) };
  return applyJsonPatch(document, [operation]).document;
}

function unitForPath(path: string): string {
  const segments = path.split('/');
  if (segments[1] === 'editor') {
    if (segments[2] === 'chapters') return 'project:chapters';
    if (segments[2] === 'tags') return 'project:tags';
    if (segments[2] === 'recordMetadata' && segments[3] && segments[4])
      return `record:${segments[3]}:${segments[4]}`;
    return 'project:explorer-options';
  }
  if (segments[1] === 'localization') return 'project:localization';
  if (segments[1] === 'traits') return 'collection:traits';
  if (segments[1] === 'export') return 'project:platform-export-profiles';
  if (segments.length > 2 && segments[1] && segments[2] && isAuthoringCollectionKey(segments[1]))
    return `record:${segments[1]}:${segments[2]}`;
  return 'project:settings';
}

/** No TypeScript three-way merge occurs here. Both projections are copied from
 * the worker's independently verified working and disk-side owner snapshots. */
export function projectNativeExternalResult(input: {
  saved: JsonValue;
  working: JsonValue;
  recovery: EditorRecoveryState;
  result: NativeAuthoringPatchResult;
}): {
  saved: JsonValue;
  working: JsonValue;
  recovery: EditorRecoveryState;
  affectedPaths: JsonPointer[];
  conflictingUnitIds: string[];
} {
  const previousSaved = stripLocalEditorProjectState(input.saved) as JsonValue;
  let saved = cloneJsonValue(previousSaved);
  let working = cloneJsonValue(stripLocalEditorProjectState(input.working) as JsonValue);
  const nativeConflicts: Array<{ owner: string; paths: JsonPointer[]; revision: string }> = [];
  for (const owner of input.result.affectedRecords) {
    const state: Source | undefined =
      owner === 'project' ? input.result.snapshot : input.result.snapshot.recordSnapshots?.[owner];
    if (state && state.baseline === undefined)
      throw new Error(`Native ${owner} reconciliation omitted its saved baseline.`);
    // The native Room/record source is sparse YAML. Renderer editors and
    // focused previews require its normalized native effective value instead;
    // replacing a Room with source would erase its inferred data.kind.
    const recordOwner = isAuthoringCollectionKey(owner.split('/')[0] ?? '');
    const effective = recordOwner && state?.normalized != null ? state.normalized : state?.source;
    saved = applySource(
      saved,
      owner,
      recordOwner && state?.dirty === false && state.normalized != null
        ? state.normalized
        : state?.baseline,
    );
    working = applySource(working, owner, effective);
    if (state?.conflictingPaths?.length)
      nativeConflicts.push({
        owner,
        paths: state.conflictingPaths.map((path) => fieldPath(owner, path)),
        revision: state.diskSourceRevision,
      });
  }
  const affectedPaths = diffJsonDocuments(previousSaved, saved).map((patch) => patch.path);
  const recovery = rebaseRecoveryOverlays(input.recovery, saved, working, new Set());
  const saveUnitsById = { ...recovery.saveUnitsById };
  const conflicts = new Map<string, EditorRecoveryExternalConflict>();
  for (const conflict of nativeConflicts) {
    for (const path of conflict.paths) {
      const matching = Object.entries(saveUnitsById).find(([, entry]) =>
        entry.affectedPaths.some(
          (affected) =>
            path === affected || path.startsWith(`${affected}/`) || affected.startsWith(`${path}/`),
        ),
      );
      const unit = matching?.[0] ?? unitForPath(path);
      const previous = conflicts.get(unit) ?? saveUnitsById[unit]?.externalConflict;
      const baseValueByPath = {
        ...previous?.baseValueByPath,
        [path]: optional(previousSaved, path),
      };
      const localValueByPath = { ...previous?.localValueByPath, [path]: optional(working, path) };
      const externalValueByPath = {
        ...previous?.externalValueByPath,
        [path]: optional(saved, path),
      };
      const newConflict: EditorRecoveryExternalConflict = {
        baseValueByPath,
        localValueByPath,
        externalValueByPath,
        conflictingPaths: [...new Set([...(previous?.conflictingPaths ?? []), path])].sort(),
        externalFileRevisions: {
          ...previous?.externalFileRevisions,
          [diskPath(conflict.owner)]: conflict.revision as `sha256:${string}` | 'absent',
        },
      };
      conflicts.set(unit, newConflict);
      const existing = saveUnitsById[unit];
      saveUnitsById[unit] = existing
        ? { ...existing, externalConflict: newConflict }
        : {
            sequence: recovery.sequence + 1,
            patches: [],
            affectedPaths: [path],
            pendingRawInputByPath: {},
            atomicTransactionGroupIds: [],
            externalConflict: newConflict,
          };
    }
  }
  // A subsequent native reconciliation can clear an overlap without any local
  // discard. Never retain a renderer-only conflict after native has resolved it.
  for (const [unit, entry] of Object.entries(saveUnitsById)) {
    if (!entry.externalConflict || conflicts.has(unit)) continue;
    if (
      input.result.affectedRecords.some((owner) =>
        entry.externalConflict!.conflictingPaths.some(
          (path) =>
            path === nativeExternalOwnerPath(owner) ||
            path.startsWith(`${nativeExternalOwnerPath(owner)}/`),
        ),
      )
    ) {
      const { externalConflict: _old, ...withoutConflict } = entry;
      if (
        !withoutConflict.patches.length &&
        !Object.keys(withoutConflict.pendingRawInputByPath).length
      )
        delete saveUnitsById[unit];
      else saveUnitsById[unit] = withoutConflict;
    }
  }
  return {
    saved,
    working,
    recovery: { ...recovery, saveUnitsById },
    affectedPaths: [
      ...new Set([
        ...affectedPaths,
        ...diffJsonDocuments(stripLocalEditorProjectState(input.working) as JsonValue, working).map(
          (patch) => patch.path,
        ),
      ]),
    ].sort(),
    conflictingUnitIds: Object.keys(saveUnitsById)
      .filter((id) => saveUnitsById[id]?.externalConflict)
      .sort(),
  };
}
