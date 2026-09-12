import { describe, expect, it } from 'vite-plus/test';
import { synchronizeLocalizationMessageTracking } from '../../shared/authoring-localization-sync';
import { collectManagedLuaLocalizationSources } from '../../shared/authoring-lua-localization-lowering';
import { planLocalizationReconciliation } from '../../shared/authoring-localization-reconcile';
import {
  createLocalizationTranslation,
  localizationMessageWorkflowView,
} from '../../shared/authoring-localization-workflow';
import { resolveLocalizationSourceIdentity } from '../../shared/localization-source-tracking';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';

function projectWithManagedMessages() {
  const project = createAuthoringProject({ id: 'localization-sync', name: 'Localization Sync' });
  project.scripts.bootstrap!.data.source = {
    kind: 'inline-lua',
    source: 'local greeting = Text.tr("Hello")\nreturn greeting\n',
  };
  const layout = defaultLayoutData('HUD', 'document');
  layout.rml.sourceText = '<rml><body><p><nt-tr>Welcome</nt-tr></p></body></rml>';
  project.layouts.hud = { id: 'hud', label: 'HUD', data: layout };
  return project;
}

function trackedIds(project: ReturnType<typeof projectWithManagedMessages>): string[] {
  return Object.values(project.localization.sourceMessageTracking)
    .flatMap((entry) => entry.occurrences.map((occurrence) => occurrence.messageId))
    .sort();
}

