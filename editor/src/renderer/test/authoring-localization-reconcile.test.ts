import { describe, expect, it } from 'vite-plus/test';
import {
  applyLocalizationReconciliation,
  planLocalizationReconciliation,
} from '../../shared/authoring-localization-reconcile';
import { synchronizeLocalizationMessageTracking } from '../../shared/authoring-localization-sync';
import { packageMessageIds } from '../../shared/authoring-message-lowering';
import {
  createLocalizationTranslation,
  localizationMessageWorkflowViews,
} from '../../shared/authoring-localization-workflow';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

function duplicatedLuaProject() {
  const project = createAuthoringProject({ id: 'reconcile', name: 'Reconcile' });
  project.scripts.bootstrap!.data.source = {
    kind: 'inline-lua',
    source: 'return Text.tr("Original", nil, { note = "Keep this guidance" })\n',
  };
  const first = synchronizeLocalizationMessageTracking(project).project;
  const messageId = Object.values(first.localization.sourceMessageTracking)[0]!.occurrences[0]!
    .messageId;
  first.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
  const workflow = localizationMessageWorkflowViews(first).find((item) => item.id === messageId)!;
  first.localization.translations.fr = {
    [messageId]: createLocalizationTranslation(workflow, 'Original traduit', 'human', {
      review: 'reviewed',
    }),
  };
  first.scripts.bootstrap!.data.source = {
    kind: 'inline-lua',
    source: [
      'local first = Text.tr("Original", nil, { note = "Keep this guidance" })',
      'local second = Text.tr("Original", nil, { note = "Keep this guidance" })',
      'return first .. second',
      '',
    ].join('\n'),
  };
  return { project: first, messageId };
}

