import { cliDiagnostic } from './contracts';
import type { CliSemanticResult } from './command-result-contract';
import type { CliCommandContext } from './commands/types';

export async function removeFileIfPresent(
  context: Pick<CliCommandContext, 'fileSystem'>,
  value: string,
): Promise<void> {
  const kind = context.fileSystem.readPathMetadata
    ? (await context.fileSystem.readPathMetadata(value)).kind
    : await context.fileSystem.inspect(value).catch(() => 'missing' as const);
  if (kind === 'file') await context.fileSystem.removeFile(value);
}

export async function publishStagedPackage(
  context: Pick<CliCommandContext, 'fileSystem' | 'nativeTools'>,
  stagedPath: string,
  outputPath: string,
): Promise<CliSemanticResult | null> {
  const target = context.fileSystem.readPathMetadata
    ? await context.fileSystem.readPathMetadata(outputPath)
    : { kind: await context.fileSystem.inspect(outputPath).catch(() => 'missing' as const) };
  if (target.kind !== 'missing' && target.kind !== 'file')
    return {
      ok: false,
      diagnostics: [
        cliDiagnostic(
          'export.output_invalid',
          '/output',
          `Runtime Package output '${outputPath}' is not a replaceable regular file.`,
        ),
      ],
    };
  const transactionPath = `${outputPath}.noveltea-publication-transaction.json`;
  const backupPath = `${outputPath}.noveltea-publication-backup`;
  const record = {
    format: 'noveltea.output-publication-transaction',
    version: 1,
    state: 'prepared' as 'prepared' | 'accepted',
    entries: [
      {
        finalPath: outputPath,
        stagedPath,
        backupPath,
        hadPrevious: target.kind === 'file',
      },
    ],
  };
  const recover = async () => {
    const transactionKind = await context.fileSystem
      .inspect(transactionPath)
      .catch(() => 'missing');
    if (transactionKind !== 'file') return;
    let parsed: typeof record;
    try {
      parsed = JSON.parse(await context.fileSystem.readText(transactionPath)) as typeof record;
    } catch {
      await removeFileIfPresent(context, transactionPath).catch(() => undefined);
      return;
    }
    const entry = parsed.entries[0];
    if (!entry) return;
    const backupKind = await context.fileSystem.inspect(entry.backupPath).catch(() => 'missing');
    if (parsed.state === 'accepted') {
      if (backupKind === 'file') await context.fileSystem.removeFile(entry.backupPath);
      await removeFileIfPresent(context, entry.stagedPath).catch(() => undefined);
    } else if (entry.hadPrevious) {
      if (backupKind === 'file') {
        await removeFileIfPresent(context, entry.finalPath).catch(() => undefined);
        await context.fileSystem.movePathAtomic(entry.backupPath, entry.finalPath);
      }
      await removeFileIfPresent(context, entry.stagedPath).catch(() => undefined);
    } else {
      await removeFileIfPresent(context, entry.finalPath).catch(() => undefined);
      await removeFileIfPresent(context, entry.stagedPath).catch(() => undefined);
    }
    await removeFileIfPresent(context, transactionPath).catch(() => undefined);
  };
  try {
    await recover();
    await context.nativeTools.registerStagedOutput?.(transactionPath);
    await context.fileSystem.writeTextAtomic(transactionPath, `${JSON.stringify(record)}\n`);
    if (record.entries[0]!.hadPrevious)
      await context.fileSystem.movePathAtomic(outputPath, backupPath);
    await context.fileSystem.movePathAtomic(stagedPath, outputPath);
    record.state = 'accepted';
    await context.fileSystem.writeTextAtomic(transactionPath, `${JSON.stringify(record)}\n`);
    await recover();
    return null;
  } catch (error) {
    await recover().catch(() => undefined);
    return {
      ok: false,
      diagnostics: [
        cliDiagnostic(
          'export.publish_failed',
          '/output',
          error instanceof Error ? error.message : 'Runtime Package publication failed.',
        ),
      ],
    };
  }
}
