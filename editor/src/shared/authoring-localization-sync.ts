import type { AuthoringProject } from './project-schema/authoring-project';
import type {
  SourceMessageTrackingEntry,
  SourceMessageTrackingOccurrence,
} from './project-schema/authoring-localization';
import { structuredMessages } from './authoring-structured-messages';
import { collectManagedLuaLocalizationSources } from './authoring-lua-localization-lowering';
import { collectRmlLocalizationSources } from './authoring-rml-localization-lowering';
import {
  localizationSourceKey,
  resolveLocalizationSourceIdentity,
  type LocalizationSourceCandidate,
  type LocalizationSourceOccurrenceCandidate,
} from './localization-source-tracking';

interface CurrentOccurrence {
  readonly sourceKey: string;
  readonly source: LocalizationSourceCandidate;
  readonly occurrence: LocalizationSourceOccurrenceCandidate;
}

interface PreviousOccurrence {
  readonly sourceKey: string;
  readonly entry: SourceMessageTrackingEntry;
  readonly occurrence: SourceMessageTrackingOccurrence;
}

export interface LocalizationSyncResult {
  readonly project: AuthoringProject;
  readonly changed: boolean;
  readonly materializedMessageIds: readonly string[];
  readonly preservedMessageIds: readonly string[];
  readonly unresolved: readonly Readonly<{
    family: 'lua' | 'rml';
    ownerKey: string;
    sourcePath: string;
    ordinal: number;
  }>[];
  readonly structuredMessageCount: number;
}

function currentSources(project: AuthoringProject): readonly LocalizationSourceCandidate[] {
  return Object.freeze([
    ...collectManagedLuaLocalizationSources(project).map((item) => item.source),
    ...collectRmlLocalizationSources(project).map((item) => item.source),
  ]);
}

function flattenCurrent(project: AuthoringProject): readonly CurrentOccurrence[] {
  return currentSources(project).flatMap((source) => {
    const sourceKey = localizationSourceKey(source.family, source.ownerKey, source.sourcePath);
    return source.occurrences.map((occurrence) => ({ sourceKey, source, occurrence }));
  });
}

function flattenPrevious(project: AuthoringProject): readonly PreviousOccurrence[] {
  return Object.entries(project.localization.sourceMessageTracking).flatMap(([sourceKey, entry]) =>
    entry.occurrences.map((occurrence) => ({ sourceKey, entry, occurrence })),
  );
}

function currentIdentity(item: CurrentOccurrence): string {
  return `${item.sourceKey}#${item.occurrence.ordinal}`;
}

function previousIdentity(item: PreviousOccurrence): string {
  return `${item.sourceKey}#${item.occurrence.messageId}`;
}

function previousHasValue(project: AuthoringProject, prior: PreviousOccurrence): boolean {
  return (
    Object.values(project.localization.translations).some(
      (translations) => translations[prior.occurrence.messageId] !== undefined,
    ) ||
    Boolean(prior.occurrence.contextSnapshot) ||
    Boolean(prior.occurrence.translatorNoteSnapshot)
  );
}

function uniquelyMatch(
  currents: readonly CurrentOccurrence[],
  previous: readonly PreviousOccurrence[],
  currentMatched: Set<string>,
  previousMatched: Set<string>,
  predicate: (current: CurrentOccurrence, prior: PreviousOccurrence) => boolean,
  matches: Map<string, PreviousOccurrence>,
): void {
  let progress = true;
  while (progress) {
    progress = false;
    for (const current of currents) {
      const currentId = currentIdentity(current);
      if (currentMatched.has(currentId)) continue;
      const candidates = previous.filter(
        (prior) => !previousMatched.has(previousIdentity(prior)) && predicate(current, prior),
      );
      if (candidates.length !== 1) continue;
      const prior = candidates[0]!;
      const reverse = currents.filter(
        (candidate) =>
          !currentMatched.has(currentIdentity(candidate)) && predicate(candidate, prior),
      );
      if (reverse.length !== 1) continue;
      matches.set(currentId, prior);
      currentMatched.add(currentId);
      previousMatched.add(previousIdentity(prior));
      progress = true;
    }
  }
}

function occurrenceFromCurrent(
  messageId: string,
  occurrence: LocalizationSourceOccurrenceCandidate,
): SourceMessageTrackingOccurrence {
  return {
    messageId,
    ordinal: occurrence.ordinal,
    structuralFingerprint: occurrence.structuralFingerprint,
    anchorFingerprint: occurrence.anchorFingerprint,
    sourceFingerprint: occurrence.sourceFingerprint,
    sourceSnapshot: occurrence.sourceSnapshot,
    ...(occurrence.contextSnapshot === undefined
      ? {}
      : { contextSnapshot: occurrence.contextSnapshot }),
    ...(occurrence.translatorNoteSnapshot === undefined
      ? {}
      : { translatorNoteSnapshot: occurrence.translatorNoteSnapshot }),
  };
}

function sortOccurrences(
  occurrences: readonly SourceMessageTrackingOccurrence[],
): SourceMessageTrackingOccurrence[] {
  return [...occurrences].sort(
    (left, right) => left.ordinal - right.ordinal || left.messageId.localeCompare(right.messageId),
  );
}

/**
 * Pure planning boundary for `noveltea localization sync`. Structured Messages already have semantic
 * owner/field identity and therefore need no sidecar. Free-form Lua/RML tracking is updated only for
 * deterministic one-to-one matches or occurrences that are definitely new.
 */
