import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { verifyWebLicensePreloadEvidence } from './web-license-preload-evidence.mjs';

const sha = 'a'.repeat(64);
const otherSha = 'b'.repeat(64);
const item = {
  label: 'threaded-root',
  basePath: '/',
  engineCatalog: 'assets/system/licenses/index.json',
  engineCatalogSha256: otherSha,
  notices: [{ path: 'licenses/test--license.txt', size: 5, sha256: sha }],
};
const proof = () => ({
  status: 'verified',
  indexSha256: otherSha,
  mountedIndexSha256: otherSha,
  notices: [...item.notices],
  mountedNotices: [...item.notices],
});
const http = () => [
  { case: item.label, path: '/assets/system/licenses/index.json', status: 200, sha256: otherSha },
  { case: item.label, path: '/assets/system/licenses/test--license.txt', status: 200, sha256: sha },
];

test('duplicate service-worker precache fetches do not invalidate successful player staging', () => {
  const records = [...http(), ...http()];
  const evidence = verifyWebLicensePreloadEvidence(item, proof(), records);
  assert.equal(evidence.engineNoticeMountedCount, 1);
  assert.deepEqual(evidence.httpObservations.map((entry) => entry.serverRequests), [2, 2]);
});

test('an offline cached preload may succeed without server requests', () => {
  const evidence = verifyWebLicensePreloadEvidence(item, proof(), []);
  assert.equal(evidence.status, 'verified');
  assert.deepEqual(evidence.httpObservations.map((entry) => entry.serverRequests), [0, 0]);
});

test('HTTP success, including from SW precaching, cannot replace player-side evidence', () => {
  assert.throws(() => verifyWebLicensePreloadEvidence(item, { status: 'failed' }, http()),
    /license preload did not complete/);
  assert.throws(() => verifyWebLicensePreloadEvidence(item, null, http()),
    /license preload did not complete/);
  const bad = proof();
  bad.mountedNotices = [{ ...item.notices[0], sha256: otherSha }];
  assert.throws(() => verifyWebLicensePreloadEvidence(item, bad, http()),
    /filesystem does not contain verified notice/);
});

test('rejects partial, duplicate, and wrong-index player evidence', () => {
  assert.throws(() => verifyWebLicensePreloadEvidence(item, { ...proof(), notices: [] }, http()),
    /incomplete player-side license evidence/);
  assert.throws(() => verifyWebLicensePreloadEvidence(item, {
    ...proof(), mountedNotices: [...item.notices, ...item.notices],
  }, http()), /incomplete player-side license evidence/);
  assert.throws(() => verifyWebLicensePreloadEvidence(item, {
    ...proof(), mountedIndexSha256: sha,
  }, http()), /did not mount the verified engine notice index/);
});
