import path from 'node:path';
import type { InstalledTemplate } from '../shared/project-schema/platform-export-contracts';
import { CliCommandUsageError } from './commands/errors';
import { cliDiagnostic } from './contracts';
import { parsePlatformOptions, parsePlatformTemplateToken } from './platform-command-helpers';
import type { NovelTeaCliPlatformToolService } from './platform-tool-service';
import type { CliSemanticResult } from './semantic-project';

function externalToken(template: InstalledTemplate): string {
  return `${template.descriptor.templateId}@${template.descriptor.buildId}`;
}

function templateFields(template: InstalledTemplate) {
  return {
    id: externalToken(template),
    templateId: template.descriptor.templateId,
    buildId: template.descriptor.buildId,
    target: template.descriptor.platform,
    architecture: template.descriptor.architecture,
    buildFlavor: template.descriptor.buildFlavor,
    trust: template.entry.trust,
    status: template.status,
  };
}

export async function runProjectIndependentPlatformCommand(
  options: Readonly<{
    command: readonly string[];
    projectOption?: string;
    cwd: string;
    platformTools: NovelTeaCliPlatformToolService;
  }>,
): Promise<CliSemanticResult | null> {
  if (options.command[0] !== 'platform') return null;
  const family = options.command[1];
  if (family !== 'template' && family !== 'config') return null;
  if (options.projectOption)
    throw new CliCommandUsageError(
      `Global option '--project' is not supported by project-independent platform commands.`,
    );

  if (family === 'template') {
    const operation = options.command[2];
    const arguments_ = options.command.slice(3);
    if (operation === 'list') {
      if (arguments_.length > 0)
        throw new CliCommandUsageError('platform template list does not accept arguments.');
      const templates = (await options.platformTools.listTemplates()).map(templateFields);
      const humanSuccess =
        templates.length === 0
          ? 'No player templates are installed.'
          : templates
              .map(
                (item) =>
                  `${item.id}  ${item.target}/${item.architecture}  ${item.buildFlavor}  ${item.status}`,
              )
              .join('\n');
      return { ok: true, diagnostics: [], fields: { templates }, humanSuccess };
    }
    if (operation === 'inspect') {
      if (arguments_.length !== 1)
        throw new CliCommandUsageError('Usage: noveltea platform template inspect <id>@<build>.');
      const token = arguments_[0]!;
      parsePlatformTemplateToken(token);
      const template = await options.platformTools.inspectTemplate(token);
      if (!template)
        return {
          ok: false,
          diagnostics: [
            cliDiagnostic(
              'platform.template_missing',
              '/template',
              `Template '${token}' is not installed.`,
            ),
          ],
        };
      const fields = templateFields(template);
      return {
        ok: true,
        diagnostics: [],
        fields: { template: fields },
        humanSuccess: `${fields.id}  ${fields.status}`,
      };
    }
    if (operation === 'install') {
      if (arguments_.length < 1 || arguments_.length > 2)
        throw new CliCommandUsageError(
          'Usage: noveltea platform template install <archive> [--force].',
        );
      const archive = arguments_[0]!;
      const parsed = parsePlatformOptions(arguments_.slice(1), [], ['--force']);
      const result = await options.platformTools.installTemplate(
        path.resolve(options.cwd, archive),
        parsed.flags.has('--force'),
      );
      const diagnostics = result.diagnostics.map((item) =>
        cliDiagnostic(item.code, item.path, item.message),
      );
      if (!result.success || !result.entry) return { ok: false, diagnostics };
      const id = `${result.entry.templateId}@${result.entry.buildId}`;
      return {
        ok: true,
        diagnostics,
        fields: { id, entry: result.entry },
        humanSuccess: `Installed ${id}.`,
      };
    }
    if (operation === 'remove') {
      if (arguments_.length !== 2 || arguments_[1] !== '--force')
        throw new CliCommandUsageError(
          'Usage: noveltea platform template remove <id>@<build> --force.',
        );
      const token = arguments_[0]!;
      parsePlatformTemplateToken(token);
      const result = await options.platformTools.removeTemplate(token);
      if (!result.removed)
        return {
          ok: false,
          diagnostics: [
            cliDiagnostic(
              'platform.template_missing',
              '/template',
              `Template '${token}' is not installed.`,
            ),
          ],
        };
      return {
        ok: true,
        diagnostics: [],
        fields: { id: token, removed: true },
        humanSuccess: `Removed ${token}.`,
      };
    }
    throw new CliCommandUsageError(`Unknown platform template command '${operation ?? ''}'.`);
  }

  if (options.command[2] !== 'init')
    throw new CliCommandUsageError(
      `Unknown platform config command '${options.command[2] ?? ''}'.`,
    );
  const arguments_ = options.command.slice(3);
  if (arguments_.length < 1 || arguments_.length > 2)
    throw new CliCommandUsageError('Usage: noveltea platform config init <path> [--force].');
  const destination = path.resolve(options.cwd, arguments_[0]!);
  const parsed = parsePlatformOptions(arguments_.slice(1), [], ['--force']);
  const config = await options.platformTools.initializeConfig(
    destination,
    parsed.flags.has('--force'),
  );
  return {
    ok: true,
    diagnostics: [],
    fields: { path: destination, config },
    humanSuccess: `Created ${destination}.`,
  };
}
