import {
  localizationMessageWorkflowViews,
  localizationTargetWorkflowView,
} from '../../shared/authoring-localization-workflow';
import { namedMessageUsages } from '../../shared/authoring-named-message-usages';
import {
  findAuthoringDependencyUsages,
  localizationMessageNodeKey,
} from '../../shared/authoring-dependency-graph';
import { cloneAuthoringProject } from '../../shared/project-schema/authoring-project';
import { projectWorkspaceChangedLocalizationFiles } from '../../shared/project-workspace/project-workspace-service';
import { cliDiagnostic } from '../contracts';
import type { CliCommandDefinition, CliCommandContext } from './types';
import { CliCommandUsageError, parseCommandFlags } from './types';

const viewStatuses = new Set([
  'missing',
  'current',
  'outdated',
  'needs-review',
  'reviewed',
  'human',
  'ai',
  'imported',
  'unknown',
  'attention',
]);

function targetPath(locale: string, messageId: string): string {
  const escape = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');
  return `/localization/translations/${escape(locale)}/${escape(messageId)}`;
}

function requireTargetLocale(context: CliCommandContext, locale: string): void {
  if (locale === context.snapshot.project.localization.sourceLocale)
    throw new CliCommandUsageError('Source locale is not a target translation locale.');
  if (!Object.hasOwn(context.snapshot.project.localization.locales, locale))
    throw new CliCommandUsageError(`Unknown localization locale '${locale}'.`);
}

function parseView(arguments_: readonly string[]) {
  let locale: string | null = null;
  let status: string | null = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index]!;
    if (value === '--status') {
      const next = arguments_[++index];
      if (!next) throw new CliCommandUsageError('--status requires a value.');
      if (!viewStatuses.has(next))
        throw new CliCommandUsageError(`Unknown localization status filter '${next}'.`);
      status = next;
      continue;
    }
    if (value.startsWith('--'))
      throw new CliCommandUsageError(`Unknown command option '${value}'.`);
    if (locale !== null)
      throw new CliCommandUsageError('localization view accepts one target locale.');
    locale = value;
  }
  if (!locale) throw new CliCommandUsageError('localization view requires a target locale.');
  return { locale, status };
}

function matchesStatus(
  status: string | null,
  view: ReturnType<typeof localizationTargetWorkflowView>,
): boolean {
  if (!status) return true;
  if (status === view.freshness) return true;
  if (status === 'attention') return view.attention.length > 0;
  if (!view.translation) return false;
  return status === view.translation.review || status === view.translation.origin;
}

export const localizationViewCommand: CliCommandDefinition = {
  path: ['localization', 'view'],
  parse(arguments_) {
    const { locale, status } = parseView(arguments_);
    return {
      dryRun: true,
      mutation: false,
      async run(context) {
        requireTargetLocale(context, locale);
        const project = context.snapshot.project;
        const graph = await context.workspace.buildDependencyGraphWithSources(context.snapshot);
        const messages = localizationMessageWorkflowViews(project)
          .map((message) => localizationTargetWorkflowView(project, locale, message))
          .filter((message) => matchesStatus(status, message))
          .map((message) => ({
            id: message.id,
            kind: message.kind,
            ...(message.key === undefined ? {} : { key: message.key }),
            source: message.source,
            ...(message.context === undefined ? {} : { context: message.context }),
            ...(message.translatorNote === undefined
              ? {}
              : { translatorNote: message.translatorNote }),
            ...(message.usageNote === null ? {} : { usageNote: message.usageNote }),
            usageNotes:
              message.kind === 'named'
                ? namedMessageUsages(project, message.id).flatMap((usage) => {
                    const note = project.localization.usageNotes[usage.id];
                    return note === undefined
                      ? []
                      : [{ usageId: usage.id, path: usage.path, note }];
                  })
                : message.usageNote === null
                  ? []
                  : [
                      {
                        usageId: message.id,
                        path: message.usedIn ?? message.sourcePath ?? '',
                        note: message.usageNote,
                      },
                    ],
            sourceFingerprint: message.sourceFingerprint,
            status: message.freshness,
            attention: message.attention,
            usages: [
              message.usedIn,
              ...Object.keys(project.localization.locales).flatMap((candidateLocale) =>
                findAuthoringDependencyUsages(
                  graph,
                  localizationMessageNodeKey(candidateLocale, message.id),
                ).map((edge) => edge.sourcePath),
              ),
            ]
              .filter(
                (value, index, values): value is string =>
                  value !== null && values.indexOf(value) === index,
              )
              .sort((left, right) => left.localeCompare(right)),
            target: message.translation,
          }));
        return {
          ok: true,
          diagnostics: [],
          fields: { locale, ...(status ? { statusFilter: status } : {}), messages },
          humanSuccess: `Localization view for ${locale}: ${messages.length} Message(s).`,
        };
      },
    };
  },
};

