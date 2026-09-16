import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  FEATURE_LAB_MANIFEST_RELATIVE_PATH,
  validateFeatureLabManifest,
} from '../../tools/feature-lab/validate.mjs';

const root = process.cwd();
const projectRoot = path.join(root, 'tests', 'projects', 'feature-lab');
const manifestPath = path.join(projectRoot, FEATURE_LAB_MANIFEST_RELATIVE_PATH);

async function manifest() {
  return JSON.parse(await readFile(manifestPath, 'utf8'));
}

test('canonical Feature Lab manifest satisfies the project-specific contract', async () => {
  const catalog = await manifest();
  const result = await validateFeatureLabManifest(catalog, { projectRoot });
  assert.deepEqual(result.errors, []);
  assert.equal(catalog.schema, 'noveltea.feature-lab.catalog');
  assert.equal(Object.hasOwn(catalog, 'schemaVersion'), false);
  assert.equal(catalog.scenarios[0].id, 'rooms-interactions');
});

test('validator rejects duplicate IDs, broken references, invalid statuses, and non-UTC timestamps', async () => {
  const catalog = await manifest();
  const broken = structuredClone(catalog);
  broken.categories.push({ ...broken.categories[0] });
  broken.launches[0].id = 'Invalid ID';
  broken.scenarios[0].categoryId = 'missing-category';
  broken.scenarios[0].status = 'unknown';
  broken.scenarios[0].created = '2026-09-14T12:00:00-05:00';
  broken.scenarios[0].checks[0].created = '2026-09-15T02:00:00Z';
  broken.scenarios[0].checks[0].modified = '2026-09-15T01:00:00Z';
  broken.scenarios[0].checks[0].assetRequirements = ['missing-requirement'];
  broken.scenarios[0].checks[0].automation = [{ kind: 'semantic-test', id: 'missing-test' }];

  const result = await validateFeatureLabManifest(broken, { projectRoot });
  const codes = new Set(result.errors.map((error) => error.code));
  assert(codes.has('duplicate-id'));
  assert(codes.has('invalid-id'));
  assert(codes.has('missing-category'));
  assert(codes.has('invalid-status'));
  assert(codes.has('invalid-timestamp'));
  assert(codes.has('invalid-timestamp-order'));
  assert(codes.has('missing-asset-requirement'));
  assert(codes.has('missing-automation-target'));
});

test('catalog inherits Project versioning and rejects an independent epoch', async () => {
  const catalog = await manifest();
  catalog.schemaVersion = 1;
  const result = await validateFeatureLabManifest(catalog, { projectRoot });
  assert(result.errors.some((error) => error.path === '/schemaVersion'));
});

test('validator rejects impossible calendar dates instead of normalizing them', async () => {
  const catalog = await manifest();
  for (const timestamp of ['2026-02-30T00:00:00Z', '2025-02-29T00:00:00.123Z', '2026-04-31T00:00:00Z', '2026-09-15T24:00:00Z']) {
    const broken = structuredClone(catalog);
    broken.scenarios[0].checks[0].created = timestamp;
    const result = await validateFeatureLabManifest(broken);
    assert(result.errors.some((error) => error.code === 'invalid-timestamp'), timestamp);
  }
  for (const timestamp of ['2024-02-29T00:00:00Z', '2000-02-29T12:34:56.123Z']) {
    const valid = structuredClone(catalog);
    valid.scenarios[0].checks[0].created = timestamp;
    assert.deepEqual((await validateFeatureLabManifest(valid)).errors, []);
  }
});

test('validator rejects malformed reference collections and entries', async () => {
  const catalog = await manifest();
  for (const change of [
    (value) => { value.scenarios[0].checks[0].automation = { kind: 'semantic-test', id: 'missing' }; },
    (value) => { value.scenarios[0].checks[0].assetRequirements = 'missing'; },
    (value) => { value.assetRequirements[0].realizations = {}; },
    (value) => { value.scenarios[0].checks[0].automation = [null]; },
    (value) => { value.assetRequirements[0].realizations = [null]; },
    (value) => { value.scenarios[0].checks = [null]; },
    (value) => { value.scenarios = [null]; },
    (value) => { value.categories = [null]; },
    (value) => { value.launches = [null]; },
    (value) => { value.assetRequirements = [null]; },
    (value) => { value.visualCheckpoints = {}; },
    (value) => { value.visualCheckpoints = [null]; },
  ]) {
    const broken = structuredClone(catalog);
    change(broken);
    const result = await validateFeatureLabManifest(broken, { projectRoot });
    assert(result.errors.length > 0);
  }
});

test('validator resolves declared visual checkpoint references', async () => {
  const catalog = await manifest();
  catalog.visualCheckpoints.push({ id: 'pilot-composition' });
  catalog.scenarios[0].checks[0].automation = [
    { kind: 'visual-checkpoint', id: 'pilot-composition' },
  ];
  let result = await validateFeatureLabManifest(catalog, { projectRoot });
  assert.deepEqual(result.errors, []);

  catalog.scenarios[0].checks[0].automation[0].id = 'missing';
  result = await validateFeatureLabManifest(catalog, { projectRoot });
  assert(result.errors.some((error) => error.code === 'missing-automation-target'));
});

test('timestamp history requires immutable created and meaningful modified changes', async () => {
  const catalog = await manifest();
  const changedWithoutTouch = structuredClone(catalog);
  changedWithoutTouch.scenarios[0].checks[0].expected += ' Changed behavior.';

  let result = await validateFeatureLabManifest(changedWithoutTouch, {
    projectRoot,
    previousManifest: catalog,
  });
  assert(result.errors.some((error) => error.code === 'stale-modified'));

  const changedCreated = structuredClone(catalog);
  changedCreated.scenarios[0].checks[0].created = '2026-09-14T20:00:00Z';
  result = await validateFeatureLabManifest(changedCreated, {
    projectRoot,
    previousManifest: catalog,
  });
  assert(result.errors.some((error) => error.code === 'created-changed'));
});

test('scenario effective modification and asset requirements are derived from child checks', async () => {
  const catalog = await manifest();
  const scenario = catalog.scenarios[0];
  const result = await validateFeatureLabManifest(catalog, { projectRoot });
  const derived = result.derived.scenarios[scenario.id];
  const newest = [scenario.modified, ...scenario.checks.map((check) => check.modified)].reduce(
    (latest, value) => (Date.parse(value) > Date.parse(latest) ? value : latest),
  );
  assert.equal(derived.effectiveModified, newest);
  assert.deepEqual(
    derived.assetRequirements,
    [...new Set(scenario.checks.flatMap((check) => check.assetRequirements ?? []))],
  );
});
