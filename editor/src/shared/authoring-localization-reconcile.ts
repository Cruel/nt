import { synchronizeLocalizationMessageTracking } from './authoring-localization-sync';
import { collectManagedLuaLocalizationSources } from './authoring-lua-localization-lowering';
import { collectRmlLocalizationSources } from './authoring-rml-localization-lowering';
import {
  localizationSourceKey,
  localizationTrackingFingerprint,
  resolveLocalizationSourceIdentity,
  type LocalizationSourceCandidate,
  type LocalizationSourceOccurrenceCandidate,
} from './localization-source-tracking';
import type { AuthoringProject } from './project-schema/authoring-project';
import type {
  OrphanedLocalizationMessage,
  SourceMessageTrackingEntry,
  SourceMessageTrackingOccurrence,
} from './project-schema/authoring-localization';

interface CurrentOccurrence {
  readonly id: string;
  readonly sourceKey: string;
  readonly source: LocalizationSourceCandidate;
  readonly occurrence: LocalizationSourceOccurrenceCandidate;
}

interface PreviousOccurrence {
  readonly id: string;
  readonly origin: 'tracked' | 'orphan';
  readonly sourceKey: string;
  readonly family: 'lua' | 'rml';
  readonly ownerKey: string;
  readonly sourcePath: string;
  readonly sourceSnapshotFingerprint: string;
  readonly occurrence: SourceMessageTrackingOccurrence;
  readonly valuable: boolean;
}

export interface LocalizationReconciliationCurrentOccurrence {
  readonly id: string;
  readonly family: 'lua' | 'rml';
  readonly ownerKey: string;
  readonly sourcePath: string;
  readonly ordinal: number;
  readonly sourceSnapshot: string;
}

export interface LocalizationReconciliationPreviousOccurrence {
  readonly messageId: string;
  readonly origin: 'tracked' | 'orphan';
  readonly family: 'lua' | 'rml';
  readonly ownerKey: string;
  readonly sourcePath: string;
  readonly ordinal: number;
  readonly sourceSnapshot: string;
  readonly contextSnapshot?: string;
  readonly translatorNoteSnapshot?: string;
  readonly valuable: boolean;
}

export interface LocalizationReconciliationGroup {
  readonly id: string;
  readonly currentOccurrences: readonly LocalizationReconciliationCurrentOccurrence[];
  readonly previousOccurrences: readonly LocalizationReconciliationPreviousOccurrence[];
  readonly previousMessageIds: readonly string[];
  readonly requiresDecision: boolean;
  readonly defaultResolution: 'new' | 'orphan-or-garbage-collect';
}

export interface LocalizationReconciliationPlan {
  readonly expectedWorkspaceRevision: string;
  readonly expectedFingerprint: string;
  readonly deterministicChanged: boolean;
  readonly groups: readonly LocalizationReconciliationGroup[];
}

export type LocalizationReconciliationDecisions = Readonly<Record<string, string>>;

export type LocalizationReconciliationApplyResult =
  | Readonly<{ status: 'stale'; plan: LocalizationReconciliationPlan }>
  | Readonly<{
      status: 'needs-decision';
      plan: LocalizationReconciliationPlan;
      occurrenceIds: readonly string[];
    }>
  | Readonly<{
      status: 'applied';
      project: AuthoringProject;
      changed: boolean;
      plan: LocalizationReconciliationPlan;
      relinkedMessageIds: readonly string[];
      materializedMessageIds: readonly string[];
      orphanedMessageIds: readonly string[];
      garbageCollectedMessageIds: readonly string[];
    }>;

function currentSources(project: AuthoringProject): readonly LocalizationSourceCandidate[] {
  return Object.freeze([
    ...collectManagedLuaLocalizationSources(project).map((item) => item.source),
    ...collectRmlLocalizationSources(project).map((item) => item.source),
  ]);
}

function currentId(sourceKey: string, ordinal: number): string {
  return `${sourceKey}#${ordinal}`;
}

function flattenCurrent(project: AuthoringProject): readonly CurrentOccurrence[] {
  return currentSources(project).flatMap((source) => {
    const sourceKey = localizationSourceKey(source.family, source.ownerKey, source.sourcePath);
    return source.occurrences.map((occurrence) => ({
      id: currentId(sourceKey, occurrence.ordinal),
      sourceKey,
      source,
      occurrence,
    }));
  });
}

