import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const OUTPUT_PUBLICATION_TRANSACTION_FORMAT = 'noveltea.output-publication-transaction';

export interface OutputPublicationEntry {
  finalPath: string;
  stagedPath: string | null;
  backupPath: string;
  hadPrevious: boolean;
}

interface OutputPublicationTransactionRecord {
  format: typeof OUTPUT_PUBLICATION_TRANSACTION_FORMAT;
  version: 1;
  state: 'prepared' | 'accepted';
  entries: OutputPublicationEntry[];
}

async function removePath(value: string) {
  await fs.rm(value, { recursive: true, force: true });
}

async function exists(value: string) {
  return fs.lstat(value).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
}

async function writeRecord(transactionPath: string, record: OutputPublicationTransactionRecord) {
  const temporary = `${transactionPath}.write-${process.pid}-${randomUUID()}`;
  await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
  await fs.rename(temporary, transactionPath);
}

export async function rollbackOutputPublicationTransaction(
  transactionPath: string,
  record: OutputPublicationTransactionRecord,
) {
  for (const entry of [...record.entries].reverse()) {
    const backupExists = await exists(entry.backupPath);
    if (entry.hadPrevious) {
      if (backupExists) {
        await removePath(entry.finalPath);
        await fs.rename(entry.backupPath, entry.finalPath);
      }
    } else {
      await removePath(entry.finalPath);
    }
    if (entry.stagedPath) await removePath(entry.stagedPath);
  }
  await removePath(transactionPath);
}

export async function finalizeOutputPublicationTransaction(
  transactionPath: string,
  record: OutputPublicationTransactionRecord,
) {
  for (const entry of record.entries) {
    await removePath(entry.backupPath);
    if (entry.stagedPath) await removePath(entry.stagedPath);
  }
  await removePath(transactionPath);
}

export async function recoverOutputPublicationTransaction(
  transactionPath: string,
): Promise<boolean> {
  let parsed: OutputPublicationTransactionRecord;
  try {
    parsed = JSON.parse(
      await fs.readFile(transactionPath, 'utf8'),
    ) as OutputPublicationTransactionRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (
    parsed.format !== OUTPUT_PUBLICATION_TRANSACTION_FORMAT ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.entries) ||
    (parsed.state !== 'prepared' && parsed.state !== 'accepted')
  )
    throw new Error(`Invalid output publication transaction '${transactionPath}'.`);
  if (parsed.state === 'accepted')
    await finalizeOutputPublicationTransaction(transactionPath, parsed);
  else await rollbackOutputPublicationTransaction(transactionPath, parsed);
  return true;
}

export async function commitOutputPublicationTransaction(options: {
  transactionPath: string;
  entries: OutputPublicationEntry[];
  registerRecoveryPath?: (path: string) => Promise<void>;
  beforeStep?: (step: string, index: number) => Promise<void> | void;
}) {
  const record = await prepareOutputPublicationTransaction(options);
  try {
    for (let index = 0; index < record.entries.length; index += 1) {
      const entry = record.entries[index]!;
      await options.beforeStep?.('backup', index);
      if (entry.hadPrevious) await fs.rename(entry.finalPath, entry.backupPath);
    }
    for (let index = 0; index < record.entries.length; index += 1) {
      const entry = record.entries[index]!;
      await options.beforeStep?.('activate', index);
      if (entry.stagedPath) await fs.rename(entry.stagedPath, entry.finalPath);
    }
    await options.beforeStep?.('accept', record.entries.length);
    record.state = 'accepted';
    await writeRecord(options.transactionPath, record);
    await finalizeOutputPublicationTransaction(options.transactionPath, record);
  } catch (error) {
    await rollbackOutputPublicationTransaction(options.transactionPath, record).catch(
      () => undefined,
    );
    throw error;
  }
}

export async function prepareOutputPublicationTransaction(options: {
  transactionPath: string;
  entries: OutputPublicationEntry[];
  registerRecoveryPath?: (path: string) => Promise<void>;
}) {
  await recoverOutputPublicationTransaction(options.transactionPath);
  if (options.registerRecoveryPath) await options.registerRecoveryPath(options.transactionPath);
  await fs.mkdir(path.dirname(options.transactionPath), { recursive: true });
  const record: OutputPublicationTransactionRecord = {
    format: OUTPUT_PUBLICATION_TRANSACTION_FORMAT,
    version: 1,
    state: 'prepared',
    entries: options.entries,
  };
  await writeRecord(options.transactionPath, record);
  return record;
}
