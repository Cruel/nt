import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const [target, marker] = process.argv.slice(2);
if (!target || !marker) throw new Error('target and marker are required');

await fs.mkdir(path.dirname(target), { recursive: true });
const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
await fs.writeFile(temporary, marker);
let status = 'generated';
try {
  await fs.link(temporary, target);
} catch (error) {
  if (error?.code !== 'EEXIST') throw error;
  status = 'hit';
} finally {
  await fs.rm(temporary, { force: true });
}
const bytes = await fs.readFile(target, 'utf8');
process.stdout.write(JSON.stringify({ status, bytes }));