function occurrenceIsFreshlyTracked(
  project: AuthoringProject,
  current: CurrentOccurrence,
): boolean {
  const entry = project.localization.sourceMessageTracking[current.sourceKey];
  if (!entry || entry.sourceSnapshotFingerprint !== current.source.sourceSnapshotFingerprint)
    return false;
  return entry.occurrences.some(
    (occurrence) =>
      occurrence.ordinal === current.occurrence.ordinal &&
      occurrence.structuralFingerprint === current.occurrence.structuralFingerprint &&
      occurrence.anchorFingerprint === current.occurrence.anchorFingerprint &&
      occurrence.sourceFingerprint === current.occurrence.sourceFingerprint &&
      occurrence.sourceSnapshot === current.occurrence.sourceSnapshot,
  );
}

function translationsForMessage(project: AuthoringProject, messageId: string) {
  return Object.fromEntries(
    Object.entries(project.localization.translations)
      .filter(([, translations]) => translations[messageId] !== undefined)
      .map(([locale, translations]) => [locale, translations[messageId]!]),
  );
}

function occurrenceHasValue(
  project: AuthoringProject,
  occurrence: SourceMessageTrackingOccurrence,
) {
  return (
    Object.keys(translationsForMessage(project, occurrence.messageId)).length > 0 ||
    Boolean(occurrence.contextSnapshot) ||
    Boolean(occurrence.translatorNoteSnapshot)
  );
}

function flattenPrevious(project: AuthoringProject): readonly PreviousOccurrence[] {
  const tracked = Object.entries(project.localization.sourceMessageTracking).flatMap(
    ([sourceKey, entry]) =>
      entry.occurrences.map((occurrence) => ({
        id: `tracked:${sourceKey}#${occurrence.messageId}`,
        origin: 'tracked' as const,
        sourceKey,
        family: entry.family,
        ownerKey: entry.ownerKey,
        sourcePath: entry.sourcePath,
        sourceSnapshotFingerprint: entry.sourceSnapshotFingerprint,
        occurrence,
        valuable: occurrenceHasValue(project, occurrence),
      })),
  );
  const orphaned = Object.entries(project.localization.orphanedMessages).map(
    ([messageId, orphan]) => ({
      id: `orphan:${messageId}`,
      origin: 'orphan' as const,
      sourceKey: localizationSourceKey(orphan.family, orphan.ownerKey, orphan.sourcePath),
      family: orphan.family,
      ownerKey: orphan.ownerKey,
      sourcePath: orphan.sourcePath,
      sourceSnapshotFingerprint: orphan.sourceSnapshotFingerprint,
      occurrence: orphan.occurrence,
      valuable: true,
    }),
  );
  return Object.freeze([...tracked, ...orphaned]);
}

function weaklyRelated(current: CurrentOccurrence, previous: PreviousOccurrence): boolean {
  if (current.source.family !== previous.family) return false;
  return (
    current.sourceKey === previous.sourceKey ||
    current.source.ownerKey === previous.ownerKey ||
    current.occurrence.structuralFingerprint === previous.occurrence.structuralFingerprint ||
    current.occurrence.anchorFingerprint === previous.occurrence.anchorFingerprint
  );
}

function planFingerprint(project: AuthoringProject): string {
  const sources = currentSources(project).map((source) => ({
    family: source.family,
    ownerKey: source.ownerKey,
    sourcePath: source.sourcePath,
    sourceSnapshotFingerprint: source.sourceSnapshotFingerprint,
    occurrences: source.occurrences.map((occurrence) => ({
      ordinal: occurrence.ordinal,
      structuralFingerprint: occurrence.structuralFingerprint,
      anchorFingerprint: occurrence.anchorFingerprint,
      sourceFingerprint: occurrence.sourceFingerprint,
    })),
  }));
  const tracking = Object.entries(project.localization.sourceMessageTracking).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const orphans = Object.entries(project.localization.orphanedMessages).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const translationIds = Object.entries(project.localization.translations)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([locale, entries]) => [locale, Object.keys(entries).sort()]);
  return localizationTrackingFingerprint(
    JSON.stringify({ sources, tracking, orphans, translationIds }),
  );
}

