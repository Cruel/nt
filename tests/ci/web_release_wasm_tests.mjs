import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const auditScript = path.join(root, 'scripts/check-web-release-wasm.mjs');
const wasmHeader = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function varUint32(value) {
  const bytes = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return Buffer.from(bytes);
}

function customSection(name, payload = Buffer.alloc(0)) {
  const nameBytes = Buffer.from(name, 'utf8');
  const body = Buffer.concat([varUint32(nameBytes.length), nameBytes, payload]);
  return Buffer.concat([Buffer.from([0]), varUint32(body.length), body]);
}

function wasm(...sections) {
  return Buffer.concat([wasmHeader, ...sections]);
}

function runAudit(t, bytes, dwarf = Buffer.from('debug')) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'noveltea-web-wasm-audit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const wasmPath = path.join(directory, 'player.wasm');
  const dwarfPath = path.join(directory, 'player.wasm.debug.wasm');
  writeFileSync(wasmPath, bytes);
  writeFileSync(dwarfPath, dwarf);
  return spawnSync(process.execPath, [auditScript, wasmPath, dwarfPath], { encoding: 'utf8' });
}

test('release Wasm audit accepts a stripped module with external DWARF metadata', (t) => {
  const result = runAudit(t, wasm(customSection('external_debug_info')));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Web release player audit passed/);
});

test('release Wasm audit rejects embedded names, missing DWARF references, and empty DWARF', (t) => {
  const named = runAudit(
    t,
    wasm(customSection('external_debug_info'), customSection('name', Buffer.from('symbols'))),
  );
  assert.notEqual(named.status, 0);
  assert.match(named.stderr, /WebAssembly name section/);

  const missingReference = runAudit(t, wasm(customSection('producers')));
  assert.notEqual(missingReference.status, 0);
  assert.match(missingReference.stderr, /does not reference its separate DWARF artifact/);

  const emptyDwarf = runAudit(t, wasm(customSection('external_debug_info')), Buffer.alloc(0));
  assert.notEqual(emptyDwarf.status, 0);
  assert.match(emptyDwarf.stderr, /Separate DWARF artifact is empty/);
});

test('release Wasm audit rejects malformed sections and runtime Wasm above the size guard', (t) => {
  const malformed = runAudit(t, Buffer.concat([wasmHeader, Buffer.from([0, 8, 1, 0x61])]));
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /section extends past end of file/);

  const oversized = runAudit(
    t,
    wasm(
      customSection('external_debug_info'),
      customSection('padding', Buffer.alloc(25 * 1024 * 1024)),
    ),
  );
  assert.notEqual(oversized.status, 0);
  assert.match(oversized.stderr, /above the 26214400 byte size guard/);
});
