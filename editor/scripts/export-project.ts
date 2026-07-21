import path from 'node:path';
import { parseExportCommandArguments, runExportCommand } from '../src/cli/export-command';
import {
  configureTemplateRegistryRoot,
  installPlayerTemplate,
} from '../src/main/services/template-registry-service';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  const templateIndex = args.indexOf('--template');
  const templateArchive = templateIndex >= 0 ? args[templateIndex + 1] : undefined;
  if (templateIndex >= 0) args.splice(templateIndex, 2);

  const registryRoot = path.resolve(
    process.env.NOVELTEA_TEMPLATE_REGISTRY_ROOT ??
      path.join(process.cwd(), 'build', 'player-template-registry'),
  );
  configureTemplateRegistryRoot(registryRoot);
  if (templateArchive) {
    const installed = await installPlayerTemplate({
      archivePath: path.resolve(templateArchive),
      origin: 'project-export-cli',
    });
    if (!installed.success) {
      process.stderr.write(`${JSON.stringify(installed, null, 2)}\n`);
      process.exitCode = 3;
      return;
    }
  }

  const result = await runExportCommand(parseExportCommandArguments(args));
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 64;
});