function buildGroups(
  currents: readonly CurrentOccurrence[],
  previous: readonly PreviousOccurrence[],
): readonly LocalizationReconciliationGroup[] {
  const currentById = new Map(currents.map((item) => [item.id, item]));
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const currentEdges = new Map<string, Set<string>>();
  const previousEdges = new Map<string, Set<string>>();
  for (const current of currents)
    for (const prior of previous) {
      if (!weaklyRelated(current, prior)) continue;
      (
        currentEdges.get(current.id) ?? currentEdges.set(current.id, new Set()).get(current.id)!
      ).add(prior.id);
      (previousEdges.get(prior.id) ?? previousEdges.set(prior.id, new Set()).get(prior.id)!).add(
        current.id,
      );
    }

  const seenCurrent = new Set<string>();
  const seenPrevious = new Set<string>();
  const groups: LocalizationReconciliationGroup[] = [];
  const seeds = [
    ...currents.map((item) => ({ kind: 'current' as const, id: item.id })),
    ...previous.map((item) => ({ kind: 'previous' as const, id: item.id })),
  ];
  for (const seed of seeds) {
    if (
      (seed.kind === 'current' && seenCurrent.has(seed.id)) ||
      (seed.kind === 'previous' && seenPrevious.has(seed.id))
    )
      continue;
    const currentIds = new Set<string>();
    const previousIds = new Set<string>();
    const queue = [seed];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (next.kind === 'current') {
        if (currentIds.has(next.id)) continue;
        currentIds.add(next.id);
        for (const id of currentEdges.get(next.id) ?? []) queue.push({ kind: 'previous', id });
      } else {
        if (previousIds.has(next.id)) continue;
        previousIds.add(next.id);
        for (const id of previousEdges.get(next.id) ?? []) queue.push({ kind: 'current', id });
      }
    }
    currentIds.forEach((id) => seenCurrent.add(id));
    previousIds.forEach((id) => seenPrevious.add(id));
    const groupCurrents = [...currentIds].map((id) => currentById.get(id)!).filter(Boolean);
    const groupPrevious = [...previousIds].map((id) => previousById.get(id)!).filter(Boolean);
    const manyToMany = groupCurrents.length > 1 && groupPrevious.length > 1;
    const requiresDecision =
      !manyToMany && groupCurrents.length > 0 && groupPrevious.some((item) => item.valuable);
    const publicCurrents = groupCurrents
      .map((item) => ({
        id: item.id,
        family: item.source.family,
        ownerKey: item.source.ownerKey,
        sourcePath: item.source.sourcePath,
        ordinal: item.occurrence.ordinal,
        sourceSnapshot: item.occurrence.sourceSnapshot,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const publicPrevious = groupPrevious
      .map((item) => ({
        messageId: item.occurrence.messageId,
        origin: item.origin,
        family: item.family,
        ownerKey: item.ownerKey,
        sourcePath: item.sourcePath,
        ordinal: item.occurrence.ordinal,
        sourceSnapshot: item.occurrence.sourceSnapshot,
        ...(item.occurrence.contextSnapshot === undefined
          ? {}
          : { contextSnapshot: item.occurrence.contextSnapshot }),
        ...(item.occurrence.translatorNoteSnapshot === undefined
          ? {}
          : { translatorNoteSnapshot: item.occurrence.translatorNoteSnapshot }),
        valuable: item.valuable,
      }))
      .sort((a, b) => a.messageId.localeCompare(b.messageId));
    const groupIdentity = [
      ...publicCurrents.map((item) => item.id),
      ...publicPrevious.map((item) => item.messageId),
    ].join('|');
    groups.push({
      id: localizationTrackingFingerprint(groupIdentity),
      currentOccurrences: Object.freeze(publicCurrents),
      previousOccurrences: Object.freeze(publicPrevious),
      previousMessageIds: Object.freeze(
        [...new Set(publicPrevious.map((item) => item.messageId))].sort(),
      ),
      requiresDecision,
      defaultResolution: groupCurrents.length > 0 ? 'new' : 'orphan-or-garbage-collect',
    });
  }
  return Object.freeze(groups.sort((a, b) => a.id.localeCompare(b.id)));
}

export function planLocalizationReconciliation(
  project: AuthoringProject,
  expectedWorkspaceRevision = '',
): LocalizationReconciliationPlan {
  const originalCurrents = flattenCurrent(project);
  const orphanCandidates = flattenPrevious(project).filter((item) => item.origin === 'orphan');
  const orphanRelatedCurrentIds = new Set(
    originalCurrents
      .filter((current) => orphanCandidates.some((prior) => weaklyRelated(current, prior)))
      .map((current) => current.id),
  );
  const synced = synchronizeLocalizationMessageTracking(project);
  const currents = flattenCurrent(synced.project).filter(
    (current) =>
      orphanRelatedCurrentIds.has(current.id) ||
      !occurrenceIsFreshlyTracked(synced.project, current),
  );
  const freshMessageIds = new Set(
    flattenCurrent(synced.project)
      .filter((current) => occurrenceIsFreshlyTracked(synced.project, current))
      .flatMap((current) => {
        const entry = synced.project.localization.sourceMessageTracking[current.sourceKey];
        return (
          entry?.occurrences
            .filter((item) => item.ordinal === current.occurrence.ordinal)
            .map((item) => item.messageId) ?? []
        );
      }),
  );
  const previous = flattenPrevious(synced.project).filter(
    (item) => item.origin === 'orphan' || !freshMessageIds.has(item.occurrence.messageId),
  );
  return {
    expectedWorkspaceRevision,
    expectedFingerprint: planFingerprint(project),
    deterministicChanged: synced.changed,
    groups: buildGroups(currents, previous),
  };
}

function removeTrackingOccurrence(
  tracking: Record<string, SourceMessageTrackingEntry>,
  sourceKey: string,
  messageId: string,
) {
  const entry = tracking[sourceKey];
  if (!entry) return;
  const occurrences = entry.occurrences.filter((item) => item.messageId !== messageId);
  if (occurrences.length === 0) delete tracking[sourceKey];
  else tracking[sourceKey] = { ...entry, occurrences };
}

function addTrackingOccurrence(
  tracking: Record<string, SourceMessageTrackingEntry>,
  current: CurrentOccurrence,
  messageId: string,
) {
  const entry = tracking[current.sourceKey];
  const occurrence: SourceMessageTrackingOccurrence = {
    messageId,
    ordinal: current.occurrence.ordinal,
    structuralFingerprint: current.occurrence.structuralFingerprint,
    anchorFingerprint: current.occurrence.anchorFingerprint,
    sourceFingerprint: current.occurrence.sourceFingerprint,
    sourceSnapshot: current.occurrence.sourceSnapshot,
    ...(current.occurrence.contextSnapshot === undefined
      ? {}
      : { contextSnapshot: current.occurrence.contextSnapshot }),
    ...(current.occurrence.translatorNoteSnapshot === undefined
      ? {}
      : { translatorNoteSnapshot: current.occurrence.translatorNoteSnapshot }),
  };
  tracking[current.sourceKey] = {
    family: current.source.family,
    ownerKey: current.source.ownerKey,
    sourcePath: current.source.sourcePath,
    sourceSnapshotFingerprint: current.source.sourceSnapshotFingerprint,
    occurrences: [
      ...(entry?.occurrences.filter(
        (item) => item.messageId !== messageId && item.ordinal !== current.occurrence.ordinal,
      ) ?? []),
      occurrence,
    ].sort((a, b) => a.ordinal - b.ordinal || a.messageId.localeCompare(b.messageId)),
  };
}

function moveTranslationsToOrphan(project: AuthoringProject, previous: PreviousOccurrence) {
  const translations = translationsForMessage(project, previous.occurrence.messageId);
  for (const [locale, entries] of Object.entries(project.localization.translations)) {
    if (!entries[previous.occurrence.messageId]) continue;
    delete entries[previous.occurrence.messageId];
    if (Object.keys(entries).length === 0) delete project.localization.translations[locale];
  }
  const orphan: OrphanedLocalizationMessage = {
    family: previous.family,
    ownerKey: previous.ownerKey,
    sourcePath: previous.sourcePath,
    sourceSnapshotFingerprint: previous.sourceSnapshotFingerprint,
    occurrence: previous.occurrence,
    translations,
  };
  project.localization.orphanedMessages[previous.occurrence.messageId] = orphan;
}

function restoreOrphanTranslations(project: AuthoringProject, messageId: string) {
  const orphan = project.localization.orphanedMessages[messageId];
  if (!orphan) return;
  for (const [locale, translation] of Object.entries(orphan.translations)) {
    const entries = project.localization.translations[locale] ?? {};
    entries[messageId] = translation;
    project.localization.translations[locale] = entries;
  }
  delete project.localization.orphanedMessages[messageId];
}

export function applyLocalizationReconciliation(
  project: AuthoringProject,
  plan: LocalizationReconciliationPlan,
  decisions: LocalizationReconciliationDecisions,
): LocalizationReconciliationApplyResult {
  const currentPlan = planLocalizationReconciliation(project, plan.expectedWorkspaceRevision);
  if (currentPlan.expectedFingerprint !== plan.expectedFingerprint)
    return { status: 'stale', plan: currentPlan };

  const missingDecisions = currentPlan.groups
    .filter((group) => group.requiresDecision)
    .flatMap((group) =>
      group.currentOccurrences
        .filter((occurrence) => decisions[occurrence.id] === undefined)
        .map((occurrence) => occurrence.id),
    );
  if (missingDecisions.length > 0)
    return {
      status: 'needs-decision',
      plan: currentPlan,
      occurrenceIds: Object.freeze(missingDecisions.sort()),
    };

  const synced = synchronizeLocalizationMessageTracking(project);
  const next = structuredClone(synced.project);
  const currents = new Map(flattenCurrent(next).map((item) => [item.id, item]));
  const previous = new Map(flattenPrevious(next).map((item) => [item.occurrence.messageId, item]));
  const usedPrevious = new Set<string>();
  const relinked = new Set<string>();
  const materialized = new Set<string>();
  const orphaned = new Set<string>();
  const garbageCollected = new Set<string>();

  for (const group of currentPlan.groups) {
    const groupPreviousIds = new Set(group.previousMessageIds);
    for (const occurrence of group.currentOccurrences) {
      const current = currents.get(occurrence.id);
      if (!current) continue;
      const decision = decisions[occurrence.id] ?? 'new';
      let messageId: string;
      if (decision === 'new') {
        messageId = resolveLocalizationSourceIdentity(
          { ...next.localization, sourceMessageTracking: {} },
          current.source,
          current.occurrence,
        ).messageId;
        materialized.add(messageId);
      } else {
        if (!groupPreviousIds.has(decision) || usedPrevious.has(decision))
          return { status: 'stale', plan: currentPlan };
        messageId = decision;
        usedPrevious.add(messageId);
        relinked.add(messageId);
        restoreOrphanTranslations(next, messageId);
      }
      addTrackingOccurrence(next.localization.sourceMessageTracking, current, messageId);
    }
  }

  for (const group of currentPlan.groups)
    for (const priorView of group.previousOccurrences) {
      const prior = previous.get(priorView.messageId);
      if (!prior || usedPrevious.has(priorView.messageId)) continue;
      if (prior.origin === 'tracked')
        removeTrackingOccurrence(
          next.localization.sourceMessageTracking,
          prior.sourceKey,
          prior.occurrence.messageId,
        );
      if (prior.valuable) {
        if (prior.origin === 'tracked') moveTranslationsToOrphan(next, prior);
        orphaned.add(prior.occurrence.messageId);
      } else {
        if (prior.origin === 'orphan')
          delete next.localization.orphanedMessages[prior.occurrence.messageId];
        garbageCollected.add(prior.occurrence.messageId);
      }
    }

  next.localization.sourceMessageTracking = Object.fromEntries(
    Object.entries(next.localization.sourceMessageTracking).sort(([a], [b]) => a.localeCompare(b)),
  );
  next.localization.orphanedMessages = Object.fromEntries(
    Object.entries(next.localization.orphanedMessages).sort(([a], [b]) => a.localeCompare(b)),
  );
  const changed = JSON.stringify(project.localization) !== JSON.stringify(next.localization);
  return {
    status: 'applied',
    project: next,
    changed,
    plan: currentPlan,
    relinkedMessageIds: Object.freeze([...relinked].sort()),
    materializedMessageIds: Object.freeze([...materialized].sort()),
    orphanedMessageIds: Object.freeze([...orphaned].sort()),
    garbageCollectedMessageIds: Object.freeze([...garbageCollected].sort()),
  };
}