describe('localization reconciliation', () => {
  it('requires an explicit decision for a valuable one-to-many direct-file duplication', () => {
    const { project, messageId } = duplicatedLuaProject();

    const plan = planLocalizationReconciliation(project, 'workspace:one');

    expect(plan.expectedWorkspaceRevision).toBe('workspace:one');
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toMatchObject({
      requiresDecision: true,
      previousMessageIds: [messageId],
    });
    expect(plan.groups[0]!.currentOccurrences).toHaveLength(2);
    expect(plan.groups[0]!.previousOccurrences[0]).toMatchObject({
      messageId,
      sourceSnapshot: 'Original',
      translatorNoteSnapshot: 'Keep this guidance',
      valuable: true,
    });
  });

  it('preserves one chosen identity, gives the duplicate a new identity, and does not silently share', () => {
    const { project, messageId } = duplicatedLuaProject();
    const plan = planLocalizationReconciliation(project, 'workspace:one');
    const group = plan.groups[0]!;
    const keep = group.currentOccurrences.find((item) => item.ordinal === 0)!;
    const duplicate = group.currentOccurrences.find((item) => item.ordinal === 1)!;

    const applied = applyLocalizationReconciliation(project, plan, {
      [keep.id]: messageId,
      [duplicate.id]: 'new',
    });

    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') return;
    const tracked = Object.values(applied.project.localization.sourceMessageTracking).flatMap(
      (entry) => entry.occurrences.map((item) => item.messageId),
    );
    expect(tracked).toContain(messageId);
    expect(new Set(tracked).size).toBe(2);
    expect(applied.project.localization.orphanedMessages).toEqual({});
    expect(applied.project.localization.translations.fr?.[messageId]?.text).toBe(
      'Original traduit',
    );
  });

  it('moves valuable abandoned work to Orphaned storage and removes it from live locale chunks', () => {
    const { project, messageId } = duplicatedLuaProject();
    const plan = planLocalizationReconciliation(project, 'workspace:one');
    const group = plan.groups[0]!;
    const decisions = Object.fromEntries(group.currentOccurrences.map((item) => [item.id, 'new']));

    const applied = applyLocalizationReconciliation(project, plan, decisions);

    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') return;
    expect(applied.project.localization.translations.fr?.[messageId]).toBeUndefined();
    expect(applied.project.localization.orphanedMessages[messageId]).toMatchObject({
      occurrence: {
        messageId,
        sourceSnapshot: 'Original',
        translatorNoteSnapshot: 'Keep this guidance',
      },
      translations: {
        fr: { text: 'Original traduit', review: 'reviewed' },
      },
    });
    expect(packageMessageIds(applied.project).has(messageId)).toBe(false);
  });

  it('can relink later source work to an Orphaned Message and restore its translations', () => {
    const { project, messageId } = duplicatedLuaProject();
    const firstPlan = planLocalizationReconciliation(project, 'workspace:one');
    const first = applyLocalizationReconciliation(
      project,
      firstPlan,
      Object.fromEntries(firstPlan.groups[0]!.currentOccurrences.map((item) => [item.id, 'new'])),
    );
    expect(first.status).toBe('applied');
    if (first.status !== 'applied') return;

    first.project.scripts.bootstrap!.data.source = { kind: 'inline-lua', source: 'return nil\n' };
    const removalPlan = planLocalizationReconciliation(first.project, 'workspace:two');
    const removed = applyLocalizationReconciliation(first.project, removalPlan, {});
    expect(removed.status).toBe('applied');
    if (removed.status !== 'applied') return;
    expect(removed.project.localization.orphanedMessages).toHaveProperty(messageId);

    removed.project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: 'return Text.tr("Recovered")\n',
    };
    const recoveryPlan = planLocalizationReconciliation(removed.project, 'workspace:three');
    const recoveryGroup = recoveryPlan.groups.find((group) =>
      group.previousMessageIds.includes(messageId),
    )!;
    expect(recoveryGroup.previousOccurrences[0]).toMatchObject({
      messageId,
      origin: 'orphan',
      valuable: true,
    });

    const recovered = applyLocalizationReconciliation(removed.project, recoveryPlan, {
      [recoveryGroup.currentOccurrences[0]!.id]: messageId,
    });

    expect(recovered.status).toBe('applied');
    if (recovered.status !== 'applied') return;
    expect(recovered.project.localization.orphanedMessages[messageId]).toBeUndefined();
    expect(recovered.project.localization.translations.fr?.[messageId]?.text).toBe(
      'Original traduit',
    );
  });

  it('defaults many-to-many ambiguity to new identities and preserves valuable old work as Orphaned', () => {
    const project = createAuthoringProject({ id: 'many-to-many', name: 'Many to Many' });
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: [
        'local first = Text.tr("First")',
        'local second = Text.tr("Second")',
        'return first .. second',
        '',
      ].join('\n'),
    };
    const tracked = synchronizeLocalizationMessageTracking(project).project;
    const messageIds = Object.values(tracked.localization.sourceMessageTracking)
      .flatMap((entry) => entry.occurrences.map((occurrence) => occurrence.messageId))
      .sort();
    tracked.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
    const views = localizationMessageWorkflowViews(tracked);
    tracked.localization.translations.fr = Object.fromEntries(
      messageIds.map((messageId, index) => [
        messageId,
        createLocalizationTranslation(
          views.find((item) => item.id === messageId)!,
          index === 0 ? 'Premier' : 'Deuxième',
          'human',
          { review: 'reviewed' },
        ),
      ]),
    );
    tracked.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: [
        'local alpha = Text.tr("Alpha")',
        'local beta = Text.tr("Beta")',
        'return beta .. alpha',
        '',
      ].join('\n'),
    };

    const plan = planLocalizationReconciliation(tracked, 'workspace:one');
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toMatchObject({ requiresDecision: false, defaultResolution: 'new' });
    expect(plan.groups[0]!.currentOccurrences).toHaveLength(2);
    expect(plan.groups[0]!.previousOccurrences).toHaveLength(2);

    const applied = applyLocalizationReconciliation(tracked, plan, {});

    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') return;
    expect(applied.materializedMessageIds).toHaveLength(2);
    expect(applied.orphanedMessageIds).toEqual(messageIds);
    expect(Object.keys(applied.project.localization.orphanedMessages).sort()).toEqual(messageIds);
    expect(applied.project.localization.translations.fr).toBeUndefined();
  });

  it('garbage-collects disappeared tracking that has no translations or guidance', () => {
    const project = createAuthoringProject({ id: 'garbage-collect', name: 'Garbage Collect' });
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: 'return Text.tr("Temporary")\n',
    };
    const tracked = synchronizeLocalizationMessageTracking(project).project;
    const [messageId] = Object.values(tracked.localization.sourceMessageTracking).flatMap((entry) =>
      entry.occurrences.map((occurrence) => occurrence.messageId),
    );
    tracked.scripts.bootstrap!.data.source = { kind: 'inline-lua', source: 'return nil\n' };

    const plan = planLocalizationReconciliation(tracked, 'workspace:one');
    const applied = applyLocalizationReconciliation(tracked, plan, {});

    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') return;
    expect(applied.garbageCollectedMessageIds).toEqual([messageId]);
    expect(applied.project.localization.sourceMessageTracking).toEqual({});
    expect(applied.project.localization.orphanedMessages).toEqual({});
  });

  it('rejects a stale plan instead of applying it to changed tracking state', () => {
    const { project } = duplicatedLuaProject();
    const plan = planLocalizationReconciliation(project, 'workspace:one');
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: 'return Text.tr("Changed again")\n',
    };

    const applied = applyLocalizationReconciliation(project, plan, {});

    expect(applied.status).toBe('stale');
  });
});