describe('localization source tracking sync', () => {
  it('materializes deterministic Lua and RML identities without changing player-facing source', () => {
    const project = projectWithManagedMessages();
    const luaBefore = project.scripts.bootstrap!.data.source;
    const rmlBefore = project.layouts.hud!.data.rml.sourceText;

    const synced = synchronizeLocalizationMessageTracking(project);

    expect(synced.changed).toBe(true);
    expect(synced.materializedMessageIds).toHaveLength(2);
    expect(synced.unresolved).toEqual([]);
    expect(synced.project.scripts.bootstrap!.data.source).toEqual(luaBefore);
    expect(synced.project.layouts.hud!.data.rml.sourceText).toEqual(rmlBefore);
    expect(Object.values(synced.project.localization.sourceMessageTracking)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ family: 'lua', ownerKey: 'record:scripts:bootstrap' }),
        expect.objectContaining({ family: 'rml', ownerKey: 'record:layouts:hud' }),
      ]),
    );

    const repeated = synchronizeLocalizationMessageTracking(synced.project);
    expect(repeated.changed).toBe(false);
    expect(trackedIds(repeated.project)).toEqual(trackedIds(synced.project));
  });

  it('preserves identity across unambiguous local source edits and movement', () => {
    const first = synchronizeLocalizationMessageTracking(projectWithManagedMessages()).project;
    const before = trackedIds(first);

    first.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source:
        '-- moved below helper\nlocal helper = 1\nlocal greeting = Text.tr("Hello again")\nreturn greeting\n',
    };
    first.layouts.hud!.data.rml.sourceText =
      '<rml><body><section><p><nt-tr>Welcome back</nt-tr></p></section></body></rml>';

    const second = synchronizeLocalizationMessageTracking(first);
    expect(second.unresolved).toEqual([]);
    expect([...second.preservedMessageIds].sort()).toEqual(before);
    expect(trackedIds(second.project)).toEqual(before);
  });

  it('preserves identity for an unambiguous move between Lua source owners', () => {
    const project = createAuthoringProject({ id: 'moved-sync', name: 'Moved Sync' });
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: 'return Text.tr("Travel")\n',
    };
    const first = synchronizeLocalizationMessageTracking(project).project;
    const [messageId] = trackedIds(first);
    expect(messageId).toBeDefined();

    first.scripts.moved = structuredClone(first.scripts.bootstrap!);
    first.scripts.moved.id = 'moved';
    first.scripts.moved.label = 'Moved';
    first.scripts.bootstrap!.data.source = { kind: 'inline-lua', source: 'return nil\n' };

    const second = synchronizeLocalizationMessageTracking(first);
    expect(second.unresolved).toEqual([]);
    expect(second.preservedMessageIds).toEqual([messageId]);
    expect(trackedIds(second.project)).toEqual([messageId]);
    expect(
      Object.values(second.project.localization.sourceMessageTracking).find((entry) =>
        entry.occurrences.some((occurrence) => occurrence.messageId === messageId),
      )?.ownerKey,
    ).toBe('record:scripts:moved');
  });

  it('requires reconciliation instead of weakly relinking valuable work to unrelated source', () => {
    const project = createAuthoringProject({
      id: 'valuable-weak-match',
      name: 'Valuable Weak Match',
    });
    project.localization.locales.fr = { supported: false, parentLocale: null, fontStack: null };
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: 'return Text.tr("Farewell")\n',
    };
    const tracked = synchronizeLocalizationMessageTracking(project).project;
    const [messageId] = trackedIds(tracked);
    expect(messageId).toBeDefined();
    const original = localizationMessageWorkflowView(tracked, messageId!)!;
    tracked.localization.translations.fr = {
      [messageId!]: createLocalizationTranslation(original, 'Au revoir'),
    };

    tracked.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source:
        'local count = 2\nreturn Text.plural(count, { one = "{value} item", other = "{value} items" })\n',
    };

    const synced = synchronizeLocalizationMessageTracking(tracked);
    expect(synced.preservedMessageIds).not.toContain(messageId);
    expect(synced.unresolved).toEqual([
      expect.objectContaining({ family: 'lua', ownerKey: 'record:scripts:bootstrap', ordinal: 0 }),
    ]);

    const plan = planLocalizationReconciliation(tracked);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toMatchObject({
      requiresDecision: true,
      previousMessageIds: [messageId],
    });
  });

  it('does not passively share one tracked identity across a direct-file duplicate', () => {
    const project = createAuthoringProject({ id: 'duplicated-sync', name: 'Duplicated Sync' });
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: 'return Text.tr("Original")\n',
    };
    const first = synchronizeLocalizationMessageTracking(project).project;
    const [messageId] = trackedIds(first);
    expect(messageId).toBeDefined();

    first.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: [
        'local first = Text.tr("Original")',
        'local second = Text.tr("Original")',
        'return first .. second',
        '',
      ].join('\n'),
    };
    const changedSource = collectManagedLuaLocalizationSources(first)[0]!;
    const resolutions = changedSource.source.occurrences.map((occurrence) =>
      resolveLocalizationSourceIdentity(first.localization, changedSource.source, occurrence),
    );

    expect(resolutions.every((resolution) => !resolution.tracked)).toBe(true);
    expect(new Set(resolutions.map((resolution) => resolution.messageId)).size).toBe(2);
    expect(resolutions.map((resolution) => resolution.messageId)).not.toContain(messageId);
  });

  it('does not passively share identity when a managed occurrence is copied to another source path', () => {
    const project = createAuthoringProject({ id: 'cross-source-copy', name: 'Cross Source Copy' });
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: 'return Text.tr("Original")\n',
    };
    const first = synchronizeLocalizationMessageTracking(project).project;
    const source = collectManagedLuaLocalizationSources(first)[0]!.source;
    const occurrence = source.occurrences[0]!;
    const original = resolveLocalizationSourceIdentity(first.localization, source, occurrence);
    const copiedSource = {
      ...source,
      sourcePath: `${source.sourcePath}/copy`,
    };
    const copied = resolveLocalizationSourceIdentity(first.localization, copiedSource, occurrence);

    expect(original.tracked).toBe(true);
    expect(copied.tracked).toBe(false);
    expect(copied.messageId).not.toBe(original.messageId);
  });

  it('does not guess when multiple old and new occurrences have the same free-form structure', () => {
    const project = createAuthoringProject({ id: 'ambiguous-sync', name: 'Ambiguous Sync' });
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: [
        'local first = Text.tr("First")',
        'local second = Text.tr("Second")',
        'return first .. second',
        '',
      ].join('\n'),
    };
    expect(collectManagedLuaLocalizationSources(project)[0]?.occurrences).toHaveLength(2);
    const first = synchronizeLocalizationMessageTracking(project).project;
    const oldIds = trackedIds(first);
    expect(oldIds).toHaveLength(2);

    first.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: [
        'local alpha = Text.tr("Alpha")',
        'local beta = Text.tr("Beta")',
        'return beta .. alpha',
        '',
      ].join('\n'),
    };
    const changedSource = collectManagedLuaLocalizationSources(first)[0]!;
    const passiveResolutions = changedSource.source.occurrences.map((occurrence) =>
      resolveLocalizationSourceIdentity(first.localization, changedSource.source, occurrence),
    );
    expect(passiveResolutions.every((resolution) => !resolution.tracked)).toBe(true);
    expect(passiveResolutions.map((resolution) => resolution.messageId)).not.toEqual(
      expect.arrayContaining(oldIds),
    );

    const second = synchronizeLocalizationMessageTracking(first);

    expect(second.unresolved).toEqual([]);
    expect(second.materializedMessageIds).toHaveLength(2);
    expect(trackedIds(second.project)).toEqual([...second.materializedMessageIds].sort());
    expect(trackedIds(second.project)).not.toEqual(expect.arrayContaining(oldIds));
  });
});
