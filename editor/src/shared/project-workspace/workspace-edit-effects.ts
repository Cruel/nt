import { recordContributionKey } from '../authoring-dependency-graph';
import type { AuthoringDependencyGraphContributionSet } from '../authoring-dependency-contracts';
import { parseAssetData } from '../project-schema/authoring-assets';
import { escapeJsonPointerSegment, type JsonPointer } from '../json-pointer';
import {
  isAuthoringCollectionKey,
  type AuthoringCollectionKey,
} from '../project-schema/authoring-collections';
import { classifyAuthoringGraphInputPath } from '../project-schema/authoring-graph-field-metadata';
import type { AuthoringProject } from '../project-schema/authoring-project';

const MESSAGES = 'i18n/messages.yaml';
const POLICY = 'i18n/project.yaml';
const TRACKING = 'i18n/tracking.yaml';
const ORPHANS = 'i18n/orphans.yaml';
const NOTES = 'i18n/usage-notes.yaml';
const phases = ['references', 'identities', 'translations'] as const;
type LocalizationPhase = (typeof phases)[number];
interface RecordEdit {
  readonly collection: AuthoringCollectionKey;
  readonly id: string;
  readonly presentationOnly: boolean;
  readonly unchanged: boolean;
}

export interface WorkspaceEditEffects {
  readonly semanticInputsUnchanged: boolean;
  readonly projectNameOnly: boolean;
  readonly presentationRecords: readonly RecordEdit[] | null;
  readonly localizationPhases: readonly LocalizationPhase[];
  readonly coverageInputsChanged: boolean;
  readonly membershipChanged: boolean;
  readonly graph:
    | { readonly kind: 'contributions'; readonly keys: ReadonlySet<string> }
    | { readonly kind: 'sources' | 'impact' };
}

const equal = (before: unknown, after: unknown) => JSON.stringify(before) === JSON.stringify(after);
const membershipChanged = (
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
) => {
  const ids = Object.keys(before);
  return ids.length !== Object.keys(after).length || ids.some((id) => !Object.hasOwn(after, id));
};

function recordEdit(
  before: AuthoringProject,
  after: AuthoringProject,
  path: string,
): RecordEdit | null {
  const match = /^records\/([^/]+)\/([^/]+)(?:\.yaml|\/layout\.yaml)$/u.exec(path);
  if (!match || !isAuthoringCollectionKey(match[1]!)) return null;
  const collection = match[1];
  const id = match[2]!;
  const previous = before[collection][id];
  const current = after[collection][id];
  if (!previous || !current) return null;
  const { label: _beforeLabel, description: _beforeDescription, ...oldSemantic } = previous;
  const { label: _afterLabel, description: _afterDescription, ...newSemantic } = current;
  return {
    collection,
    id,
    presentationOnly: equal(oldSemantic, newSemantic),
    unchanged: equal(previous, current),
  };
}

/** Non-localizing Layout edits share one proof across semantic and coverage consumers. */
function layoutSourceIsNonLocalizing(
  before: AuthoringProject,
  after: AuthoringProject,
  path: string,
): boolean {
  if (/^records\/layouts\/[^/]+\/layout\.rcss$/u.test(path)) return true;
  const match = /^records\/layouts\/([^/]+)\/layout\.(rml|lua)$/u.exec(path);
  if (!match) return false;
  const previous = before.layouts[match[1]!]?.data;
  const current = after.layouts[match[1]!]?.data;
  if (!previous || !current) return false;
  if (match[2] === 'rml')
    return (
      previous.rml.sourceMode === 'inline' &&
      current.rml.sourceMode === 'inline' &&
      !previous.rml.sourceText.toLowerCase().includes('<nt-tr') &&
      !current.rml.sourceText.toLowerCase().includes('<nt-tr')
    );
  return (
    previous.lua.sourceMode === 'inline' &&
    current.lua.sourceMode === 'inline' &&
    !previous.lua.sourceText.includes('Text') &&
    !current.lua.sourceText.includes('Text')
  );
}

function projectNameOnly(before: AuthoringProject, after: AuthoringProject): boolean {
  return (
    before.project.name !== after.project.name &&
    equal({ ...before.project, name: '' }, { ...after.project, name: '' }) &&
    equal(
      [
        before.settings,
        before.export,
        before.entrypoint,
        before.bootstrapModule,
        before.undefinedInteractionProgram,
        before.inventories,
        before.interactableInstances,
      ],
      [
        after.settings,
        after.export,
        after.entrypoint,
        after.bootstrapModule,
        after.undefinedInteractionProgram,
        after.inventories,
        after.interactableInstances,
      ],
    )
  );
}

