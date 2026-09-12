import { collectManagedLuaLocalizationSources } from '../../shared/authoring-lua-localization-lowering';
import { collectRmlLocalizationSources } from '../../shared/authoring-rml-localization-lowering';
import {
  localizationMessageWorkflowView,
  localizationMessageWorkflowViews,
} from '../../shared/authoring-localization-workflow';
import { synchronizeLocalizationMessageTracking } from '../../shared/authoring-localization-sync';
import { structuredMessageById } from '../../shared/authoring-structured-messages';
import { analyzeManagedLuaLocalization } from '../../shared/authoring-source-analysis';
import { buildJsonPointer } from '../../shared/json-pointer';
import {
  authoringProjectSchema,
  type AuthoringProject,
} from '../../shared/project-schema/authoring-project';
import type { AuthoringMessage } from '../../shared/project-schema/authoring-localization';
import {
  localizationTrackingFingerprint,
  resolveLocalizationSourceIdentity,
} from '../../shared/localization-source-tracking';
import { applyJsonPatch, type JsonPatchOperation } from './json-patch';
import { toJsonValue } from './json-value';

export interface MessageReferenceRenamePatch {
  op: 'replace';
  path: string;
  value: unknown;
}

export type LocalizationMessagePatch =
  | { op: 'add' | 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string };

export interface MessageReuseCandidate {
  id: string;
  source: string;
  usedIn: string | null;
  rewriteable: boolean;
}

export type PromoteAndLinkResult =
  | { ok: true; patches: readonly LocalizationMessagePatch[] }
  | { ok: false; message: string };

export interface NamedMessageUsage {
  readonly id: string;
  readonly path: string;
  readonly rewriteable: boolean;
}

export type DemoteNamedMessageResult =
  | {
      ok: true;
      patches: readonly LocalizationMessagePatch[];
      messageId: string;
      copiedLocales: readonly string[];
    }
  | { ok: false; message: string };

export type MergeMessageResolution = 'target' | 'source';
export type MergeMessageResult =
  | { ok: true; patches: readonly LocalizationMessagePatch[] }
  | { ok: false; message: string; conflicts?: readonly string[] };

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function luaQuote(value: string): string {
  return JSON.stringify(value);
}

function replaceRanges(
  source: string,
  edits: readonly { start: number; end: number; replacement: string }[],
): string {
  let result = source;
  let previousStart = source.length + 1;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    if (edit.end > previousStart)
      throw new Error('Localization refactor produced overlapping edits.');
    result = `${result.slice(0, edit.start)}${edit.replacement}${result.slice(edit.end)}`;
    previousStart = edit.start;
  }
  return result;
}

function rewriteableStructuredMessage(project: AuthoringProject, messageId: string): boolean {
  const occurrence = structuredMessageById(project, messageId);
  return occurrence?.text?.source.kind === 'inline';
}

function localSourceFamily(project: AuthoringProject, messageId: string): 'lua' | 'rml' | null {
  for (const source of collectManagedLuaLocalizationSources(project)) {
    for (let ordinal = 0; ordinal < source.source.occurrences.length; ordinal += 1) {
      const candidate = source.source.occurrences[ordinal]!;
      if (
        resolveLocalizationSourceIdentity(project.localization, source.source, candidate)
          .messageId === messageId
      )
        return 'lua';
    }
  }
  for (const source of collectRmlLocalizationSources(project)) {
    for (const candidate of source.source.occurrences) {
      if (
        resolveLocalizationSourceIdentity(project.localization, source.source, candidate)
          .messageId === messageId
      )
        return 'rml';
    }
  }
  return null;
}

export function canPromoteLocalMessage(project: AuthoringProject, messageId: string): boolean {
  const view = localizationMessageWorkflowView(project, messageId);
  return (
    view?.kind === 'local' &&
    (rewriteableStructuredMessage(project, messageId) ||
      localSourceFamily(project, messageId) !== null)
  );
}

