import { readFileSync } from 'node:fs';
import { runNovelTeaCli } from '../src/cli/application';

function readStdinText(): string {
  return readFileSync(0, 'utf8');
}

const result = await runNovelTeaCli(process.argv.slice(2), { readStdinText });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
