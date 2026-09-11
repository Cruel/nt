import type {
  AuthoringLocalization,
  SourceMessageTrackingEntry,
  SourceMessageTrackingOccurrence,
} from './project-schema/authoring-localization';
import { structuredMessageId } from './authoring-structured-messages';

export type LocalizationSourceFamily = 'lua' | 'rml';

export interface LocalizationSourceOccurrenceCandidate {
  readonly ordinal: number;
  readonly structuralFingerprint: string;
  readonly anchorFingerprint: string;
  readonly sourceFingerprint: string;
  readonly sourceSnapshot: string;
  readonly contextSnapshot?: string;
  readonly translatorNoteSnapshot?: string;
}

export interface LocalizationSourceCandidate {
  readonly family: LocalizationSourceFamily;
  readonly ownerKey: string;
  readonly sourcePath: string;
  readonly sourceSnapshotFingerprint: string;
  readonly occurrences: readonly LocalizationSourceOccurrenceCandidate[];
}

export interface LocalizationSourceIdentityResolution {
  readonly messageId: string;
  readonly tracked: boolean;
}

function fnv1a32(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function localizationTrackingFingerprint(value: string): `fnv1a:${string}` {
  return `fnv1a:${[0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((seed) => fnv1a32(value, seed))
    .join('')}`;
}

export function localizationSourceKey(
  family: LocalizationSourceFamily,
  ownerKey: string,
  sourcePath: string,
): string {
  return `${family}:${ownerKey}:${sourcePath}`;
}

export function localizationOwnerKey(owner: unknown): string {
  if (!owner || typeof owner !== 'object') return String(owner);
  const value = owner as Record<string, unknown>;
  switch (value.kind) {
    case 'record':
      return `record:${String(value.collection)}:${String(value.id)}`;
    case 'nested':
      return [
        'nested',
        String(value.ownerCollection),
        String(value.ownerId),
        String(value.family),
        String(value.id),
      ].join(':');
    case 'trait-definition':
      return `trait-definition:${String(value.id)}`;
    case 'localization-message':
      return `localization-message:${String(value.locale)}:${String(value.messageId)}`;
    case 'project-field':
      return `project-field:${String(value.path)}`;
    default:
      return JSON.stringify(owner);
  }
}

function candidatesMatching(
  entry: SourceMessageTrackingEntry,
  candidate: LocalizationSourceOccurrenceCandidate,
): readonly SourceMessageTrackingOccurrence[] {
  const byAnchorAndStructure = entry.occurrences.filter(
    (occurrence) =>
      occurrence.anchorFingerprint === candidate.anchorFingerprint &&
      occurrence.structuralFingerprint === candidate.structuralFingerprint,
  );
  if (byAnchorAndStructure.length === 1) return byAnchorAndStructure;
  const byStructure = entry.occurrences.filter(
    (occurrence) => occurrence.structuralFingerprint === candidate.structuralFingerprint,
  );
  if (byStructure.length === 1) return byStructure;
  const byAnchor = entry.occurrences.filter(
    (occurrence) => occurrence.anchorFingerprint === candidate.anchorFingerprint,
  );
  return byAnchor.length === 1 ? byAnchor : [];
}

function uniquelyMatchedWithinSource(
  entry: SourceMessageTrackingEntry,
  source: LocalizationSourceCandidate,
  candidate: LocalizationSourceOccurrenceCandidate,
): SourceMessageTrackingOccurrence | null {
  const matches = candidatesMatching(entry, candidate);
  if (matches.length !== 1) return null;
  const prior = matches[0]!;
  const reverseMatches = source.occurrences.filter((current) =>
    candidatesMatching(entry, current).some((match) => match.messageId === prior.messageId),
  );
  return reverseMatches.length === 1 ? prior : null;
}

/**
 * Resolve a free-form source occurrence without mutating Project state. Tracked metadata wins when it
 * identifies the occurrence unambiguously; otherwise a deterministic ephemeral identity keeps
 * preview/compiler behavior pure until localization sync materializes durable tracking.
 */
export function resolveLocalizationSourceIdentity(
  localization: AuthoringLocalization,
  source: LocalizationSourceCandidate,
  occurrence: LocalizationSourceOccurrenceCandidate,
): LocalizationSourceIdentityResolution {
  const exact =
    localization.sourceMessageTracking[
      localizationSourceKey(source.family, source.ownerKey, source.sourcePath)
    ];
  if (exact) {
    const matched = uniquelyMatchedWithinSource(exact, source, occurrence);
    if (matched) return { messageId: matched.messageId, tracked: true };
    if (exact.sourceSnapshotFingerprint === source.sourceSnapshotFingerprint) {
      const byOrdinal = exact.occurrences.filter(
        (candidate) => candidate.ordinal === occurrence.ordinal,
      );
      if (byOrdinal.length === 1) return { messageId: byOrdinal[0]!.messageId, tracked: true };
    }
    if (candidatesMatching(exact, occurrence).length > 0)
      return {
        messageId: ephemeralLocalizationSourceIdentity(source, occurrence),
        tracked: false,
      };
  }

  return {
    messageId: ephemeralLocalizationSourceIdentity(source, occurrence),
    tracked: false,
  };
}

function ephemeralLocalizationSourceIdentity(
  source: LocalizationSourceCandidate,
  occurrence: LocalizationSourceOccurrenceCandidate,
): string {
  const seed = [
    'source-message',
    source.family,
    source.ownerKey,
    source.sourcePath,
    occurrence.structuralFingerprint,
    occurrence.anchorFingerprint,
    occurrence.sourceFingerprint,
    occurrence.ordinal,
  ].join('|');
  return structuredMessageId(seed);
}
