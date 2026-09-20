import {
  applyLocalizationReconciliation,
  planLocalizationReconciliation,
  type LocalizationReconciliationDecisions,
  type LocalizationReconciliationPlan,
} from '../../shared/authoring-localization-reconcile';
import { projectWorkspaceChangedLocalizationFiles } from '../../shared/project-workspace/project-workspace-service';
import { cliDiagnostic } from '../contracts';
import type { CliCommandDefinition } from './types';
import { CliCommandUsageError, parseCommandFlags } from './types';

interface ReconcileApplyInput {
  readonly expectedWorkspaceRevision: string;
  readonly expectedFingerprint: string;
  readonly resolutions: LocalizationReconciliationDecisions;
}

function parseApplyInput(value: unknown): ReconcileApplyInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.expectedWorkspaceRevision !== 'string' ||
    typeof record.expectedFingerprint !== 'string' ||
    !record.resolutions ||
    typeof record.resolutions !== 'object' ||
    Array.isArray(record.resolutions)
  )
    return null;
  const resolutions: Record<string, string> = {};
  for (const [occurrenceId, resolution] of Object.entries(
    record.resolutions as Record<string, unknown>,
  )) {
    if (typeof resolution !== 'string' || !resolution) return null;
    resolutions[occurrenceId] = resolution;
  }
  return {
    expectedWorkspaceRevision: record.expectedWorkspaceRevision,
    expectedFingerprint: record.expectedFingerprint,
    resolutions,
  };
}

function suppliedPlan(
  input: ReconcileApplyInput,
  current: LocalizationReconciliationPlan,
): LocalizationReconciliationPlan {
  return {
    ...current,
    expectedWorkspaceRevision: input.expectedWorkspaceRevision,
    expectedFingerprint: input.expectedFingerprint,
  };
}

export const localizationReconcileCommand: CliCommandDefinition = {
  path: ['localization', 'reconcile'],
  parse(arguments_) {
    const parsed = parseCommandFlags(arguments_, ['--apply']);
    if (parsed.positionals.length > 0)
      throw new CliCommandUsageError(
        'localization reconcile does not accept positional arguments.',
      );
    const apply = parsed.flags.has('--apply');
    return {
      dryRun: !apply,
      mutation: apply,
      async run(context) {
        const currentPlan = planLocalizationReconciliation(
          context.snapshot.project,
          context.snapshot.workspaceRevision,
          context.snapshot.externalSourceDescriptors,
        );
        if (!apply)
          return {
            ok: true,
            diagnostics: [],
            fields: {
              plan: currentPlan,
              writes: [],
            },
            humanSuccess:
              currentPlan.groups.length === 0
                ? 'Localization reconciliation has no pending work.'
                : `Localization reconciliation found ${currentPlan.groups.length} pending group(s).`,
          };

        const input = parseApplyInput(context.stdinJson);
        if (!input)
          return {
            ok: false,
            diagnostics: [
              cliDiagnostic(
                'localization.reconcile.invalid-input',
                '/stdin',
                'localization reconcile --apply requires one JSON object on stdin with expectedWorkspaceRevision, expectedFingerprint, and resolutions.',
              ),
            ],
            fields: { plan: currentPlan },
          };
        if (input.expectedWorkspaceRevision !== context.snapshot.workspaceRevision)
          return {
            ok: false,
            diagnostics: [
              cliDiagnostic(
                'localization.reconcile.stale-plan',
                '/localization',
                'The reconciliation plan is stale because the Project workspace changed. Recompute the plan before applying it.',
              ),
            ],
            fields: { plan: currentPlan },
          };

        const result = applyLocalizationReconciliation(
          context.snapshot.project,
          suppliedPlan(input, currentPlan),
          input.resolutions,
          context.snapshot.externalSourceDescriptors,
        );
        if (result.status === 'stale')
          return {
            ok: false,
            diagnostics: [
              cliDiagnostic(
                'localization.reconcile.stale-plan',
                '/localization',
                'The reconciliation plan no longer matches current localization source state. Recompute the plan before applying it.',
              ),
            ],
            fields: { plan: result.plan },
          };
        if (result.status === 'needs-decision')
          return {
            ok: false,
            diagnostics: result.occurrenceIds.map((occurrenceId) =>
              cliDiagnostic(
                'localization.reconcile.decision-required',
                '/localization',
                `Reconciliation occurrence '${occurrenceId}' contains valuable prior work and requires an explicit resolution.`,
              ),
            ),
            fields: { plan: result.plan, occurrenceIds: result.occurrenceIds },
          };

        const localizationFiles = projectWorkspaceChangedLocalizationFiles(
          context.snapshot.project.localization,
          result.project.localization,
        );
        if (result.changed)
          await context.workspace.write(
            context.snapshot.projectRoot,
            context.snapshot.workspaceRevision,
            result.project,
            result.project.editor,
            context.snapshot.scriptSourcePaths,
            {
              operationLabel: 'cli localization reconcile',
              targetFiles: localizationFiles,
              affectedPaths: ['/localization'],
              refreshAfterCommit: false,
            },
          );
        return {
          ok: true,
          diagnostics: [],
          fields: {
            relinkedMessageIds: result.relinkedMessageIds,
            materializedMessageIds: result.materializedMessageIds,
            orphanedMessageIds: result.orphanedMessageIds,
            garbageCollectedMessageIds: result.garbageCollectedMessageIds,
            writes: result.changed ? localizationFiles : [],
          },
          humanSuccess: result.changed
            ? 'Localization reconciliation applied.'
            : 'Localization reconciliation is already resolved.',
        };
      },
    };
  },
};
