import { createRequire } from 'node:module';
import path from 'node:path';

const appRoot = process.argv[2];
if (!appRoot) throw new Error('Usage: node verify-staged-node-pty.mjs <app-root>');

const appRequire = createRequire(path.join(path.resolve(appRoot), 'package.json'));
const nodePty = appRequire('node-pty');
if (!nodePty || typeof nodePty.spawn !== 'function') {
  throw new Error('The staged node-pty module does not expose spawn().');
}

process.stdout.write('Staged node-pty native module loaded successfully.\n');
