#!/usr/bin/env node

import { readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

function parseArgs(argv) {
  const options = { roots: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--'))
      throw new Error(`Invalid argument near '${key ?? ''}'.`);
    if (key === '--root') options.roots.push(path.resolve(value));
    else options[key.slice(2)] = value;
    index += 1;
  }
  if (!options.readelf) throw new Error('--readelf is required.');
  if (!options.output) throw new Error('--output is required.');
  if (options.roots.length === 0) throw new Error('At least one --root is required.');
  return options;
}

async function files(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...(await files(absolute)));
    else if (entry.isFile() && entry.name.endsWith('.so')) output.push(absolute);
  }
  return output;
}

async function capture(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${command} exited with ${code}: ${stderr}`)),
    );
  });
}

function abiFromPath(file) {
  for (const abi of ['arm64-v8a', 'x86_64']) {
    if (file.split(path.sep).includes(abi)) return abi;
  }
  throw new Error(`Could not infer Android ABI from '${file}'.`);
}

const options = parseArgs(process.argv.slice(2));
const libraries = (await Promise.all(options.roots.map((root) => files(root)))).flat();
if (libraries.length === 0) throw new Error('No Android shared libraries were found.');
const grouped = new Map();
for (const library of libraries) {
  const output = await capture(path.resolve(options.readelf), ['-lW', library]);
  const alignments = output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields[0] === 'LOAD')
    .map((fields) => fields.at(-1));
  if (alignments.length === 0) throw new Error(`No PT_LOAD segments were found in '${library}'.`);
  for (const alignment of alignments) {
    const value = Number.parseInt(alignment, 16);
    if (!Number.isFinite(value) || value < 0x4000)
      throw new Error(`${library} has PT_LOAD alignment ${alignment}; expected at least 0x4000.`);
  }
  const abi = abiFromPath(library);
  const current = grouped.get(abi) ?? { abi, status: 'passed', libraries: [] };
  current.libraries.push({ path: library, alignments });
  grouped.set(abi, current);
}
const results = [...grouped.values()].sort((left, right) => left.abi.localeCompare(right.abi));
const report = {
  format: 'noveltea-android-load-alignment',
  minimumAlignment: '0x4000',
  results,
};
const output = path.resolve(options.output);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
await stat(output);
process.stdout.write(`Verified 16 KiB PT_LOAD alignment for ${libraries.length} Android libraries.\n`);
