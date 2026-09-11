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
import { resolveLocalizationSourceIdentity } from '../../shared/localization-source-tracking';
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
  usageNote: string | null;
  rewriteable: boolean;
}

export type PromoteAndLinkResult =
  | { ok: true; patches: readonly LocalizationMessagePatch[] }
  | { ok: false; message: string };

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
      usageNote: candidate.usageNote,
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

  return { ok: true, patches };
}