function namedBindingsStable(before: AuthoringProject, after: AuthoringProject): boolean {
  if (membershipChanged(before.localization.messages, after.localization.messages)) return false;
  return Object.entries(before.localization.messages).every(([id, previous]) => {
    const current = after.localization.messages[id];
    return (
      equal(previous, current) ||
      (previous.kind === 'named' && current?.kind === 'named' && previous.key === current.key)
    );
  });
}

function semanticMembershipChanged(
  paths: readonly string[],
  before: AuthoringProject,
  after: AuthoringProject,
): boolean {
  if (paths.includes('traits.yaml') && membershipChanged(before.traits, after.traits)) return true;
  if (
    paths.includes('project.yaml') &&
    (membershipChanged(before.interactableInstances, after.interactableInstances) ||
      before.settings.cursors.named.length !== after.settings.cursors.named.length ||
      before.settings.cursors.named.some(
        (cursor, index) => cursor.id !== after.settings.cursors.named[index]?.id,
      ))
  )
    return true;
  if (
    paths.includes(POLICY) &&
    (before.localization.sourceLocale !== after.localization.sourceLocale ||
      membershipChanged(before.localization.locales, after.localization.locales))
  )
    return true;
  if (
    paths.includes(MESSAGES) &&
    (membershipChanged(before.localization.messages, after.localization.messages) ||
      Object.entries(before.localization.messages).some(([id, previous]) => {
        const current = after.localization.messages[id];
        return (
          previous.kind !== current?.kind ||
          (previous.kind === 'named' && current?.kind === 'named' && previous.key !== current.key)
        );
      }))
  )
    return true;
  return paths.some((path) => {
    const locale = /^i18n\/locales\/([^/]+)\.yaml$/u.exec(path)?.[1];
    return (
      locale !== undefined &&
      membershipChanged(
        before.localization.translations[locale] ?? {},
        after.localization.translations[locale] ?? {},
      )
    );
  });
}

/** Arrays and added/removed fields remain structural, not independently reorderable leaves. */
function changedRecordFields(
  before: unknown,
  after: unknown,
  root: JsonPointer,
): readonly JsonPointer[] {
  const changes: JsonPointer[] = [];
  const visit = (previous: unknown, current: unknown, path: JsonPointer): void => {
    if (previous === current) return;
    if (Array.isArray(previous) || Array.isArray(current)) {
      if (!equal(previous, current)) changes.push(path);
    } else if (
      previous !== null &&
      current !== null &&
      typeof previous === 'object' &&
      typeof current === 'object'
    ) {
      const oldFields = Object.keys(previous).sort();
      if (!equal(oldFields, Object.keys(current).sort())) changes.push(path);
      else
        for (const field of oldFields)
          visit(
            (previous as Record<string, unknown>)[field],
            (current as Record<string, unknown>)[field],
            `${path}/${escapeJsonPointerSegment(field)}`,
          );
    } else changes.push(path);
  };
  visit(before, after, root);
  return changes;
}

/** Physical source edits augment, rather than replace, the semantic generation's owner work. */
export function externalAssetContributionKeys(
  project: AuthoringProject,
  changedPaths: readonly string[],
  contributions: AuthoringDependencyGraphContributionSet,
): ReadonlySet<string> {
  const changed = new Set(changedPaths);
  const keys = new Set<string>();
  for (const [assetId, record] of Object.entries(project.assets)) {
    const source = parseAssetData(record.data)?.source.path;
    if (!source || !changed.has(source)) continue;
    for (const kind of ['source-asset', 'source-resolution-asset'] as const)
      for (const key of contributions.contributionKeysByDerivationKey.get(
        JSON.stringify([kind, assetId]),
      ) ?? [])
        keys.add(key);
  }
  return keys;
}