export function synchronizeLocalizationMessageTracking(
  project: AuthoringProject,
): LocalizationSyncResult {
  const next = structuredClone(project);
  const currents = flattenCurrent(project);
  const previous = flattenPrevious(project);
  const currentMatched = new Set<string>();
  const previousMatched = new Set<string>();
  const matches = new Map<string, PreviousOccurrence>();

  uniquelyMatch(
    currents,
    previous,
    currentMatched,
    previousMatched,
    (current, prior) =>
      current.sourceKey === prior.sourceKey &&
      current.occurrence.structuralFingerprint === prior.occurrence.structuralFingerprint &&
      current.occurrence.anchorFingerprint === prior.occurrence.anchorFingerprint,
    matches,
  );
  uniquelyMatch(
    currents,
    previous,
    currentMatched,
    previousMatched,
    (current, prior) =>
      current.sourceKey === prior.sourceKey &&
      current.occurrence.structuralFingerprint === prior.occurrence.structuralFingerprint,
    matches,
  );
  uniquelyMatch(
    currents,
    previous,
    currentMatched,
    previousMatched,
    (current, prior) =>
      current.sourceKey === prior.sourceKey &&
      current.occurrence.anchorFingerprint === prior.occurrence.anchorFingerprint,
    matches,
  );
  uniquelyMatch(
    currents,
    previous,
    currentMatched,
    previousMatched,
    (current, prior) => current.sourceKey === prior.sourceKey && !previousHasValue(project, prior),
    matches,
  );
  uniquelyMatch(
    currents,
    previous,
    currentMatched,
    previousMatched,
    (current, prior) =>
      current.source.family === prior.entry.family &&
      current.source.ownerKey === prior.entry.ownerKey &&
      current.occurrence.structuralFingerprint === prior.occurrence.structuralFingerprint,
    matches,
  );
  uniquelyMatch(
    currents,
    previous,
    currentMatched,
    previousMatched,
    (current, prior) =>
      current.source.family === prior.entry.family &&
      current.occurrence.structuralFingerprint === prior.occurrence.structuralFingerprint,
    matches,
  );

  const tracking: Record<string, SourceMessageTrackingEntry> = {};
  for (const [sourceKey, entry] of Object.entries(project.localization.sourceMessageTracking)) {
    const remaining = entry.occurrences.filter((occurrence) => {
      if (previousMatched.has(`${sourceKey}#${occurrence.messageId}`)) return false;
      const prior = { sourceKey, entry, occurrence };
      if (previousHasValue(project, prior)) return true;
      return !currents.some(
        (current) =>
          current.source.family === entry.family &&
          (current.sourceKey === sourceKey ||
            current.source.ownerKey === entry.ownerKey ||
            current.occurrence.structuralFingerprint === occurrence.structuralFingerprint ||
            current.occurrence.anchorFingerprint === occurrence.anchorFingerprint),
      );
    });
    if (remaining.length === 0) continue;
    tracking[sourceKey] = { ...entry, occurrences: sortOccurrences(remaining) };
  }

  const materialized = new Set<string>();
  const preserved = new Set<string>();
  const unresolved: LocalizationSyncResult['unresolved'][number][] = [];
  for (const current of currents) {
    const currentId = currentIdentity(current);
    const prior = matches.get(currentId);
    let messageId: string;
    if (prior) {
      messageId = prior.occurrence.messageId;
      preserved.add(messageId);
    } else {
      const plausiblePrior = previous.filter((candidate) => {
        if (previousMatched.has(previousIdentity(candidate))) return false;
        if (candidate.entry.family !== current.source.family) return false;
        if (!previousHasValue(project, candidate)) return false;
        return (
          candidate.sourceKey === current.sourceKey ||
          candidate.entry.ownerKey === current.source.ownerKey ||
          candidate.occurrence.structuralFingerprint === current.occurrence.structuralFingerprint ||
          candidate.occurrence.anchorFingerprint === current.occurrence.anchorFingerprint
        );
      });
      if (plausiblePrior.length > 0) {
        unresolved.push({
          family: current.source.family,
          ownerKey: current.source.ownerKey,
          sourcePath: current.source.sourcePath,
          ordinal: current.occurrence.ordinal,
        });
        continue;
      }
      messageId = resolveLocalizationSourceIdentity(
        { ...project.localization, sourceMessageTracking: {} },
        current.source,
        current.occurrence,
      ).messageId;
      materialized.add(messageId);
    }

    const entry = tracking[current.sourceKey] ?? {
      family: current.source.family,
      ownerKey: current.source.ownerKey,
      sourcePath: current.source.sourcePath,
      sourceSnapshotFingerprint: current.source.sourceSnapshotFingerprint,
      occurrences: [],
    };
    tracking[current.sourceKey] = {
      ...entry,
      family: current.source.family,
      ownerKey: current.source.ownerKey,
      sourcePath: current.source.sourcePath,
      sourceSnapshotFingerprint: current.source.sourceSnapshotFingerprint,
      occurrences: sortOccurrences([
        ...entry.occurrences.filter((item) => item.messageId !== messageId),
        occurrenceFromCurrent(messageId, current.occurrence),
      ]),
    };
  }

  next.localization.sourceMessageTracking = Object.fromEntries(
    Object.entries(tracking).sort(([left], [right]) => left.localeCompare(right)),
  );
  const changed =
    JSON.stringify(project.localization.sourceMessageTracking) !==
    JSON.stringify(next.localization.sourceMessageTracking);
  return {
    project: next,
    changed,
    materializedMessageIds: Object.freeze([...materialized].sort()),
    preservedMessageIds: Object.freeze([...preserved].sort()),
    unresolved: Object.freeze(
      unresolved.sort(
        (left, right) =>
          left.family.localeCompare(right.family) ||
          left.ownerKey.localeCompare(right.ownerKey) ||
          left.sourcePath.localeCompare(right.sourcePath) ||
          left.ordinal - right.ordinal,
      ),
    ),
    structuredMessageCount: structuredMessages(project).length,
  };
}
