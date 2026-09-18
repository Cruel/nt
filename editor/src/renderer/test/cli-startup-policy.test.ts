// @vitest-environment node

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rolldown } from 'vite/rolldown';
import { describe, expect, it } from 'vite-plus/test';
import { cliStartupPolicy } from '../../../scripts/cli-startup-policy';

async function bundleFixture(files: Record<string, string>, maxBytes?: number): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-startup-policy-'));
  try {
    for (const [name, source] of Object.entries(files))
      await writeFile(path.join(root, name), source);
    const entry = path.join(root, 'entry.js');
    const build = await rolldown({
      input: [entry, ...(files['other.js'] ? [path.join(root, 'other.js')] : [])],
      external: ['sharp', 'node:fs'],
      plugins: [cliStartupPolicy('Fixture CLI', entry, maxBytes)],
    });
    try {
      await build.generate({ format: 'esm', minify: true });
    } finally {
      await build.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('CLI startup bundle policy', () => {
  it('allows built-ins and defers dynamic heavy dependencies', async () => {
    await expect(
      bundleFixture({
        'entry.js': 'import "node:fs";export const load=()=>import("./authoring-heavy.js");',
        'authoring-heavy.js': 'export {default} from "sharp";',
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects external dependencies reached through compact static re-exports', async () => {
    await expect(
      bundleFixture({
        'entry.js': 'import "node:fs";export {default} from "./bridge.js";',
        'bridge.js': 'export {default} from "sharp";',
      }),
    ).rejects.toThrow('eagerly imports external dependency: sharp');
  });

  it('identifies heavy source modules even when merged into the entry', async () => {
    await expect(
      bundleFixture({
        'entry.js': 'export {value} from "./authoring-heavy.js";',
        'authoring-heavy.js': 'export const value=42;',
      }),
    ).rejects.toThrow('eagerly includes heavy modules');
  });

  it('follows shared startup chunks to external imports', async () => {
    await expect(
      bundleFixture({
        'entry.js': 'export {value} from "./shared.js";',
        'other.js': 'export {value} from "./shared.js";',
        'shared.js': 'import sharp from "sharp";export const value=sharp();',
      }),
    ).rejects.toThrow('eagerly imports external dependency: sharp');
  });

  it('includes shared chunk bytes in the startup budget', async () => {
    await expect(
      bundleFixture(
        {
          'entry.js': 'export {value} from "./shared.js";',
          'other.js': 'export {value} from "./shared.js";',
          'shared.js': `export const value=${JSON.stringify('x'.repeat(1024))};`,
        },
        512,
      ),
    ).rejects.toThrow('static startup closure grew');
  });
});