export function identicalSourceReuseCandidates(
  project: AuthoringProject,
  messageId: string,
): readonly MessageReuseCandidate[] {
  const canonical = localizationMessageWorkflowView(project, messageId);
  if (!canonical || canonical.kind !== 'local') return [];
  return localizationMessageWorkflowViews(project)
    .filter(
      (candidate) =>
        candidate.id !== messageId &&
        candidate.kind === 'local' &&
        candidate.source === canonical.source,
    )
    .map((candidate) => ({
      id: candidate.id,
      source: candidate.source,
      usedIn: candidate.usedIn,
      rewriteable: canPromoteLocalMessage(project, candidate.id),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** Rewrites every recognized named-Message reference. Ordinary strings are never treated as keys. */
export function renameMessageValueReferencePatches(
  project: AuthoringProject,
  fromKey: string,
  toKey: string,
): MessageReferenceRenamePatch[] {
  const patches: MessageReferenceRenamePatch[] = [];

  const visit = (value: unknown, segments: string[]) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...segments, String(index)]));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length === 1 && record.$message === fromKey) {
      patches.push({
        op: 'replace',
        path: buildJsonPointer([...segments, '$message']),
        value: toKey,
      });
      return;
    }
    if (record.kind === 'localized' && record.key === fromKey && segments.at(-1) === 'source') {
      patches.push({ op: 'replace', path: buildJsonPointer([...segments, 'key']), value: toKey });
      return;
    }
    for (const [key, item] of Object.entries(record)) visit(item, [...segments, key]);
  };
  visit(project, []);

  const changedSourceKeys = new Set<string>();
  for (const source of collectManagedLuaLocalizationSources(project)) {
    const edits = analyzeManagedLuaLocalization(source.text)
      .occurrences.filter(
        (occurrence) => occurrence.kind === 'named' && occurrence.source === fromKey,
      )
      .map((occurrence) => ({
        start: occurrence.sourceLiteral.regionStartUtf16,
        end: occurrence.sourceLiteral.regionEndUtf16,
        replacement: luaQuote(toKey),
      }));
    if (edits.length > 0) {
      changedSourceKeys.add(source.sourceKey);
      patches.push({
        op: 'replace',
        path: source.source.sourcePath,
        value: replaceRanges(source.text, edits),
      });
    }
  }

  for (const source of collectRmlLocalizationSources(project)) {
    const pattern = /(<nt-tr\b[^>]*\bkey\s*=\s*)(["'])([^"']*)(\2)/giu;
    let changed = false;
    const value = source.text.replace(
      pattern,
      (match, prefix: string, quote: string, key: string) => {
        if (key.trim() !== fromKey) return match;
        changed = true;
        return `${prefix}${quote}${toKey}${quote}`;
      },
    );
    if (changed) patches.push({ op: 'replace', path: source.source.sourcePath, value });
  }

  if (changedSourceKeys.size > 0) {
    const candidateProject = authoringProjectSchema.parse(
      applyJsonPatch(toJsonValue(project), patches as unknown as JsonPatchOperation[]).document,
    );
    const synchronized = synchronizeLocalizationMessageTracking(candidateProject);
    const refreshedTracking = structuredClone(project.localization.sourceMessageTracking);
    for (const sourceKey of changedSourceKeys) {
      const refreshed = synchronized.project.localization.sourceMessageTracking[sourceKey];
      if (refreshed) refreshedTracking[sourceKey] = refreshed;
      else delete refreshedTracking[sourceKey];
    }
    if (
      JSON.stringify(refreshedTracking) !==
      JSON.stringify(project.localization.sourceMessageTracking)
    )
      patches.push({
        op: 'replace',
        path: '/localization/sourceMessageTracking',
        value: refreshedTracking,
      });
  }

  return patches;
}

function sameTranslation(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function usagePathsMatch(left: string | null, right: string): boolean {
  if (!left) return false;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function remapLocalUsageNotesToNamed(
  before: AuthoringProject,
  after: AuthoringProject,
  localMessageIds: readonly string[],
  namedMessageId: string,
): LocalizationMessagePatch[] {
  const namedUsages = namedMessageUsages(after, namedMessageId);
  const patches: LocalizationMessagePatch[] = [];
  for (const localMessageId of localMessageIds) {
    const note = before.localization.usageNotes[localMessageId];
    if (note === undefined) continue;
    const localView = localizationMessageWorkflowView(before, localMessageId);
    const matches = namedUsages.filter((usage) =>
      usagePathsMatch(localView?.usedIn ?? null, usage.path),
    );
    if (matches.length !== 1) continue;
    const usageId = matches[0]!.id;
    patches.push({
      op: Object.hasOwn(before.localization.usageNotes, usageId) ? 'replace' : 'add',
      path: `/localization/usageNotes/${escapePointer(usageId)}`,
      value: note,
    });
    if (usageId !== localMessageId)
      patches.push({
        op: 'remove',
        path: `/localization/usageNotes/${escapePointer(localMessageId)}`,
      });
  }
  return patches;
}

function stableFreeFormUsageId(
  family: 'lua' | 'rml',
  sourceKey: string,
  structuralFingerprint: string,
  anchorFingerprint: string,
): string {
  return `${family}:${sourceKey}:${localizationTrackingFingerprint(
    `${structuralFingerprint}\u0000${anchorFingerprint}`,
  )}`;
}

type NamedMessageUsageDetail = NamedMessageUsage &
  (
    | { family: 'structured'; messagePath: string }
    | { family: 'typed' }
    | { family: 'lua'; sourceKey: string; start: number }
    | { family: 'rml'; sourceKey: string; start: number; end: number }
  );

function namedMessageUsageDetails(
  project: AuthoringProject,
  messageId: string,
): NamedMessageUsageDetail[] {
  const message = project.localization.messages[messageId];
  if (!message || message.kind !== 'named') return [];
  const usages: NamedMessageUsageDetail[] = [];
  const visit = (value: unknown, segments: string[]) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...segments, String(index)]));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const source = record.source;
    if (
      source &&
      typeof source === 'object' &&
      !Array.isArray(source) &&
      (source as Record<string, unknown>).kind === 'localized' &&
      (source as Record<string, unknown>).key === message.key &&
      (record.markup === 'plain' || record.markup === 'active-text')
    ) {
      const messagePath = buildJsonPointer(segments);
      const path = `${messagePath}/source`;
      usages.push({
        id: `structured:${path}`,
        path,
        rewriteable: true,
        family: 'structured',
        messagePath,
      });
      return;
    }
    if (Object.keys(record).length === 1 && record.$message === message.key) {
      const path = buildJsonPointer([...segments, '$message']);
      usages.push({ id: `typed:${path}`, path, rewriteable: false, family: 'typed' });
      return;
    }
    for (const [childKey, child] of Object.entries(record)) visit(child, [...segments, childKey]);
  };
  visit(project, []);

  for (const source of collectManagedLuaLocalizationSources(project)) {
    analyzeManagedLuaLocalization(source.text).occurrences.forEach((occurrence, ordinal) => {
      if (occurrence.kind !== 'named' || occurrence.source !== message.key) return;
      const candidate = source.source.occurrences[ordinal];
      if (!candidate) return;
      usages.push({
        id: stableFreeFormUsageId(
          'lua',
          source.sourceKey,
          candidate.structuralFingerprint,
          candidate.anchorFingerprint,
        ),
        path: source.source.sourcePath,
        rewriteable: true,
        family: 'lua',
        sourceKey: source.sourceKey,
        start: occurrence.callStartUtf16,
      });
    });
  }

  const rmlPattern =
    /<nt-tr\b[^>]*\bkey\s*=\s*(["'])([^"']*)\1[^>]*(?:\/\s*>|>[\s\S]*?<\/nt-tr\s*>)/giu;
  for (const source of collectRmlLocalizationSources(project)) {
    for (const match of source.text.matchAll(rmlPattern)) {
      if ((match[2] ?? '').trim() !== message.key || match.index === undefined) continue;
      const normalizedMarkup = match[0]
        .replace(/\bkey\s*=\s*(["'])[^"']*\1/iu, 'key=<message>')
        .replace(/\s+/gu, ' ')
        .trim();
      const before = source.text
        .slice(Math.max(0, match.index - 128), match.index)
        .replace(/\s+/gu, ' ')
        .trim();
      const end = match.index + match[0].length;
      const after = source.text
        .slice(end, Math.min(source.text.length, end + 128))
        .replace(/\s+/gu, ' ')
        .trim();
      usages.push({
        id: stableFreeFormUsageId(
          'rml',
          source.sourceKey,
          localizationTrackingFingerprint(normalizedMarkup),
          localizationTrackingFingerprint(`${before}|<nt-tr>|${after}`),
        ),
        path: source.source.sourcePath,
        rewriteable: true,
        family: 'rml',
        sourceKey: source.sourceKey,
        start: match.index,
        end,
      });
    }
  }
  return usages.sort((left, right) => left.id.localeCompare(right.id));
}

export function namedMessageUsages(
  project: AuthoringProject,
  messageId: string,
): readonly NamedMessageUsage[] {
  return Object.freeze(
    namedMessageUsageDetails(project, messageId).map(({ id, path, rewriteable }) => ({
      id,
      path,
      rewriteable,
    })),
  );
}

export function demoteNamedMessageUsage(
  project: AuthoringProject,
  messageId: string,
  usageId: string,
  options: Readonly<{ newMessageId?: string; copyDraftLocales: readonly string[] }>,
): DemoteNamedMessageResult {
  const message = project.localization.messages[messageId];
  if (!message || message.kind !== 'named')
    return { ok: false, message: 'Only a named Message can be made local.' };
  const usages = namedMessageUsageDetails(project, messageId);
  const usage = usages.find((candidate) => candidate.id === usageId);
  if (!usage || !usage.rewriteable)
    return { ok: false, message: 'The selected named Message usage cannot be made local.' };

  const preserveIdentity = usages.length === 1;
  const localMessageId = preserveIdentity ? messageId : options.newMessageId;
  const usageNote = project.localization.usageNotes[usageId];
  if (!localMessageId)
    return {
      ok: false,
      message: 'Making one of several named usages local requires a new Message ID.',
    };
  if (!preserveIdentity && localMessageId === messageId)
    return { ok: false, message: 'The new local Message must have an independent Message ID.' };

  const patches: LocalizationMessagePatch[] = [];
  if (usageNote !== undefined) {
    patches.push({
      op: Object.hasOwn(project.localization.usageNotes, localMessageId!) ? 'replace' : 'add',
      path: `/localization/usageNotes/${escapePointer(localMessageId!)}`,
      value: usageNote,
    });
    if (usageId !== localMessageId)
      patches.push({ op: 'remove', path: `/localization/usageNotes/${escapePointer(usageId)}` });
  }
  let changedSourceKey: string | null = null;
  if (usage.family === 'structured') {
    patches.push({
      op: 'replace',
      path: usage.path,
      value: { kind: 'inline', text: message.source },
    });
    patches.push({
      op: Object.hasOwn(project.localization.structuredMessageIds, usage.messagePath)
        ? 'replace'
        : 'add',
      path: `/localization/structuredMessageIds/${escapePointer(usage.messagePath)}`,
      value: localMessageId,
    });
  } else if (usage.family === 'lua') {
    const source = collectManagedLuaLocalizationSources(project).find(
      (candidate) => candidate.sourceKey === usage.sourceKey,
    );
    if (!source) return { ok: false, message: 'The selected Lua Message usage no longer exists.' };
    const occurrence = analyzeManagedLuaLocalization(source.text).occurrences.find(
      (candidate) => candidate.kind === 'named' && candidate.callStartUtf16 === usage.start,
    );
    if (!occurrence)
      return { ok: false, message: 'The selected Lua Message usage no longer exists.' };
    const args =
      occurrence.runtimeArgsStartUtf16 === undefined
        ? ''
        : `, ${source.text.slice(occurrence.runtimeArgsStartUtf16, occurrence.runtimeArgsEndUtf16)}`;
    const metadataEntries = [
      message.context === undefined ? null : `context = ${luaQuote(message.context)}`,
      message.translatorNote === undefined ? null : `note = ${luaQuote(message.translatorNote)}`,
    ].filter((entry): entry is string => entry !== null);
    const metadata = metadataEntries.length > 0 ? `, { ${metadataEntries.join(', ')} }` : '';
    const nilArgs = metadata && !args ? ', nil' : '';
    patches.push({
      op: 'replace',
      path: source.source.sourcePath,
      value: replaceRanges(source.text, [
        {
          start: occurrence.callStartUtf16,
          end: occurrence.callEndUtf16,
          replacement: `Text.tr(${luaQuote(message.source)}${args}${nilArgs}${metadata})`,
        },
      ]),
    });
    changedSourceKey = usage.sourceKey;
  } else if (usage.family === 'rml') {
    const source = collectRmlLocalizationSources(project).find(
      (candidate) => candidate.sourceKey === usage.sourceKey,
    );
    if (!source) return { ok: false, message: 'The selected RML Message usage no longer exists.' };
    const authored = source.text.slice(usage.start, usage.end);
    const openEnd = authored.indexOf('>');
    if (openEnd < 0) return { ok: false, message: 'The selected RML Message usage is malformed.' };
    const openTag = authored.slice(0, openEnd + 1).replace(/\s+key\s*=\s*(["'])[^"']*\1/iu, '');
    const replacement = /\/\s*>$/u.test(openTag)
      ? `${openTag.replace(/\/\s*>$/u, '>')}${message.source}</nt-tr>`
      : `${openTag}${message.source}</nt-tr>`;
    patches.push({
      op: 'replace',
      path: source.source.sourcePath,
      value: replaceRanges(source.text, [{ start: usage.start, end: usage.end, replacement }]),
    });
    changedSourceKey = usage.sourceKey;
  } else {
    return { ok: false, message: 'Typed Message references must remain named references.' };
  }

  const refreshChangedTracking = () => {
    if (!changedSourceKey) return null;
    const candidateProject = authoringProjectSchema.parse(
      applyJsonPatch(toJsonValue(project), patches as unknown as JsonPatchOperation[]).document,
    );
    const synchronized = synchronizeLocalizationMessageTracking(candidateProject);
    const unresolved = synchronized.unresolved.find(
      (item) => `${item.family}:${item.ownerKey}:${item.sourcePath}` === changedSourceKey,
    );
    if (unresolved)
      return `Localization tracking for '${unresolved.sourcePath}' became ambiguous during demotion.`;
    const tracking = structuredClone(synchronized.project.localization.sourceMessageTracking);
    const entry = tracking[changedSourceKey];
    if (!entry) return 'The demoted Message did not produce localization tracking.';
    const previousIds = new Set(
      project.localization.sourceMessageTracking[changedSourceKey]?.occurrences.map(
        (occurrence) => occurrence.messageId,
      ) ?? [],
    );
    const occurrence =
      entry.occurrences.find(
        (candidate) =>
          candidate.sourceSnapshot === message.source && !previousIds.has(candidate.messageId),
      ) ?? entry.occurrences.find((candidate) => candidate.sourceSnapshot === message.source);
    if (!occurrence) return 'The demoted Message could not be identified in localization tracking.';
    occurrence.messageId = localMessageId;
    patches.push({
      op: 'replace',
      path: '/localization/sourceMessageTracking',
      value: tracking,
    });
    return null;
  };

  if (preserveIdentity) {
    patches.push({
      op: 'remove',
      path: `/localization/messages/${escapePointer(messageId)}`,
    });
    const trackingError = refreshChangedTracking();
    if (trackingError) return { ok: false, message: trackingError };
    return { ok: true, patches, messageId: localMessageId, copiedLocales: [] };
  }

  const copiedLocales: string[] = [];
  for (const locale of options.copyDraftLocales) {
    const sourceTarget = project.localization.translations[locale]?.[messageId];
    if (!sourceTarget) continue;
    const localeTargets = project.localization.translations[locale];
    const copiedTarget = { ...sourceTarget, review: 'needs-review' as const };
    if (!localeTargets) {
      patches.push({
        op: 'add',
        path: `/localization/translations/${escapePointer(locale)}`,
        value: { [localMessageId]: copiedTarget },
      });
    } else {
      patches.push({
        op: Object.hasOwn(localeTargets, localMessageId) ? 'replace' : 'add',
        path: `/localization/translations/${escapePointer(locale)}/${escapePointer(localMessageId)}`,
        value: copiedTarget,
      });
    }
    copiedLocales.push(locale);
  }
  const trackingError = refreshChangedTracking();
  if (trackingError) return { ok: false, message: trackingError };
  return { ok: true, patches, messageId: localMessageId, copiedLocales };
}

function rewriteLocalMessageIntoNamed(
  project: AuthoringProject,
  messageId: string,
  key: string,
): PromoteAndLinkResult {
  const patches: LocalizationMessagePatch[] = [];
  const structured = structuredMessageById(project, messageId);
  if (structured?.text?.source.kind === 'inline') {
    patches.push({
      op: 'replace',
      path: `${structured.path}/source`,
      value: { kind: 'localized', key },
    });
    if (Object.hasOwn(project.localization.structuredMessageIds, structured.path))
      patches.push({
        op: 'remove',
        path: `/localization/structuredMessageIds/${escapePointer(structured.path)}`,
      });
  }

  const changedSourceKeys = new Set<string>();
  for (const source of collectManagedLuaLocalizationSources(project)) {
    const analyzed = analyzeManagedLuaLocalization(source.text);
    const edits: { start: number; end: number; replacement: string }[] = [];
    analyzed.occurrences.forEach((occurrence, ordinal) => {
      if (occurrence.kind !== 'local') return;
      const candidate = source.source.occurrences[ordinal];
      if (!candidate) return;
      const id = resolveLocalizationSourceIdentity(
        project.localization,
        source.source,
        candidate,
      ).messageId;
      if (id !== messageId) return;
      const args =
        occurrence.runtimeArgsStartUtf16 === undefined
          ? ''
          : `, ${source.text.slice(occurrence.runtimeArgsStartUtf16, occurrence.runtimeArgsEndUtf16)}`;
      edits.push({
        start: occurrence.callStartUtf16,
        end: occurrence.callEndUtf16,
        replacement: `Text.msg(${luaQuote(key)}${args})`,
      });
    });
    if (edits.length > 0) {
      changedSourceKeys.add(source.sourceKey);
      patches.push({
        op: 'replace',
        path: source.source.sourcePath,
        value: replaceRanges(source.text, edits),
      });
    }
  }

  for (const source of collectRmlLocalizationSources(project)) {
    const edits: { start: number; end: number; replacement: string }[] = [];
    source.localNodes.forEach((node, ordinal) => {
      const candidate = source.source.occurrences[ordinal];
      if (!candidate) return;
      const id = resolveLocalizationSourceIdentity(
        project.localization,
        source.source,
        candidate,
      ).messageId;
      if (id !== messageId) return;
      const openTag = node.selfClosing
        ? node.openTag.replace(/\/\s*>$/u, ` key=${JSON.stringify(key)} />`)
        : node.openTag.replace(/>$/u, ` key=${JSON.stringify(key)}>`);
      edits.push({
        start: node.start,
        end: node.end,
        replacement: node.selfClosing ? openTag : `${openTag}</nt-tr>`,
      });
    });
    if (edits.length > 0) {
      changedSourceKeys.add(source.sourceKey);
      patches.push({
        op: 'replace',
        path: source.source.sourcePath,
        value: replaceRanges(source.text, edits),
      });
    }
  }

  if (patches.length === 0)
    return {
      ok: false,
      message: 'This local Message does not have a supported merge refactor path.',
    };

  const tracking = structuredClone(project.localization.sourceMessageTracking);
  let trackingChanged = false;
  for (const [trackingKey, entry] of Object.entries(tracking)) {
    const occurrences = entry.occurrences.filter(
      (occurrence) => occurrence.messageId !== messageId,
    );
    if (occurrences.length === entry.occurrences.length) continue;
    trackingChanged = true;
    if (occurrences.length === 0) delete tracking[trackingKey];
    else tracking[trackingKey] = { ...entry, occurrences };
  }
  if (trackingChanged)
    patches.push({ op: 'replace', path: '/localization/sourceMessageTracking', value: tracking });

  if (changedSourceKeys.size > 0) {
    const candidateProject = authoringProjectSchema.parse(
      applyJsonPatch(toJsonValue(project), patches as unknown as JsonPatchOperation[]).document,
    );
    const synchronized = synchronizeLocalizationMessageTracking(candidateProject);
    const unresolvedChangedSource = synchronized.unresolved.find((item) =>
      changedSourceKeys.has(`${item.family}:${item.ownerKey}:${item.sourcePath}`),
    );
    if (unresolvedChangedSource)
      return {
        ok: false,
        message: `Localization tracking for '${unresolvedChangedSource.sourcePath}' became ambiguous during merge.`,
      };
    const refreshedTracking = structuredClone(tracking);
    for (const sourceKey of changedSourceKeys) {
      const refreshed = synchronized.project.localization.sourceMessageTracking[sourceKey];
      if (refreshed) refreshedTracking[sourceKey] = refreshed;
      else delete refreshedTracking[sourceKey];
    }
    const trackingPatch = patches.find(
      (patch) => patch.path === '/localization/sourceMessageTracking',
    );
    if (trackingPatch && trackingPatch.op !== 'remove') trackingPatch.value = refreshedTracking;
    else if (
      JSON.stringify(refreshedTracking) !==
      JSON.stringify(project.localization.sourceMessageTracking)
    )
      patches.push({
        op: 'replace',
        path: '/localization/sourceMessageTracking',
        value: refreshedTracking,
      });
  }
  const after = authoringProjectSchema.parse(
    applyJsonPatch(toJsonValue(project), patches as unknown as JsonPatchOperation[]).document,
  );
  const namedMessageId = Object.entries(after.localization.messages).find(
    ([, message]) => message.kind === 'named' && message.key === key,
  )?.[0];
  if (namedMessageId)
    patches.push(...remapLocalUsageNotesToNamed(project, after, [messageId], namedMessageId));
  return { ok: true, patches };
}

export function mergeMessageIntoNamed(
  project: AuthoringProject,
  sourceMessageId: string,
  targetMessageId: string,
  resolutions: Readonly<Record<string, MergeMessageResolution>>,
): MergeMessageResult {
  if (sourceMessageId === targetMessageId)
    return { ok: false, message: 'Choose two different Messages to merge.' };
  const source = localizationMessageWorkflowView(project, sourceMessageId);
  const target = localizationMessageWorkflowView(project, targetMessageId);
  const targetMessage = project.localization.messages[targetMessageId];
  if (!source) return { ok: false, message: `Message '${sourceMessageId}' does not exist.` };
  if (!target || !targetMessage || targetMessage.kind !== 'named')
    return { ok: false, message: 'The merge target must be a named Message.' };

  const conflicts: string[] = [];
  for (const locale of Object.keys(project.localization.locales)) {
    const sourceTarget = project.localization.translations[locale]?.[sourceMessageId];
    const targetTarget = project.localization.translations[locale]?.[targetMessageId];
    if (
      sourceTarget &&
      targetTarget &&
      !sameTranslation(sourceTarget, targetTarget) &&
      !resolutions[locale]
    )
      conflicts.push(locale);
  }
  if (conflicts.length > 0)
    return {
      ok: false,
      message: `Target work for locale '${conflicts[0]}' conflicts; choose which translation to keep.`,
      conflicts,
    };

  const patches: LocalizationMessagePatch[] = [];
  if (source.kind === 'local') {
    const rewrite = rewriteLocalMessageIntoNamed(project, sourceMessageId, targetMessage.key);
    if (!rewrite.ok) return rewrite;
    patches.push(...rewrite.patches);
  } else {
    const sourceMessage = project.localization.messages[sourceMessageId];
    if (!sourceMessage || sourceMessage.kind !== 'named')
      return { ok: false, message: 'The source Message cannot be merged.' };
    patches.push(
      ...renameMessageValueReferencePatches(project, sourceMessage.key, targetMessage.key),
    );
    patches.push({
      op: 'remove',
      path: `/localization/messages/${escapePointer(sourceMessageId)}`,
    });
  }

  for (const locale of Object.keys(project.localization.locales)) {
    const localeTargets = project.localization.translations[locale];
    if (!localeTargets) continue;
    const sourceTarget = localeTargets[sourceMessageId];
    const targetTarget = localeTargets[targetMessageId];
    const resolution = resolutions[locale];
    if (sourceTarget && (!targetTarget || resolution === 'source')) {
      const selected =
        source.sourceFingerprint === target.sourceFingerprint
          ? sourceTarget
          : {
              ...sourceTarget,
              sourceFingerprint: target.sourceFingerprint,
              review: 'needs-review' as const,
            };
      patches.push({
        op: targetTarget ? 'replace' : 'add',
        path: `/localization/translations/${escapePointer(locale)}/${escapePointer(targetMessageId)}`,
        value: selected,
      });
    }
    if (sourceTarget)
      patches.push({
        op: 'remove',
        path: `/localization/translations/${escapePointer(locale)}/${escapePointer(sourceMessageId)}`,
      });
  }

  return { ok: true, patches };
}

export function promoteAndLinkLocalMessages(
  project: AuthoringProject,
  canonicalMessageId: string,
  key: string,
  linkedMessageIds: readonly string[],
): PromoteAndLinkResult {
  const canonical = localizationMessageWorkflowView(project, canonicalMessageId);
  if (!canonical || canonical.kind !== 'local')
    return { ok: false, message: 'Only a local Message can be promoted.' };
  if (!canPromoteLocalMessage(project, canonicalMessageId))
    return {
      ok: false,
      message: 'The canonical Message does not have a supported named-reference refactor path.',
    };
  if (
    Object.entries(project.localization.messages).some(
      ([id, message]) =>
        id !== canonicalMessageId && message.kind === 'named' && message.key === key,
    )
  )
    return { ok: false, message: `Named Message key '${key}' already exists.` };

  const selected = [...new Set([canonicalMessageId, ...linkedMessageIds])];
  for (const id of selected) {
    const view = localizationMessageWorkflowView(project, id);
    if (!view || view.kind !== 'local')
      return { ok: false, message: `Message '${id}' is not a local Message.` };
    if (!canPromoteLocalMessage(project, id))
      return {
        ok: false,
        message: `Message '${id}' does not have a supported named-reference refactor path.`,
      };
    if (id !== canonicalMessageId && view.source !== canonical.source)
      return { ok: false, message: 'Selected Messages must have identical source content.' };
    if (
      id !== canonicalMessageId &&
      (view.context !== canonical.context || view.translatorNote !== canonical.translatorNote)
    )
      return {
        ok: false,
        message:
          'Selected Messages have different translator guidance; reconcile it before linking.',
      };
  }

  for (const locale of Object.keys(project.localization.locales)) {
    const targets = selected
      .map((id) => project.localization.translations[locale]?.[id])
      .filter((target) => target !== undefined);
    const firstTarget = targets[0];
    if (firstTarget && targets.some((target) => !sameTranslation(firstTarget, target)))
      return {
        ok: false,
        message: `Target work for locale '${locale}' differs; resolve that conflict before linking these Messages.`,
      };
  }

  const patches: LocalizationMessagePatch[] = [];
  const existingCanonical = project.localization.messages[canonicalMessageId];
  const namedMessage: AuthoringMessage = {
    kind: 'named',
    key,
    source: canonical.source,
    ...(canonical.context === undefined ? {} : { context: canonical.context }),
    ...(canonical.translatorNote === undefined ? {} : { translatorNote: canonical.translatorNote }),
  };
  patches.push({
    op: existingCanonical ? 'replace' : 'add',
    path: `/localization/messages/${escapePointer(canonicalMessageId)}`,
    value: namedMessage,
  });

  for (const locale of Object.keys(project.localization.locales)) {
    const localeTargets = project.localization.translations[locale];
    if (!localeTargets) continue;
    let canonicalTarget = localeTargets[canonicalMessageId];
    for (const id of selected) {
      if (id === canonicalMessageId) continue;
      const candidateTarget = localeTargets[id];
      if (!candidateTarget) continue;
      if (!canonicalTarget) {
        patches.push({
          op: 'add',
          path: `/localization/translations/${escapePointer(locale)}/${escapePointer(canonicalMessageId)}`,
          value: candidateTarget,
        });
        canonicalTarget = candidateTarget;
      }
      patches.push({
        op: 'remove',
        path: `/localization/translations/${escapePointer(locale)}/${escapePointer(id)}`,
      });
    }
  }

  for (const id of selected) {
    const structured = structuredMessageById(project, id);
    if (structured?.text?.source.kind === 'inline') {
      patches.push({
        op: 'replace',
        path: `${structured.path}/source`,
        value: { kind: 'localized', key },
      });
      if (Object.hasOwn(project.localization.structuredMessageIds, structured.path))
        patches.push({
          op: 'remove',
          path: `/localization/structuredMessageIds/${escapePointer(structured.path)}`,
        });
    }
  }

  const selectedSet = new Set(selected);
  const changedSourceKeys = new Set<string>();
  for (const source of collectManagedLuaLocalizationSources(project)) {
    const analyzed = analyzeManagedLuaLocalization(source.text);
    const edits: { start: number; end: number; replacement: string }[] = [];
    analyzed.occurrences.forEach((occurrence, ordinal) => {
      if (occurrence.kind !== 'local') return;
      const candidate = source.source.occurrences[ordinal];
      if (!candidate) return;
      const id = resolveLocalizationSourceIdentity(
        project.localization,
        source.source,
        candidate,
      ).messageId;
      if (!selectedSet.has(id)) return;
      const args =
        occurrence.runtimeArgsStartUtf16 === undefined
          ? ''
          : `, ${source.text.slice(occurrence.runtimeArgsStartUtf16, occurrence.runtimeArgsEndUtf16)}`;
      edits.push({
        start: occurrence.callStartUtf16,
        end: occurrence.callEndUtf16,
        replacement: `Text.msg(${luaQuote(key)}${args})`,
      });
    });
    if (edits.length > 0) {
      changedSourceKeys.add(source.sourceKey);
      patches.push({
        op: 'replace',
        path: source.source.sourcePath,
        value: replaceRanges(source.text, edits),
      });
    }
  }

  for (const source of collectRmlLocalizationSources(project)) {
    const edits: { start: number; end: number; replacement: string }[] = [];
    source.localNodes.forEach((node, ordinal) => {
      const candidate = source.source.occurrences[ordinal];
      if (!candidate) return;
      const id = resolveLocalizationSourceIdentity(
        project.localization,
        source.source,
        candidate,
      ).messageId;
      if (!selectedSet.has(id)) return;
      const openTag = node.selfClosing
        ? node.openTag.replace(/\/\s*>$/u, ` key=${JSON.stringify(key)} />`)
        : node.openTag.replace(/>$/u, ` key=${JSON.stringify(key)}>`);
      edits.push({
        start: node.start,
        end: node.end,
        replacement: node.selfClosing ? openTag : `${openTag}</nt-tr>`,
      });
    });
    if (edits.length > 0) {
      changedSourceKeys.add(source.sourceKey);
      patches.push({
        op: 'replace',
        path: source.source.sourcePath,
        value: replaceRanges(source.text, edits),
      });
    }
  }

  const tracking = structuredClone(project.localization.sourceMessageTracking);
  let trackingChanged = false;
  for (const [trackingKey, entry] of Object.entries(tracking)) {
    const occurrences = entry.occurrences.filter(
      (occurrence) => !selectedSet.has(occurrence.messageId),
    );
    if (occurrences.length === entry.occurrences.length) continue;
    trackingChanged = true;
    if (occurrences.length === 0) delete tracking[trackingKey];
    else tracking[trackingKey] = { ...entry, occurrences };
  }
  if (trackingChanged)
    patches.push({ op: 'replace', path: '/localization/sourceMessageTracking', value: tracking });

  for (const id of selected) {
    if (id === canonicalMessageId) continue;
    if (project.localization.messages[id])
      patches.push({ op: 'remove', path: `/localization/messages/${escapePointer(id)}` });
  }

  if (changedSourceKeys.size > 0) {
    const candidateProject = authoringProjectSchema.parse(
      applyJsonPatch(toJsonValue(project), patches as unknown as JsonPatchOperation[]).document,
    );
    const synchronized = synchronizeLocalizationMessageTracking(candidateProject);
    const unresolvedChangedSource = synchronized.unresolved.find((item) =>
      changedSourceKeys.has(`${item.family}:${item.ownerKey}:${item.sourcePath}`),
    );
    if (unresolvedChangedSource)
      return {
        ok: false,
        message: `Localization tracking for '${unresolvedChangedSource.sourcePath}' became ambiguous during promotion.`,
      };

    const refreshedTracking = structuredClone(tracking);
    for (const sourceKey of changedSourceKeys) {
      const refreshed = synchronized.project.localization.sourceMessageTracking[sourceKey];
      if (refreshed) refreshedTracking[sourceKey] = refreshed;
      else delete refreshedTracking[sourceKey];
    }
    const trackingPatch = patches.find(
      (patch) => patch.path === '/localization/sourceMessageTracking',
    );
    if (trackingPatch && trackingPatch.op !== 'remove') trackingPatch.value = refreshedTracking;
    else if (
      JSON.stringify(refreshedTracking) !==
      JSON.stringify(project.localization.sourceMessageTracking)
    )
      patches.push({
        op: 'replace',
        path: '/localization/sourceMessageTracking',
        value: refreshedTracking,
      });
  }

  const after = authoringProjectSchema.parse(
    applyJsonPatch(toJsonValue(project), patches as unknown as JsonPatchOperation[]).document,
  );
  patches.push(...remapLocalUsageNotesToNamed(project, after, selected, canonicalMessageId));
  return { ok: true, patches };
}