function parseMutation(
  command: 'accept' | 'review',
  arguments_: readonly string[],
): { locale: string; messageIds: readonly string[]; dryRun: boolean } {
  const parsed = parseCommandFlags(arguments_, ['--dry-run']);
  const [locale, ...messageIds] = parsed.positionals;
  if (!locale || messageIds.length === 0)
    throw new CliCommandUsageError(
      `localization ${command} requires a target locale and at least one Message ID.`,
    );
  return { locale, messageIds, dryRun: parsed.flags.has('--dry-run') };
}

function workflowMutationCommand(command: 'accept' | 'review'): CliCommandDefinition {
  return {
    path: ['localization', command],
    parse(arguments_) {
      const parsed = parseMutation(command, arguments_);
      return {
        dryRun: parsed.dryRun,
        mutation: !parsed.dryRun,
        async run(context) {
          requireTargetLocale(context, parsed.locale);
          const project = context.snapshot.project;
          const views = new Map(
            localizationMessageWorkflowViews(project).map((view) => [view.id, view]),
          );
          const patches: Array<{ messageId: string; path: string; value: string }> = [];
          const diagnostics = [];
          const validationDiagnostics =
            command === 'review'
              ? context.workspace.publishCompiledArtifact(context.snapshot).diagnostics
              : [];
          for (const messageId of parsed.messageIds) {
            const view = views.get(messageId);
            const translation = project.localization.translations[parsed.locale]?.[messageId];
            const path = targetPath(parsed.locale, messageId);
            if (!view || !translation) {
              diagnostics.push(
                cliDiagnostic(
                  'localization.workflow.missing',
                  path,
                  `Message '${messageId}' has no target translation for '${parsed.locale}'.`,
                ),
              );
              continue;
            }
            if (command === 'review') {
              if (translation.sourceFingerprint !== view.sourceFingerprint) {
                diagnostics.push(
                  cliDiagnostic(
                    'localization.review.outdated',
                    path,
                    `Message '${messageId}' is Outdated and cannot be reviewed.`,
                  ),
                );
                continue;
              }
              if (validationDiagnostics.some((item) => item.jsonPointer.startsWith(path))) {
                diagnostics.push(
                  cliDiagnostic(
                    'localization.review.invalid',
                    path,
                    `Message '${messageId}' has validation errors and cannot be reviewed.`,
                  ),
                );
                continue;
              }
              patches.push({ messageId, path: `${path}/review`, value: 'reviewed' });
            } else
              patches.push({
                messageId,
                path: `${path}/sourceFingerprint`,
                value: view.sourceFingerprint,
              });
          }
          if (diagnostics.some((item) => item.severity === 'error'))
            return {
              ok: false,
              diagnostics,
              fields: { locale: parsed.locale, messageIds: parsed.messageIds },
            };

          const candidate = cloneAuthoringProject(project);
          for (const patch of patches) {
            const translation =
              candidate.localization.translations[parsed.locale]?.[patch.messageId];
            if (!translation) continue;
            if (command === 'review') translation.review = 'reviewed';
            else translation.sourceFingerprint = patch.value;
          }
          const localizationFiles = projectWorkspaceChangedLocalizationFiles(
            project.localization,
            candidate.localization,
          );
          if (!parsed.dryRun && patches.length > 0)
            await context.workspace.write(
              context.snapshot.projectRoot,
              context.snapshot.workspaceRevision,
              candidate,
              candidate.editor,
              context.snapshot.scriptSourcePaths,
              {
                operationLabel: `cli localization ${command}`,
                targetFiles: localizationFiles,
                affectedPaths: ['/localization'],
                refreshAfterCommit: false,
              },
            );
          return {
            ok: true,
            diagnostics: [],
            fields: {
              locale: parsed.locale,
              messageIds: parsed.messageIds,
              dryRun: parsed.dryRun,
              writes: !parsed.dryRun && patches.length > 0 ? localizationFiles : [],
            },
            humanSuccess: `Localization ${command} updated ${patches.length} Message(s).`,
          };
        },
      };
    },
  };
}

export const localizationAcceptCommand = workflowMutationCommand('accept');
export const localizationReviewCommand = workflowMutationCommand('review');