/** Classify one admitted edit batch once; consumers select work without restating path rules. */
export function classifyWorkspaceEditEffects(
  changedPaths: readonly string[],
  before: AuthoringProject,
  after: AuthoringProject,
  semanticInputsUnchanged: boolean,
): WorkspaceEditEffects {
  const paths = changedPaths;
  const every = (predicate: (path: string) => boolean) =>
    paths.length > 0 && paths.every(predicate);
  const records = paths.map((path) => recordEdit(before, after, path));
  const presentationRecords =
    records.length > 0 && records.every((record) => record?.presentationOnly)
      ? (records as RecordEdit[])
      : null;
  const nonLocalizingSources = new Set(
    paths.filter((path) => layoutSourceIsNonLocalizing(before, after, path)),
  );
  const nameOnly =
    paths.length === 1 && paths[0] === 'project.yaml' && projectNameOnly(before, after);
  const stableMessages = every((path) => path === MESSAGES) && namedBindingsStable(before, after);
  let localizationPhases: readonly LocalizationPhase[] = phases;
  if (
    before === after ||
    every((path) => nonLocalizingSources.has(path)) ||
    every(
      (path) =>
        path === 'editor.yaml' || path === NOTES || /^i18n\/assets\/[^/]+\.yaml$/u.test(path),
    )
  )
    localizationPhases = [];
  else if (every((path) => /^i18n\/locales\/[^/]+\.yaml$/u.test(path)) || stableMessages)
    localizationPhases = ['translations'];
  else if (every((path) => path === ORPHANS)) localizationPhases = ['identities'];
  else if (every((path) => path === TRACKING)) localizationPhases = ['identities', 'translations'];
  else if (every((path) => path === POLICY)) localizationPhases = ['references', 'translations'];

  const coverageInputsChanged =
    before !== after &&
    !every((path) => {
      if (
        path === 'editor.yaml' ||
        nonLocalizingSources.has(path) ||
        path === ORPHANS ||
        path === NOTES ||
        /^i18n\/assets\/[^/]+\.yaml$/u.test(path)
      )
        return true;
      if (path === 'traits.yaml') return equal(before.traits, after.traits);
      if (path === 'project.yaml')
        return equal(
          [
            before.settings,
            before.inventories,
            before.interactableInstances,
            before.undefinedInteractionProgram,
            before.bootstrapModule,
            before.entrypoint,
          ],
          [
            after.settings,
            after.inventories,
            after.interactableInstances,
            after.undefinedInteractionProgram,
            after.bootstrapModule,
            after.entrypoint,
          ],
        );
      if (path === MESSAGES)
        return equal(before.localization.messages, after.localization.messages);
      if (path === POLICY)
        return equal(
          [before.localization.sourceLocale, before.localization.locales],
          [after.localization.sourceLocale, after.localization.locales],
        );
      const locale = /^i18n\/locales\/([^/]+)\.yaml$/u.exec(path)?.[1];
      if (locale)
        return equal(
          before.localization.translations[locale],
          after.localization.translations[locale],
        );
      const record = records[paths.indexOf(path)];
      return record?.unchanged === true || record?.presentationOnly === true;
    });

  let graph: WorkspaceEditEffects['graph'] = { kind: 'impact' };
  if (
    nameOnly ||
    semanticInputsUnchanged ||
    stableMessages ||
    every((path) => /^shaders\/.+\.sc$/u.test(path)) ||
    every((path) => {
      const locale = /^i18n\/locales\/([^/]+)\.yaml$/u.exec(path)?.[1];
      return (
        !!locale &&
        !membershipChanged(
          before.localization.translations[locale] ?? {},
          after.localization.translations[locale] ?? {},
        )
      );
    })
  )
    graph = { kind: 'contributions', keys: new Set() };
  else if (presentationRecords)
    graph = {
      kind: 'contributions',
      keys: new Set(
        presentationRecords
          .filter((record) => !record.unchanged)
          .map(({ collection, id }) => recordContributionKey(collection, id)),
      ),
    };
  else if (records.length > 0 && records.every((record) => record !== null)) {
    const keys = new Set<string>();
    let narrowable = true;
    for (const record of records) {
      if (!record) continue;
      const { collection, id } = record;
      for (const field of changedRecordFields(
        before[collection][id],
        after[collection][id],
        `/${collection}/${escapeJsonPointerSegment(id)}`,
      )) {
        const effect = classifyAuthoringGraphInputPath(field)?.effect;
        if (effect?.kind === 'none') continue;
        if (effect?.kind === 'owner-contribution') keys.add(recordContributionKey(collection, id));
        else {
          narrowable = false;
          break;
        }
      }
      if (!narrowable) break;
    }
    if (narrowable) graph = { kind: 'contributions', keys };
  } else if (every((path) => /\.(?:lua|rml|rcss)$/u.test(path))) graph = { kind: 'sources' };

  return {
    semanticInputsUnchanged,
    projectNameOnly: nameOnly,
    presentationRecords,
    localizationPhases,
    coverageInputsChanged,
    membershipChanged: semanticMembershipChanged(paths, before, after),
    graph,
  };
}
